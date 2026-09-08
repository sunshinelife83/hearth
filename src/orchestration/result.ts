import { git } from "../git.js";

/**
 * Structured delegation results (orchestration layer).
 *
 * The implementer's self-report is never trusted on its own. The durable,
 * system-observed facts are: the process outcome (via the agent record) and
 * the working-tree diff scope (`touchedFiles` from `git status`, same
 * contract as the reference relay: `null` when git cannot report, `[]` when
 * the tree is clean). These feed task evidence and reviewer responses.
 */

export interface TouchedFiles {
  /** `git status --porcelain` lines, capped. Null when git cannot report. */
  files: string[] | null;
  truncated: boolean;
}

const MAX_TOUCHED_FILES = 50;

/** Best-effort touched-files collection. Never throws. */
export async function collectTouchedFiles(workspaceRoot: string): Promise<TouchedFiles> {
  try {
    const { stdout } = await git(workspaceRoot, ["status", "--porcelain"]);
    const lines = stdout.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
    return {
      files: lines.slice(0, MAX_TOUCHED_FILES),
      truncated: lines.length > MAX_TOUCHED_FILES,
    };
  } catch {
    return { files: null, truncated: false };
  }
}

export function formatTouchedFiles(touched: TouchedFiles): string {
  if (touched.files === null) return "touched files: unknown (not a git checkout or git unavailable)";
  if (touched.files.length === 0) return "touched files: none (clean tree)";
  const suffix = touched.truncated ? ` (+more, capped at ${MAX_TOUCHED_FILES})` : "";
  return `touched files:\n${touched.files.map((file) => `  ${file}`).join("\n")}${suffix}`;
}

export interface AgentResultEvidence {
  summary: string;
  details: {
    agentId: string;
    provider: string;
    profileName: string;
    status: string;
    touchedFiles: string[] | null;
    finalExcerpt: string;
    correlationId?: string;
  };
}

/** Marker prefix used to dedupe repeated terminal-state observations. */
export const AGENT_RESULT_MARKER = "agent_result";

export function buildAgentResultEvidence(input: {
  agentId: string;
  provider: string;
  profileName: string;
  status: string;
  touched: TouchedFiles;
  finalResponse: string;
  correlationId?: string;
}): AgentResultEvidence {
  const excerpt = input.finalResponse.slice(0, 500);
  const touchSummary = input.touched.files === null
    ? "diff scope unknown"
    : input.touched.files.length === 0
      ? "clean tree"
      : `${input.touched.files.length} file(s)${input.touched.truncated ? " (capped)" : ""}`;
  return {
    summary: `${AGENT_RESULT_MARKER} ${input.agentId} ${input.status}: ${touchSummary}`,
    details: {
      agentId: input.agentId,
      provider: input.provider,
      profileName: input.profileName,
      status: input.status,
      touchedFiles: input.touched.files,
      finalExcerpt: excerpt,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    },
  };
}
