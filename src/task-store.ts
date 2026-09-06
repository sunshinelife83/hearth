import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

/**
 * Durable task state for the Agent Runtime. The MCP client drives the loop;
 * the state machine below is the system's source of truth for where a task
 * actually is — including the distinction between a model claiming
 * completion and the system verifying it (completionState).
 */

export type TaskStatus =
  | "planning"
  | "executing"
  | "verifying"
  | "repairing"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskCompletionState = "verified_complete" | "model_complete";

export interface TaskEvidenceEntry {
  ts: string;
  kind: "verification" | "model_claim" | "note" | "snapshot";
  summary: string;
  details?: unknown;
}

export interface TaskRecord {
  id: string;
  workspaceId?: string;
  workspaceRoot: string;
  goal: string;
  status: TaskStatus;
  completionState?: TaskCompletionState;
  mode: "supervised" | "autonomous" | "readonly";
  plan?: string[];
  evidence: TaskEvidenceEntry[];
  error?: string;
  toolCalls: number;
  createdAt: string;
  updatedAt: string;
}

/** Allowed transitions; anything else is rejected by the state machine. */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  planning: ["executing", "cancelled"],
  executing: ["verifying", "cancelled", "failed"],
  verifying: ["completed", "repairing", "failed", "cancelled"],
  repairing: ["verifying", "executing", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export class TaskTransitionError extends Error {
  constructor(readonly from: TaskStatus, readonly to: TaskStatus) {
    super(`Illegal task transition: ${from} → ${to}`);
    this.name = "TaskTransitionError";
  }
}

interface TaskRow {
  id: string;
  workspace_id: string | null;
  workspace_root: string;
  goal: string;
  status: string;
  completion_state: string | null;
  mode: string;
  plan: string | null;
  evidence: string | null;
  error: string | null;
  tool_calls: number;
  created_at: string;
  updated_at: string;
}

export interface CreateTaskInput {
  workspaceId?: string;
  workspaceRoot: string;
  goal: string;
  mode?: TaskRecord["mode"];
}

export class TaskStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  create(input: CreateTaskInput): TaskRecord {
    const now = new Date().toISOString();
    const record: TaskRecord = {
      id: `task_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      workspaceId: input.workspaceId,
      workspaceRoot: resolve(input.workspaceRoot),
      goal: input.goal,
      status: "planning",
      mode: input.mode ?? "supervised",
      evidence: [],
      toolCalls: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.database.sqlite
      .prepare(
        `insert into tasks (
          id, workspace_id, workspace_root, goal, status, completion_state,
          mode, plan, evidence, error, tool_calls, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId ?? null,
        record.workspaceRoot,
        record.goal,
        record.status,
        null,
        record.mode,
        null,
        JSON.stringify(record.evidence),
        null,
        0,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  get(id: string): TaskRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from tasks where id = ? limit 1")
      .get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  list(scope: { workspaceId?: string; workspaceRoot?: string } = {}): TaskRecord[] {
    let rows: TaskRow[];
    if (scope.workspaceId) {
      rows = this.database.sqlite
        .prepare("select * from tasks where workspace_id = ? order by updated_at desc")
        .all(scope.workspaceId) as TaskRow[];
    } else if (scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare("select * from tasks where workspace_root = ? order by updated_at desc")
        .all(resolve(scope.workspaceRoot)) as TaskRow[];
    } else {
      rows = this.database.sqlite
        .prepare("select * from tasks order by updated_at desc limit 200")
        .all() as TaskRow[];
    }
    return rows.map(rowToTask);
  }

  /**
   * Applies a guarded transition, appending an evidence entry for the move.
   * Returns the updated record; throws TaskTransitionError on illegal moves.
   */
  transition(
    id: string,
    to: TaskStatus,
    options: {
      evidence?: TaskEvidenceEntry;
      completionState?: TaskCompletionState;
      error?: string;
      plan?: string[];
    } = {},
  ): TaskRecord {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown task: ${id}`);
    if (current.status === to) return current;
    if (!TRANSITIONS[current.status].includes(to)) {
      throw new TaskTransitionError(current.status, to);
    }

    const evidence = [
      ...current.evidence,
      ...(options.evidence
        ? [options.evidence]
        : [{
            ts: new Date().toISOString(),
            kind: "note" as const,
            summary: `status: ${current.status} → ${to}`,
          }]),
    ];

    this.database.sqlite
      .prepare(
        `update tasks set
          status = ?,
          completion_state = ?,
          plan = ?,
          evidence = ?,
          error = ?,
          updated_at = ?
         where id = ?`,
      )
      .run(
        to,
        options.completionState ?? (to === "completed" ? current.completionState ?? null : null),
        options.plan ? JSON.stringify(options.plan) : current.plan ? JSON.stringify(current.plan) : null,
        JSON.stringify(evidence),
        options.error ?? (to === "failed" || to === "cancelled" ? options.error ?? current.error ?? null : null),
        new Date().toISOString(),
        id,
      );
    return this.get(id)!;
  }

  appendEvidence(id: string, entry: TaskEvidenceEntry): TaskRecord {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown task: ${id}`);
    const evidence = [...current.evidence, entry];
    this.database.sqlite
      .prepare("update tasks set evidence = ?, updated_at = ? where id = ?")
      .run(JSON.stringify(evidence), new Date().toISOString(), id);
    return this.get(id)!;
  }

  countToolCall(id: string): void {
    this.database.sqlite
      .prepare("update tasks set tool_calls = tool_calls + 1, updated_at = ? where id = ?")
      .run(new Date().toISOString(), id);
  }

  /**
   * Crash recovery: on boot, tasks that were mid-flight are not magically
   * resumable (their driving client is gone), so they are failed with an
   * explicit reason. Paused agents remain resumable; tasks are recreated or
   * re-planned by the client.
   */
  reconcileOnBoot(): number {
    const result = this.database.sqlite
      .prepare(
        `update tasks
         set status = 'failed',
             error = 'DevSpace restarted while the task was in flight.',
             updated_at = ?
         where status in ('executing', 'verifying', 'repairing')`,
      )
      .run(new Date().toISOString());
    return Number(result.changes);
  }

  close(): void {
    this.database.close();
  }
}

function rowToTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root,
    goal: row.goal,
    status: readStatus(row.status),
    completionState: readCompletionState(row.completion_state),
    mode: readMode(row.mode),
    plan: row.plan ? (safeParseArray(row.plan) as string[]) : undefined,
    evidence: row.evidence ? (safeParseArray(row.evidence) as TaskEvidenceEntry[]) : [],
    error: row.error ?? undefined,
    toolCalls: Number(row.tool_calls ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readStatus(value: string): TaskStatus {
  const allowed: TaskStatus[] = ["planning", "executing", "verifying", "repairing", "completed", "failed", "cancelled"];
  return allowed.includes(value as TaskStatus) ? (value as TaskStatus) : "failed";
}

function readCompletionState(value: string | null): TaskCompletionState | undefined {
  return value === "verified_complete" || value === "model_complete" ? value : undefined;
}

function readMode(value: string): TaskRecord["mode"] {
  return value === "autonomous" || value === "readonly" ? value : "supervised";
}

function safeParseArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
