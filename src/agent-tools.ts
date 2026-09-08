import * as z from "zod/v4";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import { createLocalAgentClient, type LocalAgentClient } from "./local-agent-client.js";
import type { RunOverrides } from "./local-agent-manager.js";
import type { LocalAgentRecord } from "./local-agent-store.js";
import type { LocalAgentWorkspaceScope } from "./local-agent-store.js";
import type { ServerConfig } from "./config.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { TaskStore } from "./task-store.js";
import { logToolCall, resultOutputSchema, textBlock } from "./tool-surfaces/shared.js";
import { workspaceIdDescription } from "./tool-surfaces/types.js";
import { resolveExecutionForWorkspace } from "./policy/workspace-profiles.js";
import { contentText } from "./tool-surfaces/shared.js";
import { buildDelegationBrief } from "./orchestration/brief.js";
import { collectTouchedFiles, buildAgentResultEvidence, formatTouchedFiles, AGENT_RESULT_MARKER } from "./orchestration/result.js";
import { normalizeScopePaths, createOverlapGuard } from "./orchestration/scope.js";
import { createSnapshot } from "./snapshot-manager.js";
import { logEvent } from "./logger.js";
import {
  resolveLane,
  effectiveLanes,
  loadProjectFleet,
  approveProjectFleet,
  validateLaneName,
} from "./orchestration/lanes.js";
import { isSubagentProviderEnabled } from "./local-agent-config.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import { buildRepoMap, formatRepoMap } from "./context/repo-map.js";
import { detectVerificationGates } from "./verification.js";

/**
 * MCP surface for Hearth's local agent lifecycle (correction #5): external
 * CLI coding agents (Codex, Claude Code, OpenCode, Pi, Cursor, Copilot, Grok)
 * run in the background under the agent daemon and are managed from any MCP
 * client through start/status/output/send/pause/resume/stop/cancel/list.
 *
 * Every tool is workspace-scoped: the caller passes a workspaceId opened via
 * open_workspace and the daemon call is bound to that workspace's root, so
 * MCP clients can never target arbitrary paths.
 */

const agentErrorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
  agentId: z.string().optional(),
});

const agentRecordOutputSchema = resultOutputSchema({
  agentId: z.string(),
  status: z.string(),
  provider: z.string(),
  profileName: z.string(),
  model: z.string().optional(),
  latestOutput: z.string().optional(),
  latestResponse: z.string().optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
});

class AgentToolsBlockedError extends Error {}
// Kept for backward-compat with any external catch sites; gates now return
// isError tool results instead of throwing (see checkAgentsAllowed).

interface AgentToolContext {
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  /** When present, agent_start can link the agent to a task (ownership trail). */
  taskStore?: TaskStore;
}

/**
 * Advisory stall note for long-quiet running turns (uses updatedAt as the
 * liveness heartbeat: every output delta persists and bumps it). Pure and
 * exported for tests; advisory only, never auto-kills.
 */
export function stallAdvisory(
  record: Pick<LocalAgentRecord, "status" | "updatedAt">,
  options: { quietAfterMs?: number; nowMs?: number } = {},
): string | undefined {
  if (record.status !== "running" && record.status !== "starting") return undefined;
  const quietAfterMs = options.quietAfterMs ?? 5 * 60 * 1000;
  const quietMs = (options.nowMs ?? Date.now()) - Date.parse(record.updatedAt);
  if (!Number.isFinite(quietMs) || quietMs < quietAfterMs) return undefined;
    return `Stall suspected: no turn activity for ${Math.round(quietMs / 60000)} minute(s) (last update ${record.updatedAt}). The turn is still tracked; use agent_output to inspect, or agent_stop/agent_cancel to end it.`;
}

/**
 * Record agent→task ownership in the task's evidence trail. Returns an error
 * message when the task does not exist; the caller turns it into an isError
 * tool result so unknown taskIds fail loudly instead of silently detaching.
 */
export function linkAgentToTask(
  taskStore: TaskStore,
  taskId: string,
  agentId: string,
  extra?: { correlationId?: string },
): string | undefined {
  const record = taskStore.get(taskId);
  if (!record) return `Unknown task: ${taskId}. Pass a task_create taskId or omit taskId.`;
  taskStore.appendEvidence(taskId, {
    ts: new Date().toISOString(),
    kind: "note",
    summary: `agent ${agentId} started for task${extra?.correlationId ? ` (correlation ${extra.correlationId})` : ""}`,
  });
  return undefined;
}

export function registerAgentTools(target: McpRegistrationTarget, context: AgentToolContext): void {
  const { config, workspaces, taskStore } = context;
  let client: LocalAgentClient | undefined;
  const agentClient = (): LocalAgentClient => {
    client ??= createLocalAgentClient(config);
    return client;
  };
  /** Best-effort concurrent-write guard for this server process (see scope.ts). */
  const overlapGuard = createOverlapGuard();

  const scopeOf = (workspaceId: string): LocalAgentWorkspaceScope => {
    const workspace = workspaces.getWorkspace(workspaceId);
    return { workspaceId, workspaceRoot: workspace.root };
  };

  /** Workspace security profile gate for every agent tool invocation.
   * Returns an isError tool result when blocked, so MCP clients see a normal
   * tool error (not a JSON-RPC protocol error from a thrown exception). */
  const blocked = (message: string) => ({
    content: [textBlock(message)],
    isError: true as const,
    structuredContent: { result: message },
  });

  const checkAgentsAllowed = (workspaceId: string): string | undefined => {
    const workspace = workspaces.getWorkspace(workspaceId);
    const resolved = resolveExecutionForWorkspace(config, workspace.root);
    if (!resolved.agentsAllowed) {
      return `Agent tools are disabled for this workspace by its security profile.`;
    }
    return undefined;
  };

  const checkWritableAgentOp = (workspaceId: string): string | undefined => {
    const blockedByProfile = checkAgentsAllowed(workspaceId);
    if (blockedByProfile) return blockedByProfile;
    const workspace = workspaces.getWorkspace(workspaceId);
    const resolved = resolveExecutionForWorkspace(config, workspace.root);
    if (resolved.mode === "readonly") {
      return "The workspace is in readonly mode; agent delegation requires supervised or autonomous mode.";
    }
    return undefined;
  };

  /** Default watchdog budget recorded in briefs (enforced in Phase 3). */
  const DEFAULT_DELEGATION_TIMEOUT_MS = 30 * 60 * 1000;

  /** Bounded read of repo instruction files, quoted as untrusted brief context. */
  const readRepoInstructions = async (workspaceRoot: string): Promise<string | undefined> => {
    const chunks: string[] = [];
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        const text = await readFile(join(workspaceRoot, name), "utf8");
        chunks.push(`# ${name}\n${text.slice(0, 750)}`);
      } catch {
        // Absent or unreadable: no instructions from this file.
      }
    }
    return chunks.length > 0 ? chunks.join("\n\n").slice(0, 1500) : undefined;
  };

  /** Compose the self-contained delegation brief for a task-owned run. */
  const composeBrief = async (input: {
    taskId: string;
    workspaceId: string;
    workspaceRoot: string;
    callerPrompt: string;
    writeMode: string;
    timeoutMs: number;
  }): Promise<string> => {
    const task = taskStore!.get(input.taskId)!;
    const resolved = resolveExecutionForWorkspace(config, input.workspaceRoot);
    let repoMapSummary: string | undefined;
    try {
      repoMapSummary = formatRepoMap(await buildRepoMap(input.workspaceRoot, { maxFiles: 1000 }));
    } catch {
      repoMapSummary = undefined;
    }
    const priorFailures = task.evidence
      .filter((entry) => entry.summary.includes("FAILED") || entry.kind === "verification")
      .slice(-5)
      .map((entry) => entry.summary);
    if (task.error) priorFailures.push(`task error: ${task.error}`);
    return buildDelegationBrief({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      goal: task.goal,
      callerPrompt: input.callerPrompt,
      mode: resolved.mode,
      writeMode: input.writeMode,
      repoMapSummary,
      repoInstructions: await readRepoInstructions(input.workspaceRoot),
      verificationGates: detectVerificationGates(input.workspaceRoot).map((gate) => ({ name: gate.name, command: gate.command })),
      planSteps: task.plan,
      priorFailures,
      timeoutMs: input.timeoutMs,
    });
  };

  /** Reverse lookup: which task (if any) owns this agent, via evidence trail. */
  const findTaskForAgent = (workspaceId: string, agentId: string): string | undefined => {
    if (!taskStore) return undefined;
    const needle = `agent ${agentId} started for task`;
    for (const task of taskStore.list({ workspaceId })) {
      if (task.evidence.some((entry) => entry.summary.includes(needle))) return task.id;
    }
    return undefined;
  };

  /**
   * Append structured agent_result evidence for settled turns, deduped per
   * agent+status so polling status/output does not spam the trail. The fresh
   * touched-files scope is always returned to the caller regardless.
   */
  const maybeRecordAgentResult = async (input: {
    workspaceId: string;
    record: LocalAgentRecord;
    correlationId?: string;
  }): Promise<string> => {
    const touched = await collectTouchedFiles(
      workspaces.getWorkspace(input.workspaceId).root,
    );
    const settled = new Set(["idle", "error", "stopped", "paused"]);
    if (settled.has(input.record.status)) {
      overlapGuard.release(input.record.id);
    }
    if (taskStore && settled.has(input.record.status)) {
      const taskId = findTaskForAgent(input.workspaceId, input.record.id);
      if (taskId) {
        const task = taskStore.get(taskId);
        const marker = `${AGENT_RESULT_MARKER} ${input.record.id} ${input.record.status}`;
        const already = task?.evidence.some((entry) => entry.summary.startsWith(marker));
        if (!already) {
          const evidence = buildAgentResultEvidence({
            agentId: input.record.id,
            provider: input.record.provider,
            profileName: input.record.profileName,
            status: input.record.status,
            touched,
            finalResponse: input.record.latestResponse ?? input.record.latestOutput ?? "",
            ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          });
          taskStore.appendEvidence(taskId, {
            ts: new Date().toISOString(),
            kind: "note",
            summary: evidence.summary,
            details: evidence.details,
          });
        }
      }
    }
    return formatTouchedFiles(touched);
  };

  const withTouchedScope = (
    response: { content: Array<{ type: string; text?: string }>; structuredContent: Record<string, unknown> },
    touchedScope: string,
  ) => {
    const prior = typeof response.structuredContent.result === "string" ? response.structuredContent.result : "";
    const result = `${prior}\n\n${touchedScope}`;
    return {
      content: [textBlock(result)],
      structuredContent: { ...response.structuredContent, result },
    };
  };

  const toResult = (record: LocalAgentRecord) => {
    const lines = [
      `Agent ${record.id} (${record.provider}/${record.profileName}) status: ${record.status}.`,
      record.latestOutput ? `Latest output:\n${record.latestOutput}` : undefined,
      record.latestResponse ? `Last response:\n${record.latestResponse}` : undefined,
      record.error ? `Error ${record.errorCode ?? ""}: ${record.error}` : undefined,
    ].filter(Boolean).join("\n\n");
    return {
      content: [textBlock(lines)],
      structuredContent: {
        result: lines,
        agentId: record.id,
        status: record.status,
        provider: record.provider,
        profileName: record.profileName,
        ...(record.model ? { model: record.model } : {}),
        ...(record.latestOutput ? { latestOutput: record.latestOutput } : {}),
        ...(record.latestResponse ? { latestResponse: record.latestResponse } : {}),
        ...(record.error ? { error: record.error, errorCode: record.errorCode } : {}),
      },
    };
  };

  const toError = (tool: string, startedAt: number, workspaceId: string, error: { code: string; message: string }) => {
    logToolCall(config, {
      tool,
      workspaceId,
      success: false,
      durationMs: Math.round(performance.now() - startedAt),
      error: `${error.code}: ${error.message}`,
    });
    const parsed = agentErrorPayloadSchema.safeParse(error);
    const message = parsed.success ? error.message : "Local agent operation failed.";
    return {
      content: [textBlock(`${error.code}: ${message}`)],
      isError: true as const,
      structuredContent: {
        result: `${error.code}: ${message}`,
        errorCode: error.code,
        retryable: parsed.success ? (error as { retryable?: boolean }).retryable === true : false,
      },
    };
  };

  const overridesOf = (input: { model?: string; effort?: string; writeMode?: string }): RunOverrides | undefined => {
    const overrides: RunOverrides = {
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.writeMode !== undefined ? { writeMode: input.writeMode as RunOverrides["writeMode"] } : {}),
    };
    return Object.keys(overrides).length > 0 ? overrides : undefined;
  };

  target.registerTool(
    "agent_start",
    {
      title: "Start coding agent",
      description:
        "Start a background coding agent (provider or profile: codex, claude, opencode, pi, cursor, copilot, grok, or a configured profile name) on this workspace. Returns immediately with an agentId; poll agent_status / agent_output while it runs. Providers must be enabled in Hearth subagents config.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        target: z.string().min(1).optional().describe("Provider id or configured agent profile name. Optional when lane selects the implementer."),
        prompt: z.string().min(1).describe("Task brief for the agent."),
        model: z.string().optional().describe("Optional model override."),
        effort: z.string().optional().describe("Optional reasoning effort override."),
        writeMode: z.enum(["read_only", "allowed", "full_access"]).optional()
          .describe("Workspace write permission for the agent. Defaults to allowed."),
        taskId: z.string().optional()
          .describe("Optional task_create taskId that owns this agent; recorded in the task evidence trail."),
        correlationId: z.string().max(120).optional()
          .describe("Optional caller correlation ID, audit-logged with the start."),
        lane: z.string().max(64).optional()
          .describe("Optional fleet lane (e.g. feature, tests, review). Lane dials apply as defaults; explicit flags win. A target contradicting the lane provider is rejected."),
        timeoutMs: z.number().int().positive().max(7 * 24 * 3600 * 1000).optional()
          .describe("Watchdog budget for this delegation in milliseconds (default 30 minutes)."),
        scopePaths: z.array(z.string().min(1)).max(20).optional()
          .describe("File scopes for concurrent-write protection (workspace-relative or absolute). Default: whole workspace. Overlapping live delegations are rejected unless allowConcurrentWrites is set."),
        allowConcurrentWrites: z.boolean().optional()
          .describe("Explicitly allow overlapping writes with another live delegation on this workspace."),
      },
      outputSchema: agentRecordOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const startedAt = performance.now();
      const gate = checkWritableAgentOp(input.workspaceId);
      if (gate) return blocked(gate);
      if (input.taskId && !taskStore) {
        return blocked("taskId linkage is unavailable: task runtime is not enabled on this server.");
      }
      if (input.taskId && taskStore && !taskStore.get(input.taskId)) {
        return blocked(`Unknown task: ${input.taskId}. Pass a task_create taskId or omit taskId.`);
      }
      const scope = scopeOf(input.workspaceId);
      // Fleet lane resolution (explicit flags win; contradictions fail loud).
      // Resolved once here and reused below for dials and the brief.
      let laneProvider: LocalAgentProvider | undefined;
      let laneModel: string | undefined;
      let laneEffort: string | undefined;
      let laneWriteMode: "read_only" | "allowed" | "full_access" | undefined;
      let laneTimeoutMs: number | undefined;
      if (input.lane) {
        const badName = validateLaneName(input.lane);
        if (badName) return blocked(badName);
        const project = await loadProjectFleet(scope.workspaceRoot, config.stateDir);
        const resolved = resolveLane(config.fleet, project, input.lane);
        if (!resolved.ok) return blocked(resolved.error);
        laneProvider = resolved.lane.provider;
        laneModel = resolved.lane.model;
        laneEffort = resolved.lane.effort;
        laneWriteMode = resolved.lane.writeMode;
        laneTimeoutMs = resolved.lane.timeoutMs;
        if (input.target && input.target !== laneProvider) {
          return blocked(`Lane ${JSON.stringify(resolved.lane.name)} binds implementer ${JSON.stringify(laneProvider)}, but target ${JSON.stringify(input.target)} was requested. Use the lane's implementer or a different lane.`);
        }
        if (!isSubagentProviderEnabled(config.subagents, laneProvider)) {
          return blocked(`Lane ${JSON.stringify(resolved.lane.name)} needs provider ${JSON.stringify(laneProvider)}, which is not enabled in subagents config.`);
        }
      }
      const target = laneProvider ?? input.target;
      if (!target) {
        return blocked("Pass a target provider/profile or a fleet lane.");
      }
      // Concurrent-write protection: sequential by default. Scopes resolve
      // against the workspace root; escapes are rejected, not sanitized.
      const normalizedScope = normalizeScopePaths(scope.workspaceRoot, input.scopePaths);
      if (!normalizedScope.ok) return blocked(normalizedScope.error);
      if (!input.allowConcurrentWrites) {
        const conflict = await overlapGuard.check(input.workspaceId, normalizedScope.paths, async (wsId) => {
          const listed = await agentClient().list(scopeOf(wsId));
          if (listed.isErr()) throw new Error(listed.error.message);
          return listed.value.map((record) => ({ id: record.id, status: record.status }));
        });
        if (conflict) {
          return blocked(`Scope overlaps live delegation ${conflict} on this workspace. Wait for it to finish, narrow scopePaths, or pass allowConcurrentWrites:true to coordinate explicitly.`);
        }
      }
      // Task-owned delegations run from a self-contained brief: the backend
      // sees everything it needs with no orchestrator history. Ad-hoc runs
      // (no taskId) pass the caller prompt through unchanged.
      const writeMode = input.writeMode ?? laneWriteMode ?? "allowed";
      const timeoutMs = input.timeoutMs ?? laneTimeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS;
      const prompt = input.taskId && taskStore
        ? await composeBrief({
            taskId: input.taskId,
            workspaceId: input.workspaceId,
            workspaceRoot: scope.workspaceRoot,
            callerPrompt: input.prompt,
            writeMode,
            timeoutMs,
          })
        : input.prompt;
      // Snapshot-before-delegation: best-effort safety net for write-capable
      // runs. Never blocks: non-git workspaces and snapshot failures log and
      // continue, because the policy engine remains the real boundary.
      let preSnapshotId: string | undefined;
      if (writeMode !== "read_only") {
        try {
          const workspace = workspaces.getWorkspace(input.workspaceId);
          const snapshot = await createSnapshot({
            root: scope.workspaceRoot,
            workspaceId: workspace.id,
            label: `pre-delegation ${input.taskId ?? "ad-hoc"}`,
          });
          preSnapshotId = snapshot.snapshotId;
          logEvent(config.logging, "info", "snapshot_created", {
            workspaceId: input.workspaceId,
            snapshotId: snapshot.snapshotId,
            reason: "pre_delegation",
          });
        } catch (error) {
          logEvent(config.logging, "warn", "snapshot_failed", {
            workspaceId: input.workspaceId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const result = await agentClient().start({
        target,
        prompt,
        workspaceRoot: scope.workspaceRoot,
        workspaceId: input.workspaceId,
        model: input.model ?? laneModel,
        effort: input.effort ?? laneEffort,
        writeMode,
        timeoutMs,
      });
      if (result.isErr()) return toError("agent_start", startedAt, input.workspaceId, result.error);
      overlapGuard.track({ agentId: result.value.id, workspaceId: input.workspaceId, scopePaths: normalizedScope.paths });
      if (preSnapshotId && input.taskId && taskStore) {
        taskStore.appendEvidence(input.taskId, {
          ts: new Date().toISOString(),
          kind: "snapshot",
          summary: `pre-delegation snapshot ${preSnapshotId.slice(0, 12)} before agent ${result.value.id}`,
          details: { snapshotId: preSnapshotId },
        });
      }
      if (input.taskId && taskStore) {
        const linkError = linkAgentToTask(taskStore, input.taskId, result.value.id, { correlationId: input.correlationId });
        if (linkError) return blocked(linkError);
      }
      logToolCall(config, {
        tool: "agent_start",
        workspaceId: input.workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return toResult(result.value);
    },
  );

  target.registerTool(
    "agent_status",
    {
      title: "Agent status",
      description: "Fetch a background agent's record: status, last response, and error details.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        agentId: z.string().min(1),
      },
      outputSchema: agentRecordOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, agentId }) => {
      const startedAt = performance.now();
      const gate = checkAgentsAllowed(workspaceId);
      if (gate) return blocked(gate);
      const result = await agentClient().get(agentId, scopeOf(workspaceId));
      if (result.isErr()) return toError("agent_status", startedAt, workspaceId, result.error);
      const touchedScope = await maybeRecordAgentResult({ workspaceId, record: result.value });
      const stall = stallAdvisory(result.value);
      logToolCall(config, {
        tool: "agent_status",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return withTouchedScope(toResult(result.value), stall ? `${touchedScope}\n\n${stall}` : touchedScope);
    },
  );

  target.registerTool(
    "agent_output",
    {
      title: "Agent output",
      description:
        "Read a background agent's latest incremental output while its turn runs (plus its last completed response when idle).",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        agentId: z.string().min(1),
      },
      outputSchema: agentRecordOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, agentId }) => {
      const startedAt = performance.now();
      const gate = checkAgentsAllowed(workspaceId);
      if (gate) return blocked(gate);
      const result = await agentClient().get(agentId, scopeOf(workspaceId));
      if (result.isErr()) return toError("agent_output", startedAt, workspaceId, result.error);
      const touchedScope = await maybeRecordAgentResult({ workspaceId, record: result.value });
      logToolCall(config, {
        tool: "agent_output",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return withTouchedScope(toResult(result.value), touchedScope);
    },
  );

  const timeoutMsSchema = z.number().int().positive().max(7 * 24 * 3600 * 1000).optional()
    .describe("Watchdog budget for the new turn in milliseconds (default 30 minutes).");

  target.registerTool(
    "agent_send",
    {
      title: "Send to agent",
      description:
        "Continue an existing background agent with a follow-up prompt on its durable provider session.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        agentId: z.string().min(1),
        prompt: z.string().min(1),
        model: z.string().optional(),
        effort: z.string().optional(),
        writeMode: z.enum(["read_only", "allowed", "full_access"]).optional(),
        timeoutMs: timeoutMsSchema,
      },
      outputSchema: agentRecordOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const startedAt = performance.now();
      const gate = checkWritableAgentOp(input.workspaceId);
      if (gate) return blocked(gate);
      const scope = scopeOf(input.workspaceId);
      const result = await agentClient().continue(
        input.agentId,
        input.prompt,
        overridesOf(input) ?? {},
        scope,
        input.timeoutMs,
      );
      if (result.isErr()) return toError("agent_send", startedAt, input.workspaceId, result.error);
      logToolCall(config, {
        tool: "agent_send",
        workspaceId: input.workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return toResult(result.value);
    },
  );

  target.registerTool(
    "agent_pause",
    {
      title: "Pause agent",
      description:
        "Pause a background agent. Pausing between turns is instant; pass force to interrupt a running turn.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        agentId: z.string().min(1),
        force: z.boolean().optional(),
      },
      outputSchema: agentRecordOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspaceId, agentId, force }) => {
      const startedAt = performance.now();
      const gate = checkWritableAgentOp(workspaceId);
      if (gate) return blocked(gate);
      const result = await agentClient().pause(agentId, scopeOf(workspaceId), { force });
      if (result.isErr()) return toError("agent_pause", startedAt, workspaceId, result.error);
      logToolCall(config, {
        tool: "agent_pause",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return toResult(result.value);
    },
  );

  target.registerTool(
    "agent_resume",
    {
      title: "Resume agent",
      description:
        "Resume a paused (or previously failed) background agent with an optional continuation prompt.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        agentId: z.string().min(1),
        prompt: z.string().optional(),
        model: z.string().optional(),
        effort: z.string().optional(),
        writeMode: z.enum(["read_only", "allowed", "full_access"]).optional(),
        timeoutMs: timeoutMsSchema,
      },
      outputSchema: agentRecordOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const startedAt = performance.now();
      const gate = checkWritableAgentOp(input.workspaceId);
      if (gate) return blocked(gate);
      const scope = scopeOf(input.workspaceId);
      const result = await agentClient().resume(
        input.agentId,
        scope,
        { prompt: input.prompt, overrides: overridesOf(input), timeoutMs: input.timeoutMs },
      );
      if (result.isErr()) return toError("agent_resume", startedAt, input.workspaceId, result.error);
      logToolCall(config, {
        tool: "agent_resume",
        workspaceId: input.workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return toResult(result.value);
    },
  );

  target.registerTool(
    "agent_stop",
    {
      title: "Stop agent",
      description:
        "Stop a background agent. Stopping between turns is instant; pass force to interrupt a running turn.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        agentId: z.string().min(1),
        force: z.boolean().optional(),
      },
      outputSchema: agentRecordOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId, agentId, force }) => {
      const startedAt = performance.now();
      const gate = checkWritableAgentOp(workspaceId);
      if (gate) return blocked(gate);
      const result = await agentClient().stopAgent(agentId, scopeOf(workspaceId), { force });
      if (result.isErr()) return toError("agent_stop", startedAt, workspaceId, result.error);
      overlapGuard.release(agentId);
      logToolCall(config, {
        tool: "agent_stop",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return toResult(result.value);
    },
  );

  target.registerTool(
    "agent_cancel",
    {
      title: "Cancel agent turn",
      description:
        "Immediately interrupt a background agent's running turn (unconditional stop).",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        agentId: z.string().min(1),
      },
      outputSchema: agentRecordOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId, agentId }) => {
      const startedAt = performance.now();
      const gate = checkWritableAgentOp(workspaceId);
      if (gate) return blocked(gate);
      const result = await agentClient().stopAgent(agentId, scopeOf(workspaceId), { force: true });
      if (result.isErr()) return toError("agent_cancel", startedAt, workspaceId, result.error);
      overlapGuard.release(agentId);
      logToolCall(config, {
        tool: "agent_cancel",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return toResult(result.value);
    },
  );

  target.registerTool(
    "agent_list",
    {
      title: "List agents",
      description: "List background agents recorded for this workspace.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema(),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const gate = checkAgentsAllowed(workspaceId);
      if (gate) return blocked(gate);
      const result = await agentClient().list(scopeOf(workspaceId));
      if (result.isErr()) return toError("agent_list", startedAt, workspaceId, result.error);
      logToolCall(config, {
        tool: "agent_list",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      const records = result.value;
      const lines = records.length > 0
        ? records.map((record) =>
            `${record.id}  ${record.provider}/${record.profileName}  ${record.status}`
              + (record.latestResponse ? `  ${record.latestResponse.split("\n")[0]?.slice(0, 120)}` : ""),
          ).join("\n")
        : "No background agents for this workspace yet.";
      return {
        content: [textBlock(lines)],
        structuredContent: {
          result: contentText([textBlock(lines)]),
          agents: records.map((record) => ({
            agentId: record.id,
            status: record.status,
            provider: record.provider,
            profileName: record.profileName,
          })),
        },
      };
    },
  );

  target.registerTool(
    "fleet_status",
    {
      title: "Fleet status",
      description:
        "Show the effective delegation fleet for this workspace: global lanes plus the approved project overlay, with trust state. Project lanes apply only after fleet_approve.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema(),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const gate = checkAgentsAllowed(workspaceId);
      if (gate) return blocked(gate);
      const scope = scopeOf(workspaceId);
      const project = await loadProjectFleet(scope.workspaceRoot, config.stateDir);
      const lanes = effectiveLanes(config.fleet, project);
      const lines = lanes.length > 0
        ? lanes.map((lane) =>
            `${lane.name} -> ${lane.provider} [${lane.source}]`
            + (lane.model ? ` model=${lane.model}` : "")
            + (lane.effort ? ` effort=${lane.effort}` : "")
            + (lane.writeMode ? ` write=${lane.writeMode}` : "")
            + (lane.timeoutMs ? ` timeout=${Math.round(lane.timeoutMs / 60000)}m` : ""),
          ).join("\n")
        : "No fleet lanes configured.";
      const trust = project.present
        ? (project.trusted ? "Project overlay: approved." : `Project overlay: NOT approved (${project.error ?? "untrusted"}).`)
        : "Project overlay: none.";
      const result = `${lines}\n\n${trust}`;
      logToolCall(config, { tool: "fleet_status", workspaceId, success: true, durationMs: Math.round(performance.now() - startedAt) });
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          lanes: lanes.map((lane) => ({ name: lane.name, provider: lane.provider, source: lane.source })),
          projectTrusted: !project.present || project.trusted,
        },
      };
    },
  );

  target.registerTool(
    "fleet_approve",
    {
      title: "Approve project fleet",
      description:
        "Approve the current content of this workspace's project fleet file (.hearth/fleet.json) after reviewing it. Any later edit invalidates the approval until re-approved.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const gate = checkAgentsAllowed(workspaceId);
      if (gate) return blocked(gate);
      const scope = scopeOf(workspaceId);
      const approved = await approveProjectFleet(scope.workspaceRoot, config.stateDir);
      logToolCall(config, {
        tool: "fleet_approve",
        workspaceId,
        success: approved.ok,
        durationMs: Math.round(performance.now() - startedAt),
        ...(!approved.ok ? { error: approved.error } : {}),
      });
      if (!approved.ok) {
        return {
          content: [textBlock(approved.error)],
          isError: true as const,
          structuredContent: { result: approved.error },
        };
      }
      const result = "Project fleet file approved for its current content. Future edits require re-approval.";
      return { content: [textBlock(result)], structuredContent: { result } };
    },
  );
}
