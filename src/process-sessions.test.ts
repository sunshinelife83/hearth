import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadTailBuffer, ProcessSessionManager } from "./process-sessions.js";

const smallBuffer = new HeadTailBuffer(100);
smallBuffer.append("hello\n");
assert.deepEqual(smallBuffer.drain(100), { output: "hello\n", truncated: false });
assert.deepEqual(smallBuffer.drain(100), { output: "", truncated: false });

const headTail = new HeadTailBuffer(10);
headTail.append("start-middle-end");
const headTailResult = headTail.drain(1_000);
assert.equal(headTailResult.truncated, true);
assert.match(headTailResult.output, /^start/);
assert.match(headTailResult.output, /e-end$/);
assert.match(headTailResult.output, /characters omitted/);

const responseLimited = new HeadTailBuffer(100);
responseLimited.append("abcdef".repeat(20));
const responseLimitedResult = responseLimited.drain(40);
assert.equal(responseLimitedResult.truncated, true);
assert.match(responseLimitedResult.output, /^abc/);
assert.match(responseLimitedResult.output, /def$/);

const unicodeBuffer = new HeadTailBuffer(4);
unicodeBuffer.append("a🙂b🙂c");
const unicodeResult = unicodeBuffer.drain(1_000);
assert.equal(unicodeResult.truncated, true);
assert.match(unicodeResult.output, /^a🙂/);
assert.match(unicodeResult.output, /🙂c$/);

// File-based helper scripts instead of `node -e "..."`: cmd.exe mangles
// inline-quote handling (Node's spawn quotes the whole command for
// `cmd /d /s /c`, so the script arrives with literal backslashes and dies
// with a SyntaxError on Windows). Bare `node <file>` has no shell
// metacharacters and works identically on POSIX and Windows.
const scriptsDir = await mkdtemp(join(tmpdir(), "hearth-process-session-test-"));
await writeFile(join(scriptsDir, "foreground.js"), "console.log('foreground');\n");
await writeFile(join(scriptsDir, "env-probe.js"), "console.log([process.env.NO_COLOR, process.env.TERM, process.env.PAGER, process.env.GIT_PAGER, process.env.GH_PAGER, process.env.CODEX_CI, process.env.HEARTH_WORKSPACE_ID, process.env.HEARTH_WORKSPACE_ROOT].join(','));\n");
await writeFile(join(scriptsDir, "bg-finished.js"), "setTimeout(() => console.log('finished'), 100);\n");
await writeFile(join(scriptsDir, "stdin-echo.js"), "process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); });\n");
await writeFile(join(scriptsDir, "stdin-delayed.js"), "process.stdin.once('data', data => setTimeout(() => { console.log('default-input:' + data.toString().trim()); process.exit(0); }, 100));\n");
await writeFile(join(scriptsDir, "tick-echo.js"), "setInterval(() => console.log('tick'), 10); process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); });\n");
await writeFile(join(scriptsDir, "tick.js"), "setInterval(() => console.log('tick'), 10);\n");
await writeFile(join(scriptsDir, "big-output.js"), "console.log('x'.repeat(5000)); setTimeout(() => {}, 100);\n");
await writeFile(join(scriptsDir, "columns.js"), "setTimeout(() => console.log('columns:' + process.stdout.columns), 250);\n");

const manager = new ProcessSessionManager({
  maxBufferCharacters: 1_024,
  completedSessionTtlMs: 1_000,
});

const foreground = await manager.start({
  workspaceId: "workspace-a",
  cwd: scriptsDir,
  command: "node foreground.js",
  yieldTimeMs: 2_000,
});
assert.equal(foreground.running, false);
assert.equal(foreground.exitCode, 0);
assert.match(foreground.output, /foreground/);
assert.equal(foreground.sessionId, undefined);

const environment = await manager.start({
  workspaceId: "workspace-a",
  workspaceRoot: "/tmp/hearth-workspace-a",
  cwd: scriptsDir,
  command: "node env-probe.js",
  yieldTimeMs: 2_000,
});
assert.equal(environment.running, false);
assert.match(environment.output, /1,dumb,cat,cat,cat,1,workspace-a,\/tmp\/hearth-workspace-a/);

const background = await manager.start({
  workspaceId: "workspace-a",
  cwd: scriptsDir,
  command: "node bg-finished.js",
  yieldTimeMs: 5,
});
assert.equal(background.running, true);
assert.ok(background.sessionId);
assert.equal(typeof background.sessionId, "number");

await assert.rejects(
  manager.write({
    workspaceId: "workspace-b",
    sessionId: background.sessionId,
    yieldTimeMs: 1,
  }),
  /does not belong to workspace/,
);

const completed = await manager.write({
  workspaceId: "workspace-a",
  sessionId: background.sessionId,
  yieldTimeMs: 2_000,
});
assert.equal(completed.running, false);
assert.equal(completed.exitCode, 0);
assert.match(completed.output, /finished/);

const interactive = await manager.start({
  workspaceId: "workspace-a",
  cwd: scriptsDir,
  command: "node stdin-echo.js",
  yieldTimeMs: 5,
});
assert.equal(interactive.running, true);
assert.ok(interactive.sessionId);
assert.equal(typeof interactive.sessionId, "number");

const inputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: interactive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(inputResult.running, false);
assert.match(inputResult.output, /input:hello/);

const defaultInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: scriptsDir,
  command: "node stdin-delayed.js",
  yieldTimeMs: 5,
});
assert.equal(defaultInteractive.running, true);
assert.ok(defaultInteractive.sessionId);

const defaultInputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: defaultInteractive.sessionId,
  chars: "hello\n",
  // Explicit generous yield: the default interactive poll (250ms) plus the
  // child's own 100ms timer plus spawn latency exceeds the budget on loaded
  // machines, leaving the session legitimately still running. Regression test
  // for the parallel-load flake (asserted running===false too early).
  yieldTimeMs: 10_000,
});
assert.equal(defaultInputResult.running, false);
assert.match(defaultInputResult.output, /default-input:hello/);

const noisyInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: scriptsDir,
  command: "node tick-echo.js",
  yieldTimeMs: 100,
});
assert.equal(noisyInteractive.running, true);
assert.ok(noisyInteractive.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const noisyInputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: noisyInteractive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(noisyInputResult.running, false);
assert.match(noisyInputResult.output, /input:hello/);

const interruptible = await manager.start({
  workspaceId: "workspace-a",
  cwd: scriptsDir,
  command: "node tick.js",
  yieldTimeMs: 100,
});
assert.equal(interruptible.running, true);
assert.ok(interruptible.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const interrupted = await manager.write({
  workspaceId: "workspace-a",
  sessionId: interruptible.sessionId,
  chars: "\u0003",
  yieldTimeMs: 2_000,
});
assert.equal(interrupted.running, false);
if (process.platform !== "win32") assert.equal(interrupted.signal, "SIGINT");

let buffered = await manager.start({
  workspaceId: "workspace-a",
  cwd: scriptsDir,
  command: "node big-output.js",
  yieldTimeMs: 50,
  maxOutputTokens: 100,
});
if (!buffered.outputTruncated && buffered.sessionId) {
  buffered = await manager.write({
    workspaceId: "workspace-a",
    sessionId: buffered.sessionId,
    yieldTimeMs: 2_000,
    maxOutputTokens: 100,
  });
}
assert.equal(buffered.outputTruncated, true);
if (buffered.sessionId) manager.terminate("workspace-a", buffered.sessionId);

try {
  if (process.platform === "win32") {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: "echo pty-ok",
      tty: true,
      yieldTimeMs: 10_000,
    });
    assert.equal(pty.running, false);
    assert.match(pty.output, /pty-ok/);
  } else {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: scriptsDir,
      command: "node columns.js",
      tty: true,
      columns: 80,
      rows: 24,
      yieldTimeMs: 10,
    });
    assert.equal(pty.running, true);
    assert.ok(pty.sessionId);

    const resizedPty = await manager.write({
      workspaceId: "workspace-a",
      sessionId: pty.sessionId,
      columns: 120,
      rows: 30,
      yieldTimeMs: 2_000,
    });
    assert.equal(resizedPty.running, false);
    assert.match(resizedPty.output, /columns:120/);
  }
} finally {
  manager.shutdown();
  await rm(scriptsDir, { recursive: true, force: true });
}
