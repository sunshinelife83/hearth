import * as z from "zod/v4";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpRegistrationTarget } from "../mcp-modern-server.js";
import type { ServerConfig } from "../config.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { buildRepoMap, formatRepoMap } from "./repo-map.js";
import { logToolCall, resultOutputSchema, textBlock } from "../tool-surfaces/shared.js";
import { workspaceIdDescription } from "../tool-surfaces/types.js";

/**
 * Context tools (P6, first slice): a repository overview and a bounded
 * text search. Both are read-only, run locally, and hand the model curated
 * repository knowledge instead of forcing it to shell its way around.
 */

const execFileAsync = promisify(execFile);

let ripgrepAvailable: boolean | undefined;

function hasRipgrep(): boolean {
  ripgrepAvailable ??= (() => {
    try {
      execFileSyncShort("rg", ["--version"]);
      return true;
    } catch {
      return false;
    }
  })();
  return ripgrepAvailable;
}

function execFileSyncShort(command: string, args: string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  execFileSync(command, args, { stdio: "ignore", timeout: 5000 });
}

const MAX_SEARCH_OUTPUT_CHARS = 40_000;

export interface ContextToolContext {
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
}

export function registerContextTools(target: McpRegistrationTarget, context: ContextToolContext): void {
  const { config, workspaces } = context;

  target.registerTool(
    "context_overview",
    {
      title: "Repository overview",
      description:
        "Get a bounded repository map for the workspace: file counts, languages, manifests, and the largest directories. Use this before exploring a large repository so you stop guessing where things live.",
      inputSchema: { workspaceId: z.string().describe(workspaceIdDescription) },
      outputSchema: resultOutputSchema(),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const map = await buildRepoMap(workspace.root);
      const text = formatRepoMap(map);
      logToolCall(config, {
        tool: "context_overview",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(text)],
        structuredContent: {
          result: text,
          totalFiles: map.totalFiles,
          truncated: map.truncated,
          manifests: map.manifests,
          languages: map.languages,
        },
      };
    },
  );

  target.registerTool(
    "search",
    {
      title: "Search workspace",
      description:
        "Search file contents in the workspace with a regex (ripgrep when available, grep fallback). Read-only and bounded; prefer this over shell grep pipelines.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        pattern: z.string().min(1).max(500).describe("Regular expression to find."),
        glob: z.string().max(200).optional().describe("Optional glob filter, e.g. '*.ts'."),
        maxResults: z.number().int().min(1).max(500).optional().describe("Result line cap. Defaults to 100."),
      },
      outputSchema: resultOutputSchema(),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, pattern, glob, maxResults }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cap = maxResults ?? 100;
      let text: string;
      try {
        text = await runSearch(workspace.root, pattern, glob, cap);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall(config, {
          tool: "search",
          workspaceId,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message.slice(0, 200),
        });
        return {
          content: [textBlock(`Search failed: ${message}`)],
          isError: true as const,
          structuredContent: { result: `Search failed: ${message}` },
        };
      }
      logToolCall(config, {
        tool: "search",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(text)],
        structuredContent: { result: text },
      };
    },
  );
}

async function runSearch(root: string, pattern: string, glob: string | undefined, cap: number): Promise<string> {
  const args = hasRipgrep()
    ? [
        "rg", "--no-heading", "-n", "-S",
        "--max-count", String(Math.min(cap, 500)),
        "--glob", "!node_modules/**", "--glob", "!.git/**",
        ...(glob ? ["-g", glob] : []),
        pattern, root,
      ]
    : [
        "grep", "-rn", "-E", "-I",
        "--exclude-dir=node_modules", "--exclude-dir=.git",
        ...(glob ? [`--include=${glob}`] : []),
        pattern, root,
      ];

  const argv = args.slice(1);
  const command = args[0];
  try {
    const { stdout } = await execFileAsync(command, argv, {
      cwd: root,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return bound(String(stdout), cap);
  } catch (error) {
    const err = error as { code?: number; stdout?: Buffer | string };
    // grep/rg exit 1 on "no matches" — that is a successful empty search.
    if (err.code === 1) return "No matches.";
    if (typeof err.stdout === "string" && err.stdout) return bound(err.stdout, cap);
    throw error;
  }
}

function bound(output: string, cap: number): string {
  const lines = output.split("\n").filter((line) => line.trim().length > 0).slice(0, cap);
  let text = lines.join("\n");
  if (text.length > MAX_SEARCH_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_SEARCH_OUTPUT_CHARS)}\n…output truncated`;
  }
  return text || "No matches.";
}
