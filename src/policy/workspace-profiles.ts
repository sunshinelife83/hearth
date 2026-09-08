import { isPathInsideRoot } from "../roots.js";
import type { ExecutionConfig, ServerConfig, WorkspaceProfileConfig } from "../config.js";

/**
 * Per-workspace security profiles (round-3 hardening).
 *
 * Global execution settings are the default; a workspace profile matched by
 * longest-path-prefix overrides them for that workspace only. One workspace
 * being autonomous never grants autonomy to another.
 */

export interface ResolvedExecution {
  mode: ExecutionConfig["mode"];
  sandbox: NonNullable<WorkspaceProfileConfig["sandbox"]> | undefined;
  sandboxNetwork: NonNullable<WorkspaceProfileConfig["sandboxNetwork"]> | undefined;
  requireSandboxForAutonomous: boolean;
  commandAllow: string[];
  commandDeny: string[];
  agentsAllowed: boolean;
  profilePath?: string;
}

export function resolveExecutionForWorkspace(
  config: ServerConfig,
  workspaceRoot: string,
): ResolvedExecution {
  let best: WorkspaceProfileConfig | undefined;
  for (const profile of config.workspaceProfiles) {
    if (!isPathInsideRoot(workspaceRoot, profile.path)) continue;
    if (!best || profile.path.length > best.path.length) best = profile;
  }

  return {
    mode: best?.mode ?? config.execution.mode,
    sandbox: best?.sandbox,
    sandboxNetwork: best?.sandboxNetwork,
    requireSandboxForAutonomous: best?.requireSandboxForAutonomous ?? config.execution.requireSandboxForAutonomous,
    commandAllow: best?.commandAllow ?? [],
    commandDeny: best?.commandDeny ?? [],
    agentsAllowed: best?.agentsAllowed ?? true,
    ...(best ? { profilePath: best.path } : {}),
  };
}

/** Regex allow/deny command lists from the matched profile. */
export function commandListVerdict(
  resolved: ResolvedExecution,
  command: string,
): { allowed: boolean; rule?: string } {
  for (const pattern of resolved.commandDeny) {
    try {
      if (new RegExp(pattern).test(command)) {
        return { allowed: false, rule: `workspace commandDeny: /${pattern}/` };
      }
    } catch {
      // Invalid user regex: skip rather than fail open silently? Fail closed.
      return { allowed: false, rule: `workspace commandDeny has invalid regex: /${pattern}/` };
    }
  }
  if (resolved.commandAllow.length > 0) {
    for (const pattern of resolved.commandAllow) {
      try {
        if (new RegExp(pattern).test(command)) return { allowed: true };
      } catch {
        return { allowed: false, rule: `workspace commandAllow has invalid regex: /${pattern}/` };
      }
    }
    return { allowed: false, rule: "command not in workspace commandAllow list" };
  }
  return { allowed: true };
}
