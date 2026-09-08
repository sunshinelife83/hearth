import { resolve } from "node:path";
import type { ToolMode } from "./config-schema.js";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import type { ExecutionMode } from "./policy/command-policy.js";
import { hearthAgentsDir, hearthSkillsDir, loadHearthFiles } from "./user-config.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import type { FleetConfig } from "./orchestration/lanes.js";

export type { ToolMode } from "./config-schema.js";

export interface ExecutionConfig {
  mode: ExecutionMode;
  envAllowAll: boolean;
  envAllowlist: string[];
  sandbox: "auto" | "none";
  sandboxNetwork: "allow" | "deny";
  requireSandboxForAutonomous: boolean;
}

export interface TlsConfig {
  certFile: string | null;
  keyFile: string | null;
  acmeDir: string | null;
}

export interface WorkspaceProfileConfig {
  path: string;
  mode?: ExecutionMode;
  sandbox?: "auto" | "none";
  sandboxNetwork?: "allow" | "deny";
  requireSandboxForAutonomous?: boolean;
  commandAllow: string[];
  commandDeny: string[];
  agentsAllowed?: boolean;
}

export interface ServerConfig {
  configDir: string;
  workspaceProfiles: WorkspaceProfileConfig[];
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  /** OAuth issuer/base URL after issuerMode resolution. */
  oauthIssuerUrl: string;
  toolMode: ToolMode;
  uiEnabled: boolean;
  stateDir: string;
  worktreeRoot: string;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  hearthSkillsDir: string;
  hearthAgentsDir: string;
  subagents: SubagentsConfig;
  fleet: FleetConfig;
  execution: ExecutionConfig;
  agentDir: string;
  logging: LoggingConfig;
  tls: TlsConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadHearthFiles(env);
  const stored = files.config;
  const host = stored.server.host;
  const port = stored.server.port;
  const publicBaseUrl = parsePublicBaseUrl(
    stored.server.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...stored.server.allowedHosts,
  ];

  return {
    configDir: files.dir,
    host,
    port,
    oauth: {
      ownerToken: parseRequiredSecret(
        env.HEARTH_OAUTH_OWNER_TOKEN ?? files.auth.ownerToken,
      ),
      accessTokenTtlSeconds: stored.oauth.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: stored.oauth.refreshTokenTtlSeconds,
      scopes: stored.oauth.scopes,
      allowedRedirectHosts: stored.oauth.allowedRedirectHosts,
      trustProxy: stored.server.trustProxy,
    },
    allowedRoots: normalizePaths(stored.workspaces.allowedRoots, [process.cwd()]),
    workspaceProfiles: stored.workspaces.profiles.map((profile) => ({
      path: normalizePath(profile.path),
      ...(profile.mode !== undefined ? { mode: profile.mode } : {}),
      ...(profile.sandbox !== undefined ? { sandbox: profile.sandbox } : {}),
      ...(profile.sandboxNetwork !== undefined ? { sandboxNetwork: profile.sandboxNetwork } : {}),
      ...(profile.requireSandboxForAutonomous !== undefined ? { requireSandboxForAutonomous: profile.requireSandboxForAutonomous } : {}),
      commandAllow: profile.commandAllow,
      commandDeny: profile.commandDeny,
      ...(profile.agentsAllowed !== undefined ? { agentsAllowed: profile.agentsAllowed } : {}),
    })),
    allowedHosts: normalizeAllowedHosts(derivedAllowedHosts),
    publicBaseUrl,
    oauthIssuerUrl: stored.server.issuerMode === "local"
      ? localPublicBaseUrl(host, port)
      : publicBaseUrl,
    toolMode: stored.tools.mode,
    uiEnabled: stored.ui.enabled,
    stateDir: normalizePath(stored.storage.stateDir),
    worktreeRoot: normalizePath(stored.workspaces.worktreeRoot),
    artifactsEnabled: stored.artifacts.enabled,
    artifactMaxFileBytes: stored.artifacts.maxFileBytes,
    skillsEnabled: stored.skills.enabled,
    skillPaths: stored.skills.paths,
    hearthSkillsDir: hearthSkillsDir(env),
    hearthAgentsDir: hearthAgentsDir(env),
    subagents: stored.subagents,
    fleet: stored.fleet,
    execution: {
      mode: stored.execution.mode,
      envAllowAll: stored.execution.envAllowAll,
      envAllowlist: stored.execution.envAllowlist,
      sandbox: stored.execution.sandbox,
      sandboxNetwork: stored.execution.sandboxNetwork,
      requireSandboxForAutonomous: stored.execution.requireSandboxForAutonomous,
    },
    agentDir: normalizePath(stored.skills.agentDir),
    logging: {
      ...stored.logging,
      trustProxy: stored.server.trustProxy,
    },
    tls: {
      certFile: stored.tls.certFile,
      keyFile: stored.tls.keyFile,
      acmeDir: stored.tls.acmeDir,
    },
  };
}

function normalizePaths(paths: string[], fallback: string[] = []): string[] {
  return (paths.length > 0 ? paths : fallback).map(normalizePath);
}

function normalizePath(path: string): string {
  return resolve(expandHomePath(path));
}

function normalizeAllowedHosts(hosts: string[]): string[] {
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseRequiredSecret(value: string | undefined): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error("OAuth owner token is required. Run: hearth init");
  }
  if (secret.length < 16) {
    throw new Error("OAuth owner token must be at least 16 characters long.");
  }
  return secret;
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  if (/(^|\/)mcp$/i.test(parsed.pathname)) {
    throw new Error(
      `Invalid publicBaseUrl ${JSON.stringify(value)}: use the origin without /mcp (for example https://${parsed.host}). Fix with: hearth config set publicBaseUrl https://${parsed.host}`,
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}
