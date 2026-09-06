import { logEvent, type LoggingConfig } from "../logger.js";

/**
 * Environment filtering for model-invoked shell tools.
 *
 * Model-run commands must not inherit arbitrary user-environment variables:
 * the environment commonly holds cloud/API credentials, and any command the
 * model executes could read and exfiltrate them. Commands are instead given a
 * conservative allowlist plus the DevSpace workspace markers they legitimately
 * need. Individual values can still be provided inline per command
 * (`API_KEY=x cmd`) when the user chooses to.
 */

export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  // Identity and basics
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  // Terminal/display conventions (DevSpace also sets some of these explicitly)
  "TERM",
  "COLORTERM",
  // XDG conventions used by many CLIs for config/cache locations
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  // Proxy settings: required for network operations behind proxies
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Windows essentials
  "SystemRoot",
  "windir",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "ProgramFiles",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
];

export interface EnvironmentFilter {
  /** When true, the full parent environment is passed (escape hatch). */
  allowAll: boolean;
  /** Additional allowlist entries beyond DEFAULT_ENV_ALLOWLIST. */
  extraAllowlist?: readonly string[];
}

export function filterChildEnvironment(
  parentEnv: NodeJS.ProcessEnv,
  filter: EnvironmentFilter,
  context?: { logging?: LoggingConfig; workspaceId?: string },
): Record<string, string> {
  const source = Object.fromEntries(
    Object.entries(parentEnv).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

  if (filter.allowAll) {
    logEvent(context?.logging ?? silentLogging(), "debug", "env_filter_bypassed", {
      allowAll: true,
      workspaceId: context?.workspaceId,
    });
    return source;
  }

  const allowlist = new Set<string>([...DEFAULT_ENV_ALLOWLIST, ...(filter.extraAllowlist ?? [])]);
  if (context?.workspaceId) {
    // DevSpace's own non-secret workspace markers are always passed so CLI
    // helpers invoked from tool shells can scope themselves.
    allowlist.add("DEVSPACE_WORKSPACE_ID");
    allowlist.add("DEVSPACE_WORKSPACE_ROOT");
  }
  allowlist.add("DEVSPACE_ORIGIN");

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowlist.has(key)) result[key] = value;
  }

  if (context?.logging) {
    const dropped = Object.keys(source).length - Object.keys(result).length;
    logEvent(context.logging, "debug", "env_filter_applied", {
      kept: Object.keys(result).length,
      dropped,
      workspaceId: context.workspaceId,
    });
  }
  return result;
}

function silentLogging(): LoggingConfig {
  return {
    level: "silent",
    format: "json",
    requests: false,
    assets: false,
    toolCalls: false,
    shellCommands: false,
    trustProxy: false,
  };
}
