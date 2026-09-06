import * as z from "zod/v4";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import { createLocalAgentClient, type LocalAgentClient } from "./local-agent-client.js";
import type { RunOverrides } from "./local-agent-manager.js";
import type { LocalAgentRecord } from "./local-agent-store.js";
import type { LocalAgentWorkspaceScope } from "./local-agent-store.js";
import type { ServerConfig } from "./config.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import { logToolCall, resultOutputSchema, textBlock } from "./tool-surfaces/shared.js";
import { workspaceIdDescription } from "./tool-surfaces/types.js";
import { contentText } from "./tool-surfaces/shared.js";

/**
 * MCP surface for DevSpace's local agent lifecycle (correction #5): external
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

interface AgentToolContext {
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
}

export function registerAgentTools(target: McpRegistrationTarget, context: AgentToolContext): void {
  const { config, workspaces } = context;
  let client: LocalAgentClient | undefined;
  const agentClient = (): LocalAgentClient => {
    client ??= createLocalAgentClient(config);
    return client;
  };

  const scopeOf = (workspaceId: string): LocalAgentWorkspaceScope => {
    const workspace = workspaces.getWorkspace(workspaceId);
    return { workspaceId, workspaceRoot: workspace.root };
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
        "Start a background coding agent (provider or profile: codex, claude, opencode, pi, cursor, copilot, grok, or a configured profile name) on this workspace. Returns immediately with an agentId; poll agent_status / agent_output while it runs. Providers must be enabled in DevSpace subagents config.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        target: z.string().min(1).describe("Provider id or configured agent profile name."),
        prompt: z.string().min(1).describe("Task brief for the agent."),
        model: z.string().optional().describe("Optional model override."),
        effort: z.string().optional().describe("Optional reasoning effort override."),
        writeMode: z.enum(["read_only", "allowed", "full_access"]).optional()
          .describe("Workspace write permission for the agent. Defaults to allowed."),
      },
      outputSchema: agentRecordOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const startedAt = performance.now();
      const scope = scopeOf(input.workspaceId);
      const result = await agentClient().start({
        target: input.target,
        prompt: input.prompt,
        workspaceRoot: scope.workspaceRoot,
        workspaceId: input.workspaceId,
        model: input.model,
        effort: input.effort,
        writeMode: input.writeMode,
      });
      if (result.isErr()) return toError("agent_start", startedAt, input.workspaceId, result.error);
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
      const result = await agentClient().get(agentId, scopeOf(workspaceId));
      if (result.isErr()) return toError("agent_status", startedAt, workspaceId, result.error);
      logToolCall(config, {
        tool: "agent_status",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return toResult(result.value);
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
      const result = await agentClient().get(agentId, scopeOf(workspaceId));
      if (result.isErr()) return toError("agent_output", startedAt, workspaceId, result.error);
      logToolCall(config, {
        tool: "agent_output",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return toResult(result.value);
    },
  );

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
      },
      outputSchema: agentRecordOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const startedAt = performance.now();
      const scope = scopeOf(input.workspaceId);
      const result = await agentClient().continue(
        input.agentId,
        input.prompt,
        overridesOf(input) ?? {},
        scope,
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
      },
      outputSchema: agentRecordOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const startedAt = performance.now();
      const scope = scopeOf(input.workspaceId);
      const result = await agentClient().resume(
        input.agentId,
        scope,
        { prompt: input.prompt, overrides: overridesOf(input) },
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
      const result = await agentClient().stopAgent(agentId, scopeOf(workspaceId), { force });
      if (result.isErr()) return toError("agent_stop", startedAt, workspaceId, result.error);
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
      const result = await agentClient().stopAgent(agentId, scopeOf(workspaceId), { force: true });
      if (result.isErr()) return toError("agent_cancel", startedAt, workspaceId, result.error);
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
}
