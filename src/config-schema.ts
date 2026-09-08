import * as z from "zod/v4";
import { subagentsConfigSchema } from "./local-agent-config.js";
import { fleetConfigSchema } from "./orchestration/lanes.js";

export const HEARTH_CONFIG_VERSION = 1 as const;
export const HEARTH_CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/Waishnav/hearth/main/schema/v1/hearth.schema.json";

const serverConfigSchema = z.object({
  host: z.string().trim().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65_535).default(7176),
  publicBaseUrl: z.string().url().nullable().default(null),
  allowedHosts: z.array(z.string().trim().min(1)).default([]),
  trustProxy: z.boolean().default(false),
  // "derived": OAuth issuer/base URLs follow publicBaseUrl (today's behavior,
  // required for remote clients like ChatGPT). "local": the issuer is pinned
  // to the local bind address so changing the tunnel URL does not invalidate
  // OAuth clients; only meaningful for local/LAN-only deployments.
  issuerMode: z.enum(["derived", "local"]).default("derived"),
}).strict().prefault({});

const tlsConfigSchema = z.object({
  // Native TLS for relay-free direct exposure: when both are set, `serve`
  // terminates HTTPS itself (e.g. behind your own domain + port forward).
  // Leave null when running behind localhost or a tunnel that terminates TLS.
  certFile: z.string().trim().min(1).nullable().default(null),
  keyFile: z.string().trim().min(1).nullable().default(null),
  // Directory served (read-only) at /.well-known/acme-challenge/ so certbot
  // webroot mode can provision certificates while the server runs.
  acmeDir: z.string().trim().min(1).nullable().default(null),
}).strict().prefault({});

const tunnelConfigSchema = z.object({
  // Managed per-PC tunnel. "none" keeps today's behavior (own reverse
  // proxy or direct exposure). "cloudflared" lets `hearth tunnel setup`
  // provision a named Cloudflare Tunnel on this PC and `hearth serve`
  // supervise it, so one command is server + URL + tunnel.
  provider: z.enum(["none", "cloudflared"]).default("none"),
  // Public hostname served through the tunnel (origin only, no path).
  // `hearth tunnel setup` sets this and keeps server.publicBaseUrl in sync.
  hostname: z.string().trim().min(1).nullable().default(null),
  // Cloudflare tunnel UUID. Credentials live in the state dir
  // (stateDir/tunnels/cloudflared/<tunnelId>.json, 0600), never in config.
  tunnelId: z.string().trim().min(1).nullable().default(null),
}).strict().prefault({});

const workspaceProfileSchema = z.object({
  path: z.string().trim().min(1).describe("Absolute path (or ~-prefixed) this profile applies to; longest prefix wins."),
  mode: z.enum(["readonly", "supervised", "autonomous"]).optional(),
  sandbox: z.enum(["auto", "none"]).optional(),
  sandboxNetwork: z.enum(["allow", "deny"]).optional(),
  requireSandboxForAutonomous: z.boolean().optional(),
  commandAllow: z.array(z.string().trim().min(1)).default([]).describe("Regex allowlist; when non-empty only matching commands run."),
  commandDeny: z.array(z.string().trim().min(1)).default([]).describe("Regex denylist; matching commands are always rejected."),
  agentsAllowed: z.boolean().optional().describe("Whether agent tools may run for this workspace. Defaults to true."),
}).strict();

const workspacesConfigSchema = z.object({
  allowedRoots: z.array(z.string().trim().min(1)).default([]),
  worktreeRoot: z.string().trim().min(1).default("~/.hearth/worktrees"),
  profiles: z.array(workspaceProfileSchema).default([]),
}).strict().prefault({});

const storageConfigSchema = z.object({
  stateDir: z.string().trim().min(1).default("~/.local/share/hearth"),
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
  // Default true (fail closed): on machines without bubblewrap/seatbelt
  // (notably Windows, where no equivalent exists), autonomous tier-2 is
  // denied rather than silently unsandboxed. Opt out explicitly per
  // workspace or globally when you accept unsandboxed autonomy.
  requireSandboxForAutonomous: z.boolean().default(true),
}).strict().prefault({});

const oauthConfigSchema = z.object({
  accessTokenTtlSeconds: z.number().int().positive().default(60 * 60),
  refreshTokenTtlSeconds: z.number().int().positive().default(30 * 24 * 60 * 60),
  scopes: z.array(z.string().trim().min(1)).min(1).default(["hearth"]),
  allowedRedirectHosts: z.array(z.string().trim().min(1)).min(1).default([
    "chatgpt.com",
    "claude.ai",
    "anthropic.com",
    "localhost",
    "127.0.0.1",
  ]),
}).strict().prefault({});

export const hearthConfigSchema = z.object({
  $schema: z.string().url().default(HEARTH_CONFIG_SCHEMA_URL),
  configVersion: z.literal(HEARTH_CONFIG_VERSION),
  server: serverConfigSchema,
  workspaces: workspacesConfigSchema,
  storage: storageConfigSchema,
  tools: toolsConfigSchema,
  ui: uiConfigSchema,
  artifacts: artifactsConfigSchema,
  skills: skillsConfigSchema,
  subagents: subagentsConfigSchema.default({ enabled: false, providers: [] }),
  fleet: fleetConfigSchema.default({ lanes: {} }),
  execution: executionConfigSchema,
  logging: loggingConfigSchema,
  tls: tlsConfigSchema.default({ certFile: null, keyFile: null, acmeDir: null }),
  tunnel: tunnelConfigSchema.default({ provider: "none", hostname: null, tunnelId: null }),
  oauth: oauthConfigSchema,
}).strict();

export type HearthConfig = z.output<typeof hearthConfigSchema>;
export type HearthConfigInput = z.input<typeof hearthConfigSchema>;
export type ToolMode = HearthConfig["tools"]["mode"];

export function defaultHearthConfig(): HearthConfig {
  return hearthConfigSchema.parse({ configVersion: HEARTH_CONFIG_VERSION });
}

export function hearthConfigJsonSchema(): object {
  return {
    $id: HEARTH_CONFIG_SCHEMA_URL,
    title: "Hearth configuration",
    description: "Versioned configuration for a local Hearth MCP server.",
    ...z.toJSONSchema(hearthConfigSchema, {
      target: "draft-2020-12",
      io: "input",
    }),
  };
}
