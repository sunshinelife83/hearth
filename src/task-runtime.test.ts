import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { buildLocalMcpServer } from "./stdio-server.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { TaskStore, TaskTransitionError } from "./task-store.js";
import { detectVerificationGates } from "./verification.js";

describe("task runtime (state machine + verification gates)", () => {
  let root = "";
  let client: Client;
  let closeServer: () => Promise<void>;
  let workspaceRoot = "";

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "devspace-task-test-"));
    workspaceRoot = join(root, "project");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({
      name: "fixture",
      scripts: { test: "node gate.js" },
    }));
    await writeFile(join(workspaceRoot, "gate.js"), "process.exit(Number(process.env.GATE_FAIL ?? 0))");

    const env = writeTestDevspaceConfig(join(root, "config"), {
      server: { host: "127.0.0.1", port: 7676, publicBaseUrl: null },
      workspaces: { allowedRoots: [workspaceRoot, join(root, 'plain')] },
      storage: { stateDir: join(root, "state") },
      tools: { mode: "claude" },
      ui: { enabled: false },
      logging: { level: "silent" },
    });
    const config = loadConfig(env);
    const local = buildLocalMcpServer(config);
    closeServer = local.close;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "task-test-client", version: "0.0.1" });
    await Promise.all([
      local.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  after(async () => {
    await client.close();
    await closeServer();
    await rm(root, { recursive: true, force: true });
  });

  async function openWorkspace(): Promise<string> {
    const opened = await client.callTool({
      name: "open_workspace",
      arguments: { path: workspaceRoot },
    });
    return ((opened.structuredContent ?? {}) as { workspaceId?: string }).workspaceId!;
  }

  async function call(name: string, args: Record<string, unknown>) {
    return client.callTool({ name, arguments: args });
  }

  function asRecord(value: unknown): Record<string, unknown> {
    return (value ?? {}) as Record<string, unknown>;
  }

  it("detects npm verification gates from the manifest", () => {
    const gates = detectVerificationGates(workspaceRoot);
    assert.deepEqual(gates.map((gate) => gate.name), ["test"]);
    assert.equal(gates[0]?.command, "npm run test");
  });

  it("runs the full loop: create → plan → verify(pass) → verified_complete", async () => {
    const workspaceId = await openWorkspace();
    const created = asRecord((await call("task_create", {
      workspaceId,
      goal: "make the gate pass",
    })).structuredContent);
    const taskId = created.taskId as string;
    assert.equal(created.status, "planning");

    const planned = asRecord((await call("task_plan", {
      taskId,
      steps: ["flip the gate", "verify"],
    })).structuredContent);
    assert.equal(planned.status, "executing");

    const verified = asRecord((await call("task_verify", { taskId })).structuredContent);
    assert.equal(verified.status, "completed");
    assert.equal(verified.completionState, "verified_complete");
  });

  it("refuses a false model claim: failing gates reject completion and move to repairing", async () => {
    const workspaceId = await openWorkspace();
    const created = asRecord((await call("task_create", {
      workspaceId,
      goal: "impossible task",
    })).structuredContent);
    const taskId = created.taskId as string;
    await call("task_plan", { taskId, steps: ["break things"] });

    // Make the gate fail for this run.
    const failing = await call("task_verify", {
      taskId,
      gates: [{ name: "failing", command: "node -e 'process.exit(3)'" }],
    });
    const failedRecord = asRecord(failing.structuredContent);
    assert.equal(failedRecord.status, "repairing");
    const text = (failing.content as Array<{ type: string; text?: string }>)
      .map((block) => block.text ?? "").join("\n");
    assert.match(text, /Verification FAILED/);

    // A completion claim now cannot bypass the failing evidence.
    const claim = await call("task_complete", { taskId });
    const claimRecord = asRecord(claim.structuredContent);
    assert.equal(claimRecord.status, "repairing");
    assert.equal(claimRecord.completionState, undefined);
  });

  it("marks explicitly-unverified completions as model_complete, never verified_complete", async () => {
    // A workspace without any detectable verification gates.
    const plainRoot = join(root, "plain");
    await mkdir(plainRoot, { recursive: true });
    const opened = await client.callTool({
      name: "open_workspace",
      arguments: { path: plainRoot },
    });
    const workspaceId = ((opened.structuredContent ?? {}) as { workspaceId?: string }).workspaceId!;
    const created = asRecord((await call("task_create", {
      workspaceId,
      goal: "no gates here",
    })).structuredContent);
    const taskId = created.taskId as string;
    await call("task_plan", { taskId, steps: ["only step"] });

    const rejected = await call("task_complete", { taskId });
    assert.equal(rejected.isError, true, "silent unverified completion must be rejected");

    const accepted = asRecord((await call("task_complete", {
      taskId,
      acceptUnverified: true,
    })).structuredContent);
    assert.equal(accepted.status, "completed");
    assert.equal(accepted.completionState, "model_complete");
  });

  it("rejects illegal state transitions", async () => {
    const workspaceId = await openWorkspace();
    const created = asRecord((await call("task_create", {
      workspaceId,
      goal: "transition guard",
    })).structuredContent);
    const taskId = created.taskId as string;
    const attempted = await call("task_complete", { taskId, acceptUnverified: true });
    assert.equal(attempted.isError, true, "planning tasks cannot complete");
  });

  it("reconciles in-flight tasks as failed after restart", () => {
    const store = new TaskStore(join(root, "state"));
    const task = store.create({ workspaceRoot: workspaceRoot, goal: "orphaned" });
    store.transition(task.id, "executing", { plan: ["x"] });
    const reconciled = store.reconcileOnBoot();
    assert.ok(reconciled >= 1);
    assert.equal(store.get(task.id)?.status, "failed");
    store.close();
  });

  it("guards transitions at the store level", () => {
    const store = new TaskStore(join(root, "state"));
    const task = store.create({ workspaceRoot: workspaceRoot, goal: "guard" });
    assert.throws(() => store.transition(task.id, "completed"), TaskTransitionError);
    store.close();
  });
});
