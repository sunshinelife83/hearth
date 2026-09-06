import assert from "node:assert/strict";
import { Result, type Result as BetterResult } from "better-result";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";
import { LocalAgentManager } from "./local-agent-manager.js";
import type { AgentProviderError } from "./local-agent-errors.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";
import type {
  LocalAgentDriver,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { LocalAgentStore } from "./local-agent-store.js";
import type { SubagentsConfig } from "./local-agent-config.js";

const root = await mkdtemp(join(tmpdir(), "devspace-agent-lifecycle-test-"));
const stateDir = join(root, "state");
const scope = { workspaceId: "ws_life", workspaceRoot: root };
const profile: LocalAgentProfile = {
  name: "worker",
  description: "Test worker",
  provider: "codex",
  filePath: join(root, "worker.md"),
  body: "",
  disabled: false,
};
const subagents: SubagentsConfig = {
  enabled: true,
  providers: [{ id: "codex", enabled: true }],
};

class LifecycleRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  closed = false;
  outputs: string[] = [];
  private releaseHold: (() => void) | undefined;

  async run(
    input: LocalAgentRunInput,
    callbacks?: { onOutput?: (delta: string) => void },
  ): Promise<BetterResult<LocalAgentRunResult, AgentProviderError>> {
    if (input.prompt.includes("stream")) {
      callbacks?.onOutput?.("step one ");
      callbacks?.onOutput?.("step two");
      this.outputs.push("streamed");
    }
    if (input.prompt.includes("hold")) {
      await new Promise<void>((resolve) => { this.releaseHold = resolve; });
    }
    return Result.ok({
      provider: this.provider,
      providerSessionId: "thread_life",
      finalResponse: `response:${input.prompt}`,
      items: [],
    });
  }

  release(): void {
    this.releaseHold?.();
  }

  releaseSession(): Promise<void> {
    return Promise.resolve();
  }

  isAlive(): boolean {
    return !this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.release();
  }
}

const runtimes = new Map<string, LifecycleRuntime>();
const driver: LocalAgentDriver = {
  provider: "codex",
  runtimeKey: (context: LocalAgentRuntimeContext) => context.agentId,
  createRuntime: async (context) => {
    const runtime = new LifecycleRuntime();
    runtimes.set(context.agentId, runtime);
    return Result.ok(runtime);
  },
};

const store = new LocalAgentStore(stateDir);
const manager = new LocalAgentManager({
  store,
  drivers: [driver],
  pool: new LocalAgentRuntimePool(),
  loadProfiles: async () => [profile],
  allowedRoots: [root],
  subagents,
});

function unwrap<T, E>(result: BetterResult<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}

function getRecord(id: string) {
  return unwrap(manager.get(id, scope));
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(check(), true, "condition did not become true before timeout");
}

after(async () => {
  await manager.close();
  await rm(root, { recursive: true, force: true });
});

describe("agent lifecycle (pause/resume/stop/cancel/output)", () => {
  it("streams incremental output into the store during a turn", async () => {
    const agent = unwrap(await manager.start({
      target: "worker",
      prompt: "stream please",
      workspaceId: scope.workspaceId,
      workspaceRoot: root,
    }));
    await waitFor(() => getRecord(agent.id).status === "idle");
    assert.match(getRecord(agent.id).latestOutput ?? "", /step one step two/);
  });

  it("pauses an idle agent and resumes it with a new turn", async () => {
    const agent = unwrap(await manager.start({
      target: "worker",
      prompt: "first",
      workspaceId: scope.workspaceId,
      workspaceRoot: root,
    }));
    await waitFor(() => getRecord(agent.id).status === "idle");

    const paused = unwrap(await manager.pause(agent.id, scope));
    assert.equal(paused.status, "paused");

    const resumed = unwrap(await manager.resume(agent.id, "second part", {}, scope));
    assert.equal(resumed.status, "running");
    await waitFor(() => getRecord(agent.id).status === "idle");
    assert.match(getRecord(agent.id).latestResponse ?? "", /second part/);
  });

  it("force-pauses a running turn and ends it as paused", async () => {
    const agent = unwrap(await manager.start({
      target: "worker",
      prompt: "hold for pause",
      workspaceId: scope.workspaceId,
      workspaceRoot: root,
    }));
    await waitFor(() => runtimes.get(agent.id)?.closed === false && runtimes.has(agent.id));

    const withoutForce = await manager.pause(agent.id, scope);
    assert.equal(withoutForce.isErr(), true);
    if (withoutForce.isErr()) assert.equal(withoutForce.error.code, "AGENT_TURN_ACTIVE");

    const forced = unwrap(await manager.pause(agent.id, scope, { force: true }));
    assert.equal(forced.status, "paused");
    await waitFor(() => getRecord(agent.id).status === "paused");
    assert.equal(runtimes.get(agent.id)?.closed, true, "forced pause closes the runtime");

    const resumed = unwrap(await manager.resume(agent.id, "continue after pause", {}, scope));
    assert.equal(resumed.status, "running");
    await waitFor(() => getRecord(agent.id).status === "idle");
  });

  it("force-stops a running turn and leaves it stopped", async () => {
    const agent = unwrap(await manager.start({
      target: "worker",
      prompt: "hold for stop",
      workspaceId: scope.workspaceId,
      workspaceRoot: root,
    }));
    await waitFor(() => runtimes.has(agent.id));

    const stopped = unwrap(await manager.stop(agent.id, scope, { force: true }));
    assert.equal(stopped.status, "stopped");
    await waitFor(() => getRecord(agent.id).status === "stopped");
  });

  it("cancels an idle agent unconditionally", async () => {
    const agent = unwrap(await manager.start({
      target: "worker",
      prompt: "to be cancelled",
      workspaceId: scope.workspaceId,
      workspaceRoot: root,
    }));
    await waitFor(() => getRecord(agent.id).status === "idle");
    const cancelled = unwrap(await manager.cancel(agent.id, scope));
    assert.equal(cancelled.status, "stopped");
  });

  it("rejects lifecycle operations for unknown or foreign-workspace agents", async () => {
    const foreignScope = { workspaceId: "ws_other", workspaceRoot: join(root, "elsewhere") };
    const paused = await manager.pause("agt_missing", scope);
    assert.equal(paused.isErr(), true);
    const stopped = await manager.pause("agt_missing", foreignScope);
    assert.equal(stopped.isErr(), true);
  });
});

