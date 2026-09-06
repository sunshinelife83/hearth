import * as z from "zod/v4";
import { subagentsConfigSchema } from "./local-agent-config.js";

export const DEVSPACE_CONFIG_VERSION = 1 as const;
export const DEVSPACE_CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/Waishnav/devspace/main/schema/v1/devspace.schema.json";

const serverConfigSchema = z.object({
  host: z.string().trim().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65_535).default(7676),
  publicBaseUrl: z.string().url().nullable().default(null),
  allowedHosts: z.array(z.string().trim().min(1)).default([]),
  trustProxy: z.boolean().default(false),
  // "derived": OAuth issuer/base URLs follow publicBaseUrl (today's behavior,
  // required for remote clients like ChatGPT). "local": the issuer is pinned
  // to the local bind address so changing the tunnel URL does not invalidate
  // OAuth clients; only meaningful for local/LAN-only deployments.
  issuerMode: z.enum(["derived", "local"]).default("derived"),
}).strict().prefault({});

const workspacesConfigSchema = z.object({
  allowedRoots: z.array(z.string().trim().min(1)).default([]),
  worktreeRoot: z.string().trim().min(1).default("~/.devspace/worktrees"),
}).strict().prefault({});

const storageConfigSchema = z.object({
  stateDir: z.string().trim().min(1).default("~/.local/share/devspace"),
}).strict().prefault({});

const toolsConfigSchema = z.object({
  mode: z.enum(["claude", "codex"]).default("codex"),
}).strict().prefault({});

const uiConfigSchema = z.object({
  enabled: z.boolean().default(true),
}).strict().prefault({});

const artifactsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxFileBytes: z.number().int().positive().default(100 * 1024 * 1024),
}).strict().prefault({});

const skillsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  paths: z.array(z.string().trim().min(1)).default([]),
  agentDir: z.string().trim().min(1).default("~/.codex"),
}).strict().prefault({});

const loggingConfigSchema = z.object({
  level: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
  format: z.enum(["json", "pretty"]).default("json"),
  requests: z.boolean().default(true),
  assets: z.boolean().default(false),
  toolCalls: z.boolean().default(true),
  shellCommands: z.boolean().default(false),
}).strict().prefault({});

const executionConfigSchema = z.object({
  // Policy mode for model-invoked shell tools:
  // readonly    — tier-0 inspection commands only
  // supervised  — tier 0/1 allowed; tier 2 requires an explicit
  //               user-approval claim (approvedByUser) from the model
  // autonomous  — tier 0/1/2 allowed without approval claims
  // tier 3 commands are blocked in every mode.
  mode: z.enum(["readonly", "supervised", "autonomous"]).default("supervised"),
  // Pass the full parent environment to model-invoked commands. Insecure
  // escape hatch; the default is a conservative allowlist.
  envAllowAll: z.boolean().default(false),
  // Additional environment variable names passed to model-invoked commands.
  envAllowlist: z.array(z.string().trim().min(1)).default([]),
  // OS sandbox for autonomous-mode shell commands and verification gates:
  // "auto" uses bubblewrap (Linux) or seatbelt (macOS) when available.
  sandbox: z.enum(["auto", "none"]).default("auto"),
  sandboxNetwork: z.enum(["allow", "deny"]).default("allow"),
  // When true, autonomous-mode tier-2/3 commands are denied unless a sandbox
  // adapter is actually available (tier 3 is always denied regardless).
  requireSandboxForAutonomous: z.boolean().default(false),
}).strict().prefault({});

const oauthConfigSchema = z.object({
  accessTokenTtlSeconds: z.number().int().positive().default(60 * 60),
  refreshTokenTtlSeconds: z.number().int().positive().default(30 * 24 * 60 * 60),
  scopes: z.array(z.string().trim().min(1)).min(1).default(["devspace"]),
  allowedRedirectHosts: z.array(z.string().trim().min(1)).min(1).default([
    "chatgpt.com",
    "localhost",
    "127.0.0.1",
  ]),
}).strict().prefault({});

export const devspaceConfigSchema = z.object({
  $schema: z.string().url().default(DEVSPACE_CONFIG_SCHEMA_URL),
  configVersion: z.literal(DEVSPACE_CONFIG_VERSION),
  server: serverConfigSchema,
  workspaces: workspacesConfigSchema,
  storage: storageConfigSchema,
  tools: toolsConfigSchema,
  ui: uiConfigSchema,
  artifacts: artifactsConfigSchema,
  skills: skillsConfigSchema,
  subagents: subagentsConfigSchema.default({ enabled: false, providers: [] }),
  execution: executionConfigSchema,
  logging: loggingConfigSchema,
  oauth: oauthConfigSchema,
}).strict();

export type DevspaceConfig = z.output<typeof devspaceConfigSchema>;
export type DevspaceConfigInput = z.input<typeof devspaceConfigSchema>;
export type ToolMode = DevspaceConfig["tools"]["mode"];

export function defaultDevspaceConfig(): DevspaceConfig {
  return devspaceConfigSchema.parse({ configVersion: DEVSPACE_CONFIG_VERSION });
}

export function devspaceConfigJsonSchema(): object {
  return {
    $id: DEVSPACE_CONFIG_SCHEMA_URL,
    title: "DevSpace configuration",
    description: "Versioned configuration for a local DevSpace MCP server.",
    ...z.toJSONSchema(devspaceConfigSchema, {
      target: "draft-2020-12",
      io: "input",
    }),
  };
}
