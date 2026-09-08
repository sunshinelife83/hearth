import { resolve } from "node:path";
import { isPathInsideRoot } from "../roots.js";

/**
 * Concurrent-write protection for multi-agent delegation (orchestration).
 *
 * Sequential-by-default: two running delegations on overlapping file scopes
 * in the same workspace are rejected unless the caller explicitly opts into
 * concurrent writes. Scopes are resolved against the workspace root; paths
 * escaping the workspace are rejected. This is a best-effort guard inside one
 * server process (the daemon is the source of truth for liveness); races
 * across processes fail toward the policy engine and sandbox, never away.
 */

export interface ScopeOwner {
  agentId: string;
  workspaceId: string;
  scopePaths: string[];
}

/** Resolve scope paths against the root; rejects workspace escapes. */
export function normalizeScopePaths(
  workspaceRoot: string,
  scopePaths?: string[],
): { ok: true; paths: string[] } | { ok: false; error: string } {
  const raw = scopePaths && scopePaths.length > 0 ? scopePaths : [workspaceRoot];
  if (raw.length > 20) return { ok: false, error: "At most 20 scopePaths per delegation." };
  const resolved: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return { ok: false, error: "scopePaths must be non-empty path strings." };
    }
    const full = resolve(workspaceRoot, entry);
    if (!isPathInsideRoot(full, workspaceRoot)) {
      return { ok: false, error: `scopePath escapes the workspace: ${JSON.stringify(entry)}.` };
    }
    resolved.push(full);
  }
  return { ok: true, paths: [...new Set(resolved)] };
}

/** Two scopes overlap when either resolved path contains the other. */
export function scopesOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => isPathInsideRoot(x, y) || isPathInsideRoot(y, x)));
}

export interface ActiveAgent {
  id: string;
  status: string;
}

/** Terminal states release their scope; everything else keeps owning it. */
export function ownsScope(status: string): boolean {
  return status !== "stopped" && status !== "error";
}

export interface OverlapGuard {
  /** Record a successfully started delegation. */
  track(owner: ScopeOwner): void;
  /** Release on terminal observation (stop/cancel/status/output). */
  release(agentId: string): void;
  /**
   * Fail-closed conflict check: returns the conflicting agentId, or undefined
   * when the scope is free. Stale entries (agent gone from the backend) are
   * dropped and do not block.
   */
  check(
    workspaceId: string,
    scopePaths: string[],
    listActive: (workspaceId: string) => Promise<ActiveAgent[]>,
  ): Promise<string | undefined>;
}

export function createOverlapGuard(): OverlapGuard {
  const owners = new Map<string, ScopeOwner>();
  return {
    track(owner) {
      owners.set(owner.agentId, owner);
    },
    release(agentId) {
      owners.delete(agentId);
    },
    async check(workspaceId, scopePaths, listActive) {
      let active: ActiveAgent[];
      try {
        active = await listActive(workspaceId);
      } catch {
        // Backend unreachable: do not invent a conflict, do not block.
        return undefined;
      }
      const live = new Set(active.filter((agent) => ownsScope(agent.status)).map((agent) => agent.id));
      for (const [agentId, owner] of [...owners]) {
        if (!live.has(agentId)) {
          owners.delete(agentId);
          continue;
        }
        if (owner.workspaceId !== workspaceId) continue;
        if (scopesOverlap(owner.scopePaths, scopePaths)) return agentId;
      }
      return undefined;
    },
  };
}
