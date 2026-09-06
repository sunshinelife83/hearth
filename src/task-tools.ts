import * as z from "zod/v4";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import type { ServerConfig } from "./config.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { ProcessSessionManager, ProcessSnapshot } from "./process-sessions.js";
import { TaskStore, TaskTransitionError, type TaskEvidenceEntry } from "./task-store.js";
import type { VerificationGateResult } from "./verification.js";
import { detectVerificationGates, tailOutput, type VerificationGate, type VerificationResult } from "./verification.js";
import { classifyCommand, decideExecution } from "./policy/command-policy.js";
import { logEvent, commandPreview } from "./logger.js";
import { logToolCall, resultOutputSchema, textBlock } from "./tool-surfaces/shared.js";
import { workspaceIdDescription } from "./tool-surfaces/types.js";

/**
 * Task tools: the Agent Runtime's MCP surface. The driving AI client moves a
 * durable task through plan → execute → verify → repair; completion is a
 * system verdict (verified_complete), never just a model claim.
 */

const DEFAULT_TASK_BUDGET_MS = 30 * 60 * 1000;
const GATE_POLL_MS = 30_000;
const MAX_GATE_WALL_MS = 10 * 60 * 1000;

export interface TaskToolContext {
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  processSessions: ProcessSessionManager;
  taskStore: TaskStore;
}

interface GateFailure {
  gate: string;
  exitCode?: number;
  outputTail: string;
}

export function registerTaskTools(target: McpRegistrationTarget, context: TaskToolContext): void {
  const { config, workspaces, processSessions, taskStore } = context;

  const taskOutputSchema = resultOutputSchema({
    taskId: z.string(),
    status: z.string(),
    completionState: z.string().optional(),
  });

  const evidenceLines = (entries: TaskEvidenceEntry[], limit = 8): string =>
    entries.slice(-limit).map((entry) => `- [${entry.kind}] ${entry.summary}`).join("\n");

  const taskText = (record: ReturnType<TaskStore["get"]> & {}, extra?: string): string => {
    const lines = [
      `Task ${record.id} — ${record.status}${record.completionState ? ` (${record.completionState})` : ""}.`,
      `Goal: ${record.goal}`,
      record.plan?.length ? `Plan:\n${record.plan.map((step, index) => `${index + 1}. ${step}`).join("\n")}` : undefined,
      record.error ? `Error: ${record.error}` : undefined,
      record.evidence.length > 0 ? `Evidence:\n${evidenceLines(record.evidence)}` : undefined,
      extra,
    ].filter(Boolean);
    return lines.join("\n\n");
  };

  const structuredTask = (record: NonNullable<ReturnType<TaskStore["get"]>>) => ({
    result: taskText(record),
    taskId: record.id,
    status: record.status,
    ...(record.completionState ? { completionState: record.completionState } : {}),
  });

  const assertBudget = (taskId: string): void => {
    const record = taskStore.get(taskId);
    if (!record) throw new Error(`Unknown task: ${taskId}`);
    const age = Date.now() - Date.parse(record.createdAt);
    if (age > DEFAULT_TASK_BUDGET_MS) {
      taskStore.transition(taskId, "failed", {
        error: `Task budget exceeded (${Math.round(age / 60000)} minutes).`,
      });
      throw new Error(`Task ${taskId} exceeded its wall-clock budget and was marked failed.`);
    }
  };

  /** Run one gate command under the policy gate, waiting for completion. */
  const runGate = async (workspaceId: string, cwd: string, gate: VerificationGate): Promise<VerificationGateResult> => {
    const startedAt = performance.now();
    const classification = classifyCommand(gate.command);
    const decision = decideExecution({ mode: config.execution.mode, tier: classification.tier });
    logEvent(config.logging, decision.decision === "allow" ? "info" : "warn", "policy_decision", {
      tool: "task_verify",
      workspaceId,
      tier: classification.tier,
      rules: classification.rules,
      decision: decision.decision,
      mode: config.execution.mode,
      commandPreview: commandPreview(gate.command),
    });
    if (decision.decision !== "allow") {
      return {
        name: gate.name,
        command: gate.command,
        kind: gate.kind,
        passed: false,
        outputTail: `Policy ${decision.decision}: ${decision.reason}`,
        durationMs: Math.round(performance.now() - startedAt),
      };
    }

    let snapshot = await processSessions.start({
      workspaceId,
      command: gate.command,
      cwd,
      yieldTimeMs: GATE_POLL_MS,
      maxOutputTokens: 4000,
    });
    const deadline = Date.now() + MAX_GATE_WALL_MS;
    while (snapshot.running && Date.now() < deadline) {
      snapshot = await processSessions.write({
        workspaceId,
        sessionId: snapshot.sessionId!,
        chars: "",
        yieldTimeMs: GATE_POLL_MS,
        maxOutputTokens: 4000,
      });
    }
    const failedToFinish = snapshot.running;
    if (failedToFinish) {
      processSessions.terminate(workspaceId, snapshot.sessionId!);
    }
    return {
      name: gate.name,
      command: gate.command,
      kind: gate.kind,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      passed: !failedToFinish && snapshot.exitCode === 0,
      outputTail: tailOutput(snapshot.output || (failedToFinish ? "gate timed out and was terminated" : "")),
      durationMs: Math.round(performance.now() - startedAt),
    };
  };

  const runVerification = async (input: {
    workspaceId: string;
    workspaceRoot: string;
    taskId: string;
    explicitGates?: VerificationGate[];
  }): Promise<VerificationResult> => {
    const gates = input.explicitGates?.length
      ? input.explicitGates
      : detectVerificationGates(input.workspaceRoot);
    const results: VerificationGateResult[] = [];
    for (const gate of gates) {
      const result = await runGate(input.workspaceId, input.workspaceRoot, gate);
      results.push(result);
      taskStore.appendEvidence(input.taskId, {
        ts: new Date().toISOString(),
        kind: "verification",
        summary: `gate ${result.name}: ${result.passed ? "passed" : "FAILED"} (exit ${result.exitCode ?? "signal"})`,
        details: { command: result.command, outputTail: result.outputTail },
      });
    }
    return { passed: results.length > 0 && results.every((result) => result.passed), gates: results };
  };

  const failuresOf = (result: VerificationResult): GateFailure[] =>
    result.gates.filter((gate) => !gate.passed)
      .map((gate) => ({ gate: gate.name, exitCode: gate.exitCode, outputTail: gate.outputTail }));

  const workspaceOf = (workspaceId: string) => workspaces.getWorkspace(workspaceId);

  /**
   * Anti-bypass rule: once a gate has failed for a task it stays in the
   * verification set until it passes, so a completion claim can never
   * satisfy itself with a narrower or easier gate list.
   */
  function mergeWithPreviouslyFailedGates(
    current: { evidence: { ts: string; kind: string; summary: string; details?: unknown }[] },
    explicit: Array<{ name: string; command: string }> | undefined,
  ): Array<{ name: string; command: string }> | undefined {
    const failed = new Map<string, { name: string; command: string }>();
    for (const entry of current.evidence) {
      if (entry.kind !== "verification" || !entry.summary.includes("FAILED")) continue;
      const details = entry.details as { command?: string } | undefined;
      const command = details?.command;
      const name = entry.summary.slice("gate ".length).split(":")[0]?.trim();
      if (command && name) failed.set(command, { name, command });
    }
    if (failed.size === 0) return explicit;
    const merged = new Map(failed);
    for (const gate of explicit ?? []) merged.set(gate.command, gate);
    return [...merged.values()];
  }

  target.registerTool(
    "task_create",
    {
      title: "Create task",
      description:
        "Create a durable engineering task for this workspace with a goal contract. The task state machine (planning → executing → verifying → repair → completed) is the system's source of truth; completion requires verification evidence, not just a model claim.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        goal: z.string().min(1).max(8000).describe("What must be true when this task is done."),
      },
      outputSchema: taskOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspaceId, goal }) => {
      const workspace = workspaceOf(workspaceId);
      const record = taskStore.create({
        workspaceId,
        workspaceRoot: workspace.root,
        goal,
        mode: config.execution.mode === "readonly" ? "readonly" : config.execution.mode,
      });
      logToolCall(config, { tool: "task_create", workspaceId, success: true, durationMs: 0 });
      return {
        content: [textBlock(taskText(record))],
        structuredContent: structuredTask(record),
      };
    },
  );

  target.registerTool(
    "task_plan",
    {
      title: "Set task plan",
      description:
        "Record the execution plan for a planning-stage task and move it to executing. One concrete step per entry, in order.",
      inputSchema: {
        taskId: z.string().min(1),
        steps: z.array(z.string().min(1)).min(1).max(50).describe("Ordered plan steps."),
      },
      outputSchema: taskOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ taskId, steps }) => {
      assertBudget(taskId);
      const record = taskStore.transition(taskId, "executing", { plan: steps });
      logToolCall(config, { tool: "task_plan", success: true, durationMs: 0 });
      return {
        content: [textBlock(taskText(record))],
        structuredContent: structuredTask(record),
      };
    },
  );

  target.registerTool(
    "task_status",
    {
      title: "Task status",
      description: "Fetch a task's state machine status, plan, and evidence trail.",
      inputSchema: { taskId: z.string().min(1) },
      outputSchema: taskOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ taskId }) => {
      const record = taskStore.get(taskId);
      if (!record) return taskNotFound(taskId);
      return {
        content: [textBlock(taskText(record))],
        structuredContent: structuredTask(record),
      };
    },
  );

  target.registerTool(
    "task_list",
    {
      title: "List tasks",
      description: "List tasks recorded for this workspace.",
      inputSchema: { workspaceId: z.string().describe(workspaceIdDescription) },
      outputSchema: resultOutputSchema(),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      workspaceOf(workspaceId);
      const records = taskStore.list({ workspaceId });
      const lines = records.length > 0
        ? records.map((record) => `${record.id}  ${record.status}${record.completionState ? ` (${record.completionState})` : ""}  ${record.goal.split("\n")[0]?.slice(0, 100)}`).join("\n")
        : "No tasks for this workspace yet.";
      return {
        content: [textBlock(lines)],
        structuredContent: {
          result: lines,
          tasks: records.map((record) => ({ taskId: record.id, status: record.status })),
        },
      };
    },
  );

  target.registerTool(
    "task_verify",
    {
      title: "Verify task",
      description:
        "Run the workspace's verification gates (tests, typecheck, build — auto-detected or explicit) and record the evidence. Passing gates move the task toward completion; failures move it to repairing with the failing output.",
      inputSchema: {
        taskId: z.string().min(1),
        gates: z.array(z.object({
          name: z.string().min(1),
          command: z.string().min(1),
        })).max(10).optional().describe("Explicit gates; defaults to auto-detected ones."),
      },
      outputSchema: taskOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ taskId, gates }) => {
      assertBudget(taskId);
      const current = taskStore.get(taskId);
      if (!current) return taskNotFound(taskId);
      let record;
      try {
        record = taskStore.transition(taskId, "verifying");
      } catch (error) {
        return transitionError(error, taskId);
      }
      void record;

      const verification = await runVerification({
        workspaceId: current.workspaceId ?? "",
        workspaceRoot: current.workspaceRoot,
        taskId,
        explicitGates: mergeWithPreviouslyFailedGates(current, gates)?.map((gate) => ({ ...gate, kind: "custom" as const })),
      });
      taskStore.countToolCall(taskId);

      if (!verification.passed) {
        const failures = failuresOf(verification);
        const failed = taskStore.transition(taskId, "repairing", {
          error: `Verification failed: ${failures.map((failure) => failure.gate).join(", ")}`,
        });
        const extra = `Verification FAILED. Fix the failures, then call task_verify again.\n${
          failures.map((failure) => `— ${failure.gate} (exit ${failure.exitCode ?? "?"})\n${failure.outputTail}`).join("\n\n")
        }`;
        return {
          content: [textBlock(taskText(failed, extra))],
          structuredContent: { ...structuredTask(failed), result: taskText(failed, extra) },
        };
      }

      const completed = taskStore.transition(taskId, "completed", { completionState: "verified_complete" });
      return {
        content: [textBlock(taskText(completed, "System verified: all gates passed."))],
        structuredContent: structuredTask(completed),
      };
    },
  );

  target.registerTool(
    "task_complete",
    {
      title: "Complete task",
      description:
        "Claim a task complete. The claim alone is never trusted: verification gates run first and only a passing run marks the task verified_complete. With no detected gates, pass acceptUnverified to explicitly record a model_complete verdict (audited as unverified).",
      inputSchema: {
        taskId: z.string().min(1),
        acceptUnverified: z
          .boolean()
          .optional()
          .describe("Explicitly mark the task model_complete when no verification gates exist."),
      },
      outputSchema: taskOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ taskId, acceptUnverified }) => {
      assertBudget(taskId);
      const current = taskStore.get(taskId);
      if (!current) return taskNotFound(taskId);
      if (current.status === "planning") {
        return {
          content: [textBlock(`Task ${taskId} is still planning. Provide a plan (task_plan) and do the work before completing.`)],
          isError: true,
          structuredContent: { result: `Task ${taskId} is still planning.`, taskId, status: current.status },
        };
      }
      if (current.status === "repairing") {
        // Failed-gate evidence exists; a fresh claim must not swap in an
        // easier gate set. The failing gates themselves must pass again.
        return {
          content: [textBlock(
            `Task ${taskId} is in repairing: earlier verification gates failed. ` +
            `Repair the failures and call task_verify (it re-runs the failing gates); completion claims are rejected until they pass.`,
          )],
          isError: true,
          structuredContent: { result: `Task ${taskId} is in repairing; use task_verify.`, taskId, status: current.status },
        };
      }

      const detected = detectVerificationGates(current.workspaceRoot);
      if (detected.length === 0 && acceptUnverified !== true) {
        return {
          content: [textBlock(
            `No verification gates were detected for this workspace, so the claim cannot be verified. ` +
            `Run explicit gates via task_verify with a gates list, or pass acceptUnverified=true to record an explicitly unverified (model_complete) verdict.`,
          )],
          isError: true,
          structuredContent: { result: "No verification gates available.", taskId, status: current.status },
        };
      }

      try {
        taskStore.transition(taskId, "verifying");
      } catch (error) {
        return transitionError(error, taskId);
      }

      taskStore.appendEvidence(taskId, {
        ts: new Date().toISOString(),
        kind: "model_claim",
        summary: "model claimed completion",
      });

      if (detected.length === 0) {
        const completed = taskStore.transition(taskId, "completed", { completionState: "model_complete" });
        return {
          content: [textBlock(taskText(completed, "Marked model_complete (explicitly unverified — no gates were available)."))],
          structuredContent: structuredTask(completed),
        };
      }

      const verification = await runVerification({
        workspaceId: current.workspaceId ?? "",
        workspaceRoot: current.workspaceRoot,
        taskId,
      });
      taskStore.countToolCall(taskId);

      if (!verification.passed) {
        const failures = failuresOf(verification);
        const failed = taskStore.transition(taskId, "repairing", {
          error: `Verification failed: ${failures.map((failure) => failure.gate).join(", ")}`,
        });
        const extra = `Completion rejected: gates failed. Repair, then task_verify.\n${
          failures.map((failure) => `— ${failure.gate} (exit ${failure.exitCode ?? "?"})\n${failure.outputTail}`).join("\n\n")
        }`;
        return {
          content: [textBlock(taskText(failed, extra))],
          structuredContent: { ...structuredTask(failed), result: taskText(failed, extra) },
        };
      }

      const completed = taskStore.transition(taskId, "completed", { completionState: "verified_complete" });
      return {
        content: [textBlock(taskText(completed, "System verified: all gates passed."))],
        structuredContent: structuredTask(completed),
      };
    },
  );

  target.registerTool(
    "task_cancel",
    {
      title: "Cancel task",
      description: "Cancel an unfinished task (terminal).",
      inputSchema: { taskId: z.string().min(1) },
      outputSchema: taskOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ taskId }) => {
      const record = taskStore.get(taskId);
      if (!record) return taskNotFound(taskId);
      try {
        const cancelled = taskStore.transition(taskId, "cancelled", { error: "Cancelled by client." });
        return { content: [textBlock(taskText(cancelled))], structuredContent: structuredTask(cancelled) };
      } catch (error) {
        return transitionError(error, taskId);
      }
    },
  );

  function taskNotFound(taskId: string) {
    return {
      content: [textBlock(`Unknown task: ${taskId}`)],
      isError: true as const,
      structuredContent: { result: `Unknown task: ${taskId}` },
    };
  }

  function transitionError(error: unknown, taskId: string) {
    if (error instanceof TaskTransitionError) {
      return {
        content: [textBlock(`${error.message}. Use task_status to see the current state.`)],
        isError: true as const,
        structuredContent: { result: error.message, taskId },
      };
    }
    throw error;
  }
}

export type { ProcessSnapshot };
