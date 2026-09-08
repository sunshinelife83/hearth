import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logEvent } from "./logger.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import {
  buildLocalAgentProviderStatuses,
} from "./local-agent-catalog.js";
import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { createMcpServer, type CreateServerOptions } from "./server.js";
import { TaskStore } from "./task-store.js";
import { probeSandboxAdapter, wrapCommandWithSandbox } from "./policy/sandbox.js";
import { resolveExecutionForWorkspace } from "./policy/workspace-profiles.js";
import type { ServerConfig } from "./config.js";

/**
 * Local MCP assembly shared by the stdio transport (`hearth mcp`).
 *
 * stdio has no HTTP surface: the client is a process the user launched on
 * their own machine, so there is no OAuth hop. Everything else — the tool
 * registry, policy gate, workspaces, snapshots, and agent tools — is exactly
 * the HTTP server's surface, by construction.
 */
export interface LocalMcpServer {
  server: ReturnType<typeof createMcpServer>;
  workspaces: WorkspaceRegistry;
  close(): Promise<void>;
}

export function buildLocalMcpServer(
  config: ServerConfig,
  options: CreateServerOptions = {},
): LocalMcpServer {
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const taskStore = new TaskStore(config.stateDir);
  taskStore.reconcileOnBoot();
  const reviewCheckpoints = createReviewCheckpointManager();
  const processJournalDir = `${config.stateDir}/process-journal`;
  void import("./process-journal.js").then(({ reapProcessJournal }) =>
    reapProcessJournal(processJournalDir, (event, details) =>
      logEvent(config.logging, "warn", event, details),
    ).catch(() => undefined),
  ).catch(() => undefined);
  const processSessions = new ProcessSessionManager({
    environment: {
      allowAll: config.execution.envAllowAll,
      extraAllowlist: config.execution.envAllowlist,
    },
    journalDir: processJournalDir,
    ...(config.execution.sandbox === "none" && config.workspaceProfiles.every((profile) => profile.sandbox !== "auto")
      ? {}
      : {
          commandWrapper: (shell, ctx) => {
            const resolved = resolveExecutionForWorkspace(config, ctx.workspaceRoot);
            return wrapCommandWithSandbox(shell, probeSandboxAdapter(), {
              workspaceRoot: ctx.workspaceRoot,
              allowNetwork: (resolved.sandboxNetwork ?? config.execution.sandboxNetwork) === "allow",
            });
          },
        }),
  });
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );
  const server = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    processSessions,
    resolveLocalAgentProviders,
    options.incomingArtifactAdapters ?? [],
    undefined,
    taskStore,
  );

  return {
    server,
    workspaces,
    close: async () => {
      processSessions.shutdown();
      workspaceStore.close?.();
      taskStore.close();
    },
  };
}

/**
 * Run Hearth as a local stdio MCP server. stdout carries only the MCP
 * protocol; human-readable logging goes to stderr.
 */
export async function runStdioServer(config: ServerConfig): Promise<void> {
  const { server, close } = buildLocalMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logEvent(config.logging, "info", "stdio_server_started", {
    allowedRoots: config.allowedRoots,
    mode: config.execution.mode,
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        await server.close();
      } finally {
        await close();
        process.exit(0);
      }
    })();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
