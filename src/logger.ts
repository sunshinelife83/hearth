import type { Request } from "express";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type LogFormat = "json" | "pretty";

export interface LoggingConfig {
  level: LogLevel;
  format: LogFormat;
  requests: boolean;
  assets: boolean;
  toolCalls: boolean;
  shellCommands: boolean;
  trustProxy: boolean;
}

type LogFields = Record<string, unknown>;

/**
 * Bounded in-memory ring of recent log events for the local dashboard.
 * Secret-safe by construction: only the event name, timestamp, level, and a
 * small set of scalar operational fields are retained. Free-form content,
 * command text, file contents, tokens, and credentials never enter the ring.
 */
export interface RecentLogEntry {
  ts: string;
  level: string;
  event: string;
  tool?: string;
  workspaceId?: string;
  status?: string;
  durationMs?: number;
  method?: string;
  path?: string;
}

const RECENT_LOG_CAP = 200;
const recentLog: RecentLogEntry[] = [];

const RECENT_SCALAR_KEYS = new Set(["tool", "workspaceId", "status", "method", "path"]);
const SENSITIVE_KEY_RE = /token|secret|password|credential|apikey|api_key|auth|cookie|session/i;

function toRecentEntry(entry: LogFields & { ts: string; level: string; event: string }): RecentLogEntry | undefined {
  if (typeof entry.event !== "string") return undefined;
  const out: RecentLogEntry = { ts: entry.ts, level: entry.level, event: entry.event };
  for (const key of RECENT_SCALAR_KEYS) {
    if (SENSITIVE_KEY_RE.test(key)) continue;
    const value = entry[key];
    if (typeof value === "string" && !SENSITIVE_KEY_RE.test(value)) {
      (out as unknown as Record<string, unknown>)[key] = value.slice(0, 200);
    }
  }
  if (typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)) {
    out.durationMs = Math.round(entry.durationMs);
  }
  return out;
}

export function recentLogEntries(limit = 100): RecentLogEntry[] {
  const capped = Math.min(Math.max(1, Math.floor(limit)), RECENT_LOG_CAP);
  return recentLog.slice(-capped);
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export function shouldLog(config: LoggingConfig, level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_WEIGHT[config.level] >= LEVEL_WEIGHT[level];
}

export function logEvent(
  config: LoggingConfig,
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: LogFields = {},
): void {
  if (!shouldLog(config, level)) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };

  const recent = toRecentEntry(entry as LogFields & { ts: string; level: string; event: string });
  if (recent) {
    recentLog.push(recent);
    if (recentLog.length > RECENT_LOG_CAP) recentLog.splice(0, recentLog.length - RECENT_LOG_CAP);
  }

  const line = config.format === "pretty" ? formatPretty(entry) : JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function requestIp(req: Request, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const cfConnectingIp = firstHeaderValue(req.header("cf-connecting-ip"));
    if (cfConnectingIp) return cfConnectingIp;

    const forwardedFor = firstHeaderValue(req.header("x-forwarded-for"));
    if (forwardedFor) return forwardedFor;
  }

  return req.ip ?? req.socket.remoteAddress;
}

export function requestPath(req: Request): string {
  return req.path || req.url.split("?")[0] || req.url;
}

export function commandPreview(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function firstHeaderValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function formatPretty(entry: LogFields): string {
  const ts = String(entry.ts);
  const level = String(entry.level).toUpperCase();
  const event = String(entry.event);
  const rest = Object.entries(entry)
    .filter(([key, value]) => !["ts", "level", "event"].includes(key) && value !== undefined)
    .map(([key, value]) => `${key}=${formatPrettyValue(value)}`)
    .join(" ");

  return rest ? `${ts} ${level} ${event} ${rest}` : `${ts} ${level} ${event}`;
}

function formatPrettyValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}
