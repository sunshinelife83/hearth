import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { buildLocalMcpServer } from "./stdio-server.js";
import { LocalAgentClient } from "./local-agent-client.js";
import { writeTestHearthConfig } from "./test-support/config.test.js";
import { TaskStore } from "./task-store.js";
import { linkAgentToTask, stallAdvisory } from "./agent-tools.js";
import { normalizeTimeoutMs, DEFAULT_AGENT_TURN_TIMEOUT_MS } from "./local-agent-manager.js";

describe("agent → task ownership linkage", () => {
  let root = "";
  let workspaceRoot = "";
  let client: Client;
  let closeServer: () => Promise<void>;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "hearth-agent-link-test-"));
    workspaceRoot = join(root, "project");
    await mkdir(workspaceRoot, { recursive: true });

    const env = writeTestHearthConfig(join(root, "config"), {
      server: { host: "127.0.0.1", port: 7176, publicBaseUrl: null },
      workspaces: { allowedRoots: [workspaceRoot] },
      storage: { stateDir: join(root, "state") },
      tools: { mode: "claude" },
      ui: { enabled: false },
      logging: { level: "silent" },
    });
    const config = loadConfig(env);
    const local = buildLocalMcpServer(config);
    closeServer = local.close;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "agent-link-test-client", version: "0.0.1" });
    await Promise.all([
      local.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  after(async () => {
    await client.close();
    await closeServer();
    await stopFixtureDaemon(join(root, "state"));
    await rmFixtureDir(root);
  });

  it("linkAgentToTask records ownership and rejects unknown tasks", () => {    const store = new TaskStore(join(root, "state"));
    const task = store.create({ workspaceRoot, goal: "own me" });
    assert.equal(linkAgentToTask(store, task.id, "agent_1", { correlationId: "corr-1" }), undefined);
    const record = store.get(task.id)!;
    assert.ok(record.evidence.some((entry) => entry.summary.includes("agent_1") && entry.summary.includes("corr-1")));
    assert.match(linkAgentToTask(store, "task_missing", "agent_2") ?? "", /Unknown task/);
    store.close();
  });

  it("agent_start with an unknown taskId fails loudly (no silent detach)", async () => {
    const opened = await client.callTool({ name: "open_workspace", arguments: { path: workspaceRoot } });
    const workspaceId = ((opened.structuredContent ?? {}) as { workspaceId?: string }).workspaceId!;
    const result = await client.callTool({
      name: "agent_start",
      arguments: { workspaceId, target: "codex", prompt: "hi", taskId: "task_does_not_exist" },
    });
    assert.equal(result.isError, true);
    const text = ((result.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n");
    assert.match(text, /Unknown task/);
  });

  it("a failed start records no task link (ownership only on success)", async () => {
    const { TaskStore: Store } = await import("./task-store.js");
    const store = new Store(join(root, "state"));
    const task = store.create({ workspaceRoot, goal: "link ordering" });
    store.close();

    const opened = await client.callTool({ name: "open_workspace", arguments: { path: workspaceRoot } });
    const workspaceId = ((opened.structuredContent ?? {}) as { workspaceId?: string }).workspaceId!;
    const result = await client.callTool({
      name: "agent_start",
      arguments: { workspaceId, target: "nope-not-a-provider", prompt: "hi", taskId: task.id },
    });
    assert.equal(result.isError, true, "unknown provider fails the start");

    const check = new Store(join(root, "state"));
    try {
      const record = check.get(task.id)!;
      assert.ok(!record.evidence.some((entry) => entry.summary.includes("started for task")),
        "no ownership link without a successful start");
    } finally {
      check.close();
    }
  });
});

describe("watchdog budgets and stall advisories", () => {
  it("normalizeTimeoutMs defaults and clamps", () => {
    assert.equal(normalizeTimeoutMs(undefined), DEFAULT_AGENT_TURN_TIMEOUT_MS);
    assert.equal(normalizeTimeoutMs(0), DEFAULT_AGENT_TURN_TIMEOUT_MS);
    assert.equal(normalizeTimeoutMs(-5), DEFAULT_AGENT_TURN_TIMEOUT_MS);
    assert.equal(normalizeTimeoutMs(Number.NaN), DEFAULT_AGENT_TURN_TIMEOUT_MS);
    assert.equal(normalizeTimeoutMs(60_000), 60_000);
    assert.equal(normalizeTimeoutMs(30 * 24 * 3600 * 1000), 7 * 24 * 3600 * 1000);
  });

  it("stallAdvisory flags only long-quiet running turns", () => {
    const now = Date.now();
    const quiet = { status: "running" as const, updatedAt: new Date(now - 10 * 60 * 1000).toISOString() };
    assert.match(stallAdvisory(quiet, { nowMs: now }) ?? "", /Stall suspected/);
    const fresh = { status: "running" as const, updatedAt: new Date(now - 1000).toISOString() };
    assert.equal(stallAdvisory(fresh, { nowMs: now }), undefined);
    const idle = { status: "idle" as const, updatedAt: new Date(now - 60 * 60 * 1000).toISOString() };
    assert.equal(stallAdvisory(idle, { nowMs: now }), undefined, "settled turns never stall-flag");
  });
});

describe("delegation scopes and pre-delegation snapshots", () => {
  let root = "";
  let workspaceRoot = "";
  let client: Client;
  let closeServer: () => Promise<void>;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "hearth-scope-mcp-test-"));
    workspaceRoot = join(root, "project");
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    const env = writeTestHearthConfig(join(root, "config"), {
      server: { host: "127.0.0.1", port: 7176, publicBaseUrl: null },
      workspaces: { allowedRoots: [workspaceRoot] },
      storage: { stateDir: join(root, "state") },
      tools: { mode: "claude" },
      ui: { enabled: false },
      logging: { level: "silent" },
    });
    const config = loadConfig(env);
    const local = buildLocalMcpServer(config);
    closeServer = local.close;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "scope-mcp-test-client", version: "0.0.1" });
    await Promise.all([
      local.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  after(async () => {
    await client.close();
    await closeServer();
    await stopFixtureDaemon(join(root, "state"));
    await rmFixtureDir(root);
  });

  const textOf = (result: unknown) =>
    ((result as { content?: Array<{ text?: string }> }).content ?? []).map((b) => b.text ?? "").join("\n");

  async function workspaceId(): Promise<string> {
    const opened = await client.callTool({ name: "open_workspace", arguments: { path: workspaceRoot } });
    return ((opened.structuredContent ?? {}) as { workspaceId?: string }).workspaceId!;
  }

  it("scopePaths escaping the workspace are rejected pre-dispatch", async () => {
    const id = await workspaceId();
    const result = await client.callTool({
      name: "agent_start",
      arguments: { workspaceId: id, target: "nope-not-a-provider", prompt: "hi", scopePaths: ["../outside"] },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /escapes the workspace/);
  });

  it("missing snapshots never block delegation (non-git workspace proceeds to provider dispatch)", async () => {
    // NOTE: the test sandbox cannot boot the agent daemon (no owner token in
    // the daemon's env), so dispatch fails downstream either way. What this
    // proves: the best-effort pre-delegation snapshot on a non-git workspace
    // never surfaces a snapshot error and never masks the real outcome.
    const id = await workspaceId();
    const result = await client.callTool({
      name: "agent_start",
      arguments: { workspaceId: id, target: "nope-not-a-provider", prompt: "hi", scopePaths: ["src"] },
    });
    assert.equal(result.isError, true);
    assert.ok(!/snapshot/i.test(textOf(result)), "no snapshot error leaks into the failure");
  });
});

/**
 * Stop the hearth-agentd this fixture may have booted. Even a failing
 * `agent_start` reaches the overlap guard, which calls `agentClient().list()`
 * and boots a detached, unref'd daemon as a side effect. The daemon opens
 * this fixture's state/hearth.sqlite (LocalAgentStore) and idles, and nothing
 * tracks the child — `local.close()` only shuts down the in-process stores.
 * POSIX unlinks open files fine, but on Windows the orphan's handle makes the
 * cleanup `rm` fail with EBUSY. Stopping over the daemon socket (with a
 * client that can never spawn a replacement) releases the handle
 * deterministically; a missing or already-dead daemon is a no-op success.
 */
async function stopFixtureDaemon(stateDir: string): Promise<void> {
  const daemon = new LocalAgentClient({
    stateDir,
    spawnDaemon: () => undefined,
    requestTimeoutMs: 5_000,
  });
  await daemon.stop();
}

/**
 * Remove the fixture dir, tolerating Windows' transient file-lock release.
 * All deterministic cleanup (store closes above, daemon stop) runs first;
 * this only absorbs the OS letting go of handles from just-exited processes
 * (EBUSY/EPERM/ENOTEMPTY), which POSIX never surfaces. Bounded and
 * code-specific: anything else still throws immediately.
 */
async function rmFixtureDir(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}
