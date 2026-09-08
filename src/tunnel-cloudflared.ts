import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

/**
 * Managed per-PC Cloudflare Tunnel (cloudflared) integration.
 *
 * Each PC runs its own named tunnel (`hearth-<machine-hex>`) targeting the
 * local Hearth bind address. Named tunnels keep a stable public hostname
 * across restarts, unlike quick tunnels. Ingress exposes only the AI
 * interaction endpoints; everything else (notably /dashboard) stays
 * localhost-only via the edge catch-all 404.
 *
 * Secrets (tunnel credentials JSON) live under stateDir at 0600 and are
 * never written to config.jsonc or logs.
 */

export const TUNNEL_CONFIG_VERSION = 1 as const;

/** Host-served paths exposed through the tunnel. Everything else 404s at the edge. */
export const TUNNEL_PUBLIC_PATHS = [
  "^/mcp$",
  "^/mcp-app-assets/.*",
  "^/authorize$",
  "^/token$",
  "^/register$",
  "^/revoke$",
  "^/\\.well-known/.*",
  "^/healthz$",
] as const;

export interface TunnelPaths {
  dir: string;
  credentialsPath: string;
  configPath: string;
  pidPath: string;
}

export function tunnelNameForMachine(machineId: string): string {
  const suffix = machineId.replace(/^hearth-/, "").toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(suffix)) {
    throw new Error(`Cannot derive a tunnel name from machine id ${JSON.stringify(machineId)}.`);
  }
  return `hearth-${suffix}`;
}

export function tunnelPaths(stateDir: string, tunnelId: string): TunnelPaths {
  const dir = join(stateDir, "tunnels", "cloudflared");
  return {
    dir,
    credentialsPath: join(dir, `${tunnelId}.json`),
    configPath: join(dir, "config.yml"),
    pidPath: join(dir, "cloudflared.pid"),
  };
}

export function findCloudflared(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathValue = env.PATH;
  if (!pathValue) return undefined;
  const binary = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not executable here; keep scanning.
    }
  }
  return undefined;
}

export function cloudflaredVersion(binary: string): string {
  const output = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 });
  const firstLine = output.trim().split("\n")[0] ?? "";
  const match = firstLine.match(/cloudflared version (\S+)/i);
  return match?.[1] ?? firstLine.trim() ?? "unknown";
}

export interface TunnelCommandResult {
  ok: boolean;
  output: string;
}

function runTunnelCommand(binary: string, args: string[]): TunnelCommandResult {
  try {
    const output = execFileSync(binary, args, {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, output };
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const stdout = (error as { stdout?: unknown }).stdout;
    const message = error instanceof Error ? error.message : String(error);
    const output = [typeof stdout === "string" ? stdout : "", typeof stderr === "string" ? stderr : "", message]
      .filter(Boolean)
      .join("\n");
    return { ok: false, output };
  }
}

/** `tunnel list` doubles as a login check: it fails without cert.pem. */
export function checkCloudflaredLogin(binary: string): TunnelCommandResult {
  return runTunnelCommand(binary, ["tunnel", "list"]);
}

export interface ListedTunnel {
  id: string;
  name: string;
}

const UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/** Parse `tunnel list` output (JSON preferred, text table fallback). */
export function parseTunnelList(output: string): ListedTunnel[] {
  const trimmed = output.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      const tunnels: ListedTunnel[] = [];
      for (const entry of entries) {
        if (typeof entry !== "object" || entry === null) continue;
        const record = entry as Record<string, unknown>;
        const id = [record.id, record.ID, record.uuid, record.UUID, record.tunnelId, record.TunnelID]
          .find((value): value is string => typeof value === "string");
        const name = [record.name, record.Name, record.tunnelName]
          .find((value): value is string => typeof value === "string");
        if (id && name) tunnels.push({ id, name });
      }
      return tunnels;
    } catch {
      // Fall through to text parsing.
    }
  }
  const tunnels: ListedTunnel[] = [];
  for (const line of trimmed.split("\n")) {
    const idMatch = line.match(new RegExp(UUID_PATTERN));
    if (!idMatch) continue;
    const cells = line.split(/\s{2,}|\t/).map((cell) => cell.trim()).filter(Boolean);
    const name = cells.find((cell) => cell.length > 0 && !new RegExp(`^${UUID_PATTERN}$`).test(cell) && !/^(id|name|created|status|connections?)\b/i.test(cell));
    tunnels.push({ id: idMatch[0], name: name ?? "" });
  }
  return tunnels;
}

export function listTunnels(binary: string): ListedTunnel[] | undefined {
  const asJson = runTunnelCommand(binary, ["tunnel", "list", "--output", "json"]);
  if (asJson.ok && asJson.output.trim()) return parseTunnelList(asJson.output);
  const asText = runTunnelCommand(binary, ["tunnel", "list"]);
  if (!asText.ok) return undefined;
  return parseTunnelList(asText.output);
}

export interface CreatedTunnel {
  tunnelId: string;
  credentialsSource: string | undefined;
}

/** Parse `tunnel create` output for the UUID and credentials path. */
export function parseTunnelCreate(output: string): CreatedTunnel | undefined {
  const idMatch = output.match(new RegExp(`(?:id|ID|uuid|UUID)[:\\s]+(${UUID_PATTERN})`))
    ?? output.match(new RegExp(`(${UUID_PATTERN})`));
  if (!idMatch?.[1]) return undefined;
  const credMatch = output.match(/[Cc]redentials (?:written to|saved (?:to|at)|file:?)\s*(\S+\.json)/)
    ?? output.match(/(\S+\.json)/);
  return { tunnelId: idMatch[1], credentialsSource: credMatch?.[1] };
}

export function createTunnel(binary: string, name: string): CreatedTunnel {
  const result = runTunnelCommand(binary, ["tunnel", "create", name]);
  if (!result.ok) {
    throw new Error(`cloudflared tunnel create failed:\n${result.output}`);
  }
  const parsed = parseTunnelCreate(result.output);
  if (!parsed) {
    throw new Error(`cloudflared tunnel create succeeded but the tunnel id could not be parsed:\n${result.output}`);
  }
  return parsed;
}

export function routeTunnelDns(binary: string, tunnelId: string, hostname: string): void {
  const result = runTunnelCommand(binary, ["tunnel", "route", "dns", tunnelId, hostname]);
  if (!result.ok) {
    throw new Error(`cloudflared tunnel route dns failed:\n${result.output}`);
  }
}

export function tunnelInfo(binary: string, tunnelId: string): TunnelCommandResult {
  return runTunnelCommand(binary, ["tunnel", "info", tunnelId]);
}

export interface IngressModel {
  hostname: string;
  /** Local origin, e.g. http://127.0.0.1:7176 */
  origin: string;
}

/** Model-level validation before any file is written. Returns error strings. */
export function validateIngressModel(model: { hostname: string; origin: string }): string[] {
  const errors: string[] = [];
  const hostname = model.hostname.trim().toLowerCase();
  if (!hostname || /\s/.test(hostname) || hostname.includes("/")) {
    errors.push(`Invalid tunnel hostname ${JSON.stringify(model.hostname)}: use a bare hostname such as hearth.example.com.`);
  }
  let origin: URL;
  try {
    origin = new URL(model.origin);
  } catch {
    errors.push(`Invalid tunnel origin ${JSON.stringify(model.origin)}: use an http(s) URL such as http://127.0.0.1:7176.`);
    return errors;
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    errors.push(`Invalid tunnel origin ${JSON.stringify(model.origin)}: only http and https origins are supported.`);
  }
  if (!/^([a-z0-9.-]+|\[[0-9a-fA-F:]+\]|localhost)$/.test(origin.hostname)) {
    errors.push(`Invalid tunnel origin host ${JSON.stringify(origin.hostname)}: point the tunnel at this PC's Hearth bind address.`);
  }
  return errors;
}

/** Render config.yml: AI endpoints only, edge catch-all 404 last. */
export function buildIngressConfig(model: IngressModel): string {
  const errors = validateIngressModel(model);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const lines = [
    `# Managed by \`hearth tunnel setup\`. Do not hand-edit: re-run setup instead.`,
    `tunnel: PLACEHOLDER_TUNNEL_ID`,
    `credentials-file: PLACEHOLDER_CREDENTIALS_FILE`,
    `ingress:`,
  ];
  for (const path of TUNNEL_PUBLIC_PATHS) {
    lines.push(`  - hostname: ${model.hostname}`);
    lines.push(`    path: "${path}"`);
    lines.push(`    service: ${model.origin}`);
  }
  lines.push(`  - service: http_status:404`);
  return `${lines.join("\n")}\n`;
}

export function finalizeIngressConfig(rendered: string, tunnelId: string, credentialsPath: string): string {
  return rendered
    .replace("PLACEHOLDER_TUNNEL_ID", tunnelId)
    .replace("PLACEHOLDER_CREDENTIALS_FILE", credentialsPath);
}

/** Structural check on a rendered config: rules present, catch-all last, dashboard absent. */
export function validateRenderedConfig(rendered: string, hostname: string): string[] {
  const errors: string[] = [];
  if (!rendered.includes("http_status:404")) {
    errors.push("Ingress config is missing the catch-all http_status:404 rule.");
  }
  const lines = rendered.split("\n");
  const catchAllIndex = lines.findIndex((line) => line.includes("http_status:404"));
  const lastRuleIndex = lines.map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*-\s/.test(line))
    .map(({ index }) => index)
    .at(-1);
  if (catchAllIndex !== -1 && lastRuleIndex !== undefined && catchAllIndex !== lastRuleIndex) {
    errors.push("Ingress catch-all http_status:404 must be the last rule.");
  }
  for (const forbidden of ["dashboard", "config.jsonc", "auth.json", ".hearth"]) {
    if (rendered.toLowerCase().includes(forbidden)) {
      errors.push(`Ingress config must not expose ${forbidden}.`);
    }
  }
  if (!rendered.includes(`hostname: ${hostname}`)) {
    errors.push(`Ingress config has no rule for hostname ${hostname}.`);
  }
  if (rendered.includes("PLACEHOLDER")) {
    errors.push("Ingress config still contains unfilled placeholders.");
  }
  return errors;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Copy cloudflared-issued credentials into stateDir at 0600. Original is left alone. */
export function installTunnelCredentials(stateDir: string, tunnelId: string, sourcePath: string): string {
  const paths = tunnelPaths(stateDir, tunnelId);
  ensureDir(paths.dir);
  const content = readFileSync(sourcePath, "utf8");
  JSON.parse(content);
  writeFileSync(paths.credentialsPath, content, { mode: 0o600 });
  return paths.credentialsPath;
}

export function writeTunnelConfig(stateDir: string, tunnelId: string, rendered: string): string {
  const paths = tunnelPaths(stateDir, tunnelId);
  ensureDir(paths.dir);
  const finalized = finalizeIngressConfig(rendered, tunnelId, paths.credentialsPath);
  writeFileSync(paths.configPath, finalized, { mode: 0o600 });
  return paths.configPath;
}

export function validateTunnelHostname(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter the public hostname for this PC, for example hearth.example.com.";
  if (/\/mcp\/?$/i.test(trimmed)) return "Enter the hostname only, without /mcp.";
  const bare = trimmed.replace(/^https?:\/\//i, "").split("/")[0] ?? "";
  if (!bare || /\s/.test(bare) || bare.includes(":")) {
    return "Enter a bare hostname such as hearth.example.com (no scheme, path, or port).";
  }
  return undefined;
}

export function normalizeTunnelHostname(value: string): string {
  return value.trim().replace(/^https?:\/\//i, "").split("/")[0]!.trim().toLowerCase();
}

export interface SupervisedTunnel {
  process: ChildProcess;
  pid: number;
  stop(): Promise<void>;
}

export interface ManagedTunnelState {
  hostname: string | null;
  tunnelId: string | null;
  publicBaseUrl: string;
  trustProxy: boolean;
  /** Resolved cloudflared binary, or null/undefined when absent. */
  binary: string | null | undefined;
  credentialsExist: boolean;
  /** Rendered ingress file content, or undefined when unreadable/missing. */
  ingressContent: string | undefined;
}

/** Serve-time fail-fast validation. Returns blocking problem strings. */
export function validateManagedTunnel(state: ManagedTunnelState): string[] {
  const problems: string[] = [];
  if (!state.hostname || !state.tunnelId) {
    problems.push("tunnel provider is cloudflared but hostname or tunnelId is missing. Re-run `hearth tunnel setup`.");
    return problems;
  }
  let publicHost = "";
  try {
    publicHost = new URL(state.publicBaseUrl).hostname.toLowerCase();
  } catch {
    problems.push(`server.publicBaseUrl ${JSON.stringify(state.publicBaseUrl)} is not a valid URL.`);
  }
  if (publicHost && publicHost !== state.hostname.toLowerCase()) {
    problems.push(
      `tunnel.hostname ${state.hostname} does not match publicBaseUrl host ${publicHost}. ` +
      `Re-run \`hearth tunnel setup --hostname ${state.hostname}\`.`,
    );
  }
  if (!state.trustProxy) {
    problems.push("Managed tunnel needs server.trustProxy=true. Re-run `hearth tunnel setup`.");
  }
  if (!state.binary) {
    problems.push(cloudflaredInstallHint());
  }
  if (!state.credentialsExist) {
    problems.push("Tunnel credentials are missing from the state dir. Re-run `hearth tunnel setup`.");
  }
  if (state.ingressContent === undefined) {
    problems.push("Tunnel ingress file is missing from the state dir. Re-run `hearth tunnel setup`.");
  } else {
    for (const problem of validateRenderedConfig(state.ingressContent, state.hostname)) {
      problems.push(`Tunnel ingress: ${problem}`);
    }
  }
  return problems;
}

export function cloudflaredInstallHint(): string {
  return [
    "cloudflared was not found on PATH.",
    "Install it first, then re-run `hearth tunnel setup`:",
    "  Linux: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/#linux",
    "  macOS: brew install cloudflared",
    "  Windows: winget install --id Cloudflare.cloudflared",
  ].join("\n");
}

export function startTunnelChild(options: {
  binary: string;
  configPath: string;
  tunnelId: string;
  pidPath: string;
  onLog: (line: string) => void;
}): SupervisedTunnel {
  const child = spawn(options.binary, ["tunnel", "--config", options.configPath, "run", options.tunnelId], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (child.pid === undefined) {
    throw new Error("cloudflared tunnel child exited before a pid was assigned.");
  }
  const pid = child.pid;
  try {
    writeFileSync(options.pidPath, `${pid}\n`, { mode: 0o600 });
  } catch {
    // Pidfile is advisory; the child reference is authoritative.
  }
  const forward = (chunk: Buffer | string) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) options.onLog(line);
    }
  };
  child.stdout?.on("data", forward);
  child.stderr?.on("data", forward);
  return {
    process: child,
    pid,
    stop: () => new Promise<void>((resolveStop) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolveStop();
        }
      };
      child.once("exit", finish);
      child.once("error", finish);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        finish();
      }, 10_000).unref?.();
    }),
  };
}

/** Best-effort liveness check for a serve-managed tunnel child. */
export function isTunnelChildAlive(pidPath: string): number | undefined {
  let pid: number | undefined;
  try {
    const raw = readFileSync(pidPath, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch {
    return undefined;
  }
  if (pid === undefined) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}
