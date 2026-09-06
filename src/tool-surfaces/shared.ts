import * as z from "zod/v4";
import { logEvent, commandPreview } from "../logger.js";
import type { ServerConfig } from "../config.js";
import {
  classifyCommand,
  decideExecution,
  type CommandClassification,
  type CommandTier,
  type ExecutionDecision,
} from "../policy/command-policy.js";
import { createSnapshot } from "../snapshot-manager.js";
import {
  WORKSPACE_APP_URI,
  type DiffStats,
  type ToolContent,
  type ToolLogFields,
  type ToolWidgetDescriptorMeta,
} from "./types.js";

export interface ShellPolicyVerdict {
  /** Defined when the command must not run; return it as the tool result. */
  denial?: {
    content: ToolContent[];
    isError: true;
    structuredContent: Record<string, unknown>;
  };
  classification: CommandClassification;
  decision: ExecutionDecision;
}

/**
 * Policy gate for model-invoked shell commands. Every shell tool call passes
 * through here before any process is spawned. Returns a denial response or
 * the verdict allowing execution (with classification for audit/snapshot use).
 */
export function enforceShellPolicy(
  config: ServerConfig,
  fields: { tool: string; workspaceId: string; command: string },
  approvedByUser: boolean | undefined,
): ShellPolicyVerdict {
  const classification = classifyCommand(fields.command);
  const decision = decideExecution({
    mode: config.execution.mode,
    tier: classification.tier,
    approvedByUser,
  });

  logEvent(config.logging, decision.decision === "allow" ? "info" : "warn", "policy_decision", {
    tool: fields.tool,
    workspaceId: fields.workspaceId,
    tier: classification.tier,
    rules: classification.rules,
    decision: decision.decision,
    mode: config.execution.mode,
    approvalClaimed: decision.approvalClaimed ?? (approvedByUser === true && classification.tier >= 2),
    commandPreview: commandPreview(fields.command),
  });

  if (decision.decision === "allow") {
    return { classification, decision };
  }

  return {
    classification,
    decision,
    denial: {
      content: [{ type: "text", text: decision.reason }],
      isError: true,
      structuredContent: {
        result: decision.reason,
        policy: {
          decision: decision.decision,
          tier: classification.tier as CommandTier,
          rules: classification.rules,
          mode: config.execution.mode,
        },
      },
    },
  };
}

/**
 * Best-effort snapshot before autonomous tier-2 execution. Best-effort by
 * decision (ADR-006a): a non-Git workspace or a snapshot failure logs a
 * warning and continues, because blocking every autonomous command on
 * snapshot availability would make the mode unusable outside git repos.
 */
export async function snapshotBeforeRiskyExecution(
  config: ServerConfig,
  workspace: { id: string; root: string },
  command: string,
): Promise<void> {
  if (config.execution.mode !== "autonomous") return;
  if (classifyCommand(command).tier < 2) return;

  try {
    const snapshot = await createSnapshot({
      root: workspace.root,
      workspaceId: workspace.id,
      label: `pre-tier2 ${commandPreview(command)}`,
    });
    logEvent(config.logging, "info", "snapshot_created", {
      workspaceId: workspace.id,
      snapshotId: snapshot.snapshotId,
      reason: "autonomous_tier2",
      commandPreview: commandPreview(command),
    });
  } catch (error) {
    logEvent(config.logging, "warn", "snapshot_failed", {
      workspaceId: workspace.id,
      reason: error instanceof Error ? error.message : String(error),
      commandPreview: commandPreview(command),
    });
  }
}

export function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

export function workspaceAppDescriptorMeta(config: ServerConfig): ToolWidgetDescriptorMeta {
  if (!config.uiEnabled) return { _meta: {} };

  return {
    _meta: {
      ui: {
        resourceUri: WORKSPACE_APP_URI,
        visibility: ["model"],
      },
    },
  };
}

export function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview:
      config.logging.shellCommands && command
        ? commandPreview(command)
        : undefined,
  });
}

export async function runLoggedToolOperation<T>(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  startedAt: number,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const result = await operation();
    logToolCall(config, {
      ...fields,
      success: true,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return result;
  } catch (error) {
    logToolCall(config, {
      ...fields,
      success: false,
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

export function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

export function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

export function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}
