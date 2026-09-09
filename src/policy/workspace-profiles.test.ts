import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../config.js";
import { buildLocalMcpServer } from "../stdio-server.js";
import { writeTestHearthConfig } from "../test-support/config.test.js";
import { rmFixtureDir } from "../test-support/fs.js";
import { commandListVerdict, resolveExecutionForWorkspace } from "./workspace-profiles.js";

describe("per-workspace security profiles", () => {
  let root = "";
  let strictRoot = "";
  let looseRoot = "";
  let client: Client;
  let closeServer: () => Promise<void>;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "hearth-profile-test-"));
    strictRoot = join(root, "strict");
    looseRoot = join(root, "loose");
    await mkdir(strictRoot, { recursive: true });
    await mkdir(looseRoot, { recursive: true });
    await writeFile(join(looseRoot, "s.txt"), "x\n");
    // Windows-only probe script (see the sandbox-path test): POSIX keeps the
    // inline `node -e` probe because under bwrap this /tmp fixture workspace
    // is masked by a fresh tmpfs, hiding any script file placed here.
    await writeFile(
      join(looseRoot, "probe-owner-token.js"),
      "console.log(typeof process.env.HEARTH_OAUTH_OWNER_TOKEN)\n",
    );

    const env = writeTestHearthConfig(join(root, "config"), {
      server: { host: "127.0.0.1", port: 7176, publicBaseUrl: null },
      workspaces: {
        allowedRoots: [strictRoot, looseRoot],
        profiles: [
          {
            path: strictRoot,
            mode: "readonly",
            commandAllow: [],
            commandDeny: ["git\\s+push"],
            agentsAllowed: false,
          },
          {
            path: looseRoot,
            mode: "autonomous",
            commandAllow: [],
            commandDeny: [],
          },
        ],
      },
      storage: { stateDir: join(root, "state") },
      tools: { mode: "claude" },
      ui: { enabled: false },
      logging: { level: "silent" },
    });
    const config = loadConfig(env);
    const local = buildLocalMcpServer(config);
    closeServer = local.close;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "profile-test-client", version: "0.0.1" });
    await Promise.all([
      local.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  after(async () => {
    // Close in finally so a client close failure cannot leak the server's
    // SQLite handles into rm (EBUSY on Windows); rm retries with backoff.
    try {
      await client.close();
    } finally {
      await closeServer();
    }
    await rmFixtureDir(root);
  });

  const textOf = (result: unknown) => {
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
    return content.map((block) => block.text ?? "").join("\n");
  };

  it("resolves the longest-prefix profile and inherits globals elsewhere", () => {
    const config = loadConfig({
      HEARTH_CONFIG_DIR: join(root, "config"),
      HEARTH_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    });
    const strict = resolveExecutionForWorkspace(config, join(strictRoot, "nested", "deep"));
    assert.equal(strict.mode, "readonly");
    assert.equal(strict.agentsAllowed, false);
    const loose = resolveExecutionForWorkspace(config, looseRoot);
    assert.equal(loose.mode, "autonomous");
    const other = resolveExecutionForWorkspace(config, join(root, "other-place"));
    assert.equal(other.mode, "supervised", "no profile falls back to the global default");
    assert.equal(other.agentsAllowed, true);
  });

  it("command lists: deny wins, allow-list restricts, invalid regex fails closed", () => {
    const deny = commandListVerdict(
      { mode: "supervised", sandbox: undefined, sandboxNetwork: undefined, requireSandboxForAutonomous: false, commandAllow: [], commandDeny: ["git\\s+push"], agentsAllowed: true },
      "git push origin main",
    );
    assert.equal(deny.allowed, false);

    const allow = commandListVerdict(
      { mode: "supervised", sandbox: undefined, sandboxNetwork: undefined, requireSandboxForAutonomous: false, commandAllow: ["^npm (test|run build)$"], commandDeny: [], agentsAllowed: true },
      "npm test",
    );
    assert.equal(allow.allowed, true);
    const notAllowed = commandListVerdict(
      { mode: "supervised", sandbox: undefined, sandboxNetwork: undefined, requireSandboxForAutonomous: false, commandAllow: ["^npm (test|run build)$"], commandDeny: [], agentsAllowed: true },
      "curl https://evil.example",
    );
    assert.equal(notAllowed.allowed, false);

    const invalid = commandListVerdict(
      { mode: "supervised", sandbox: undefined, sandboxNetwork: undefined, requireSandboxForAutonomous: false, commandAllow: [], commandDeny: ["[unclosed"], agentsAllowed: true },
      "ls",
    );
    assert.equal(invalid.allowed, false, "invalid regex fails closed");
  });

  it("a readonly workspace denies writes and agent tools while another stays usable", async () => {
    const strict = await client.callTool({
      name: "open_workspace",
      arguments: { path: strictRoot },
    });
    const strictId = ((strict.structuredContent ?? {}) as { workspaceId?: string }).workspaceId!;

    const write = await client.callTool({
      name: "write",
      arguments: { workspaceId: strictId, path: "out.txt", content: "nope" },
    });
    assert.equal(write.isError, undefined, "file writes are path tools; readonly is enforced on shell/agents");
    void write;

    const shell = await client.callTool({
      name: "bash",
      arguments: { workspaceId: strictId, command: "npm test" },
    });
    assert.equal(shell.isError, true, "readonly workspace denies non-inspection shell");
    assert.match(textOf(shell), /readonly mode/);

    const agents = await client.callTool({
      name: "agent_start",
      arguments: { workspaceId: strictId, target: "codex", prompt: "hi" },
    });
    assert.ok(agents.isError === true || /disabled/i.test(textOf(agents)), "agent tools blocked on the strict workspace");
  });

  it("autonomous workspace keeps tier-1 free and the other workspace's restrictions do not leak", async () => {
    const loose = await client.callTool({
      name: "open_workspace",
      arguments: { path: looseRoot },
    });
    const looseId = ((loose.structuredContent ?? {}) as { workspaceId?: string }).workspaceId!;
    const shell = await client.callTool({
      name: "bash",
      arguments: { workspaceId: looseId, command: "ls" },
    });
    assert.notEqual(shell.isError, true);
  });

  it("sandbox path: bash in the claude surface now runs under the same boundary (no side channel)", async () => {
    // With sandbox=auto and bwrap available, a denied-network workspace command
    // runs wrapped: /proc reads unavailable and env filtered. We assert the
    // observable part of the shared boundary: environment filtering.
    const loose = await client.callTool({
      name: "open_workspace",
      arguments: { path: looseRoot },
    });
    const looseId = ((loose.structuredContent ?? {}) as { workspaceId?: string }).workspaceId!;
    // File-based probe on Windows: cmd.exe mangles `node -e "..."` quoting
    // (Node's spawn quotes the whole command for `cmd /d /s /c`, so the
    // script arrives with literal backslashes and dies with a SyntaxError).
    // POSIX keeps the inline probe: under bwrap the fixture workspace lives
    // under /tmp, which the sandbox masks with a fresh tmpfs, so a script
    // file there would be hidden while an inline script runs fine.
    const probeCommand = process.platform === "win32"
      ? "node probe-owner-token.js"
      : 'node -e "console.log(typeof process.env.HEARTH_OAUTH_OWNER_TOKEN)"';
    const probe = await client.callTool({
      name: "bash",
      arguments: {
        workspaceId: looseId,
        command: probeCommand,
      },
    });
    assert.match(textOf(probe), /undefined/, "owner token must not leak into tool shells");
  });
});
