import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

/**
 * Managed per-PC ngrok tunnel — the sole remote-access path.
 *
 * Each PC runs `ngrok http <port>` for its own free static dev domain
 * (e.g. https://xxx.ngrok-free.dev), which never churns across restarts.
 * Hearth supervises the agent, reads the live public URL from the local
 * agent API (127.0.0.1:4040) instead of parsing logs, and refuses to serve
 * publicly when the live domain drifts from the saved one.
 *
 * The ngrok authtoken is ngrok's own secret: it lives in ngrok's config via
 * `ngrok config add-authtoken` and is never stored in Hearth config.
 */

export const NGROK_AGENT_API = "http://127.0.0.1:4040/api";

export interface NgrokPaths {
  dir: string;
  pidPath: string;
}

export function ngrokPaths(stateDir: string): NgrokPaths {
  const dir = join(stateDir, "tunnels", "ngrok");
  return { dir, pidPath: join(dir, "ngrok.pid") };
}

export function findNgrok(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathValue = env.PATH;
  if (!pathValue) return undefined;
  const binary = process.platform === "win32" ? "ngrok.exe" : "ngrok";
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

export function ngrokInstallHint(): string {
  return [
    "ngrok was not found on PATH.",
    "Install it first, then re-run `hearth ngrok setup`:",
    "  Linux/macOS: brew install ngrok  (or https://ngrok.com/download)",
    "  Windows: winget install --id Ngrok.ngrok",
  ].join("\n");
}

function runNgrok(binary: string, args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(binary, args, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, output };
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const stdout = (error as { stdout?: unknown }).stdout;
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      output: [typeof stdout === "string" ? stdout : "", typeof stderr === "string" ? stderr : "", message]
        .filter(Boolean)
        .join("\n"),
    };
  }
}

export function ngrokVersion(binary: string): string {
  const result = runNgrok(binary, ["version"]);
  if (!result.ok) throw new Error(`ngrok version check failed:\n${result.output}`);
  return result.output.trim().split("\n")[0] ?? "unknown";
}

/** An authtoken is configured when `ngrok config check` succeeds. */
export function checkNgrokAuth(binary: string): { ok: boolean; output: string } {
  return runNgrok(binary, ["config", "check"]);
}

export function validateNgrokDomain(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter the static ngrok domain for this PC, for example xxx.ngrok-free.dev.";
  const bare = trimmed.replace(/^https?:\/\//i, "").split("/")[0] ?? "";
  if (!bare || /\s/.test(bare) || bare.includes(":") || bare.includes("/")) {
    return "Enter a bare domain such as xxx.ngrok-free.dev (no scheme, path, or port).";
  }
  if (/\/mcp\/?$/i.test(trimmed)) return "Enter the domain only, without /mcp.";
  if (!bare.includes(".")) return `That does not look like an ngrok domain: ${JSON.stringify(bare)}.`;
  return undefined;
}

export function normalizeNgrokDomain(value: string): string {
  return value.trim().replace(/^https?:\/\//i, "").split("/")[0]!.trim().toLowerCase();
}

export interface AgentTunnel {
  publicUrl: string;
  proto: string;
}

interface AgentApiTunnel {
  public_url?: unknown;
  proto?: unknown;
  config?: { addr?: unknown };
}

/** Parse `GET /api/tunnels` into https tunnels. Pure and unit-tested. */
export function parseAgentTunnels(payload: unknown): AgentTunnel[] {
  if (typeof payload !== "object" || payload === null) return [];
  const tunnels = (payload as { tunnels?: unknown }).tunnels;
  if (!Array.isArray(tunnels)) return [];
  const result: AgentTunnel[] = [];
  for (const entry of tunnels) {
    if (typeof entry !== "object" || entry === null) continue;
    const { public_url: publicUrl, proto } = entry as AgentApiTunnel;
    if (typeof publicUrl !== "string" || typeof proto !== "string") continue;
    if (proto !== "https") continue;
    result.push({ publicUrl, proto });
  }
  return result;
}

async function fetchAgentTunnels(): Promise<AgentTunnel[]> {
  const response = await fetch(`${NGROK_AGENT_API}/tunnels`);
  if (!response.ok) throw new Error(`ngrok agent API returned ${response.status}`);
  return parseAgentTunnels(await response.json() as unknown);
}

/** Wait for an https tunnel whose host equals the saved domain. Throws on timeout or drift. */
export async function waitForAgentDomain(
  domain: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const pollMs = options.pollMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  let lastSeen: string | undefined;
  for (;;) {
    let tunnels: AgentTunnel[] = [];
    try {
      tunnels = await fetchAgentTunnels();
    } catch {
      // Agent not up yet; keep polling until the deadline.
    }
    const match = tunnels.find((tunnel) => {
      try {
        return new URL(tunnel.publicUrl).hostname.toLowerCase() === domain.toLowerCase();
      } catch {
        return false;
      }
    });
    if (match) return match.publicUrl;
    if (tunnels.length > 0) {
      lastSeen = tunnels.map((tunnel) => tunnel.publicUrl).join(", ");
    }
    if (Date.now() >= deadline) {
      throw new Error(
        lastSeen
          ? `ngrok is serving ${lastSeen} instead of the saved domain ${domain}. Fix the domain (hearth ngrok setup) — refusing to serve a drifting URL.`
          : `Timed out waiting for ngrok to serve ${domain}. Is the agent running with this domain and a valid authtoken?`,
      );
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
  }
}

export interface SupervisedNgrok {
  process: ChildProcess;
  pid: number;
  stop(): Promise<void>;
}

export function startNgrokChild(options: {
  binary: string;
  port: number;
  pidPath: string;
  onLog: (line: string) => void;
}): SupervisedNgrok {
  mkdirSync(join(options.pidPath, ".."), { recursive: true, mode: 0o700 });
  const child = spawn(options.binary, ["http", String(options.port), "--log=stdout", "--log-format=json"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (child.pid === undefined) {
    throw new Error("ngrok child exited before a pid was assigned.");
  }
  const pid = child.pid;
  try {
    writeFileSync(options.pidPath, `${pid}\n`, { mode: 0o600 });
  } catch {
    // Pidfile is advisory; the child reference is authoritative.
  }
  const forward = (chunk: Buffer | string) => {
    for (const line of String(chunk).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const logged = JSON.parse(trimmed) as { msg?: unknown; lvl?: unknown; err?: unknown };
        if (typeof logged.msg === "string") {
          options.onLog(`${String(logged.lvl ?? "info")}: ${logged.msg}${logged.err ? ` (${String(logged.err)})` : ""}`);
          continue;
        }
      } catch {
        // Not JSON; fall through to raw output.
      }
      options.onLog(trimmed);
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

/** Best-effort liveness check for a serve-managed ngrok child. */
export function isNgrokChildAlive(pidPath: string): number | undefined {
  let pid: number | undefined;
  try {
    const parsed = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
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

export interface ManagedNgrokState {
  domain: string | null;
  publicBaseUrl: string;
  trustProxy: boolean;
  /** Resolved ngrok binary, or null/undefined when absent. */
  binary: string | null | undefined;
}

/** Serve-time fail-fast validation. Returns blocking problem strings. */
export function validateManagedNgrok(state: ManagedNgrokState): string[] {
  const problems: string[] = [];
  if (!state.domain) {
    problems.push("`serve --ngrok` needs a saved domain. Run `hearth ngrok setup` first.");
    return problems;
  }
  let publicHost = "";
  try {
    publicHost = new URL(state.publicBaseUrl).hostname.toLowerCase();
  } catch {
    problems.push(`server.publicBaseUrl ${JSON.stringify(state.publicBaseUrl)} is not a valid URL.`);
  }
  if (publicHost && publicHost !== state.domain.toLowerCase()) {
    problems.push(
      `tunnel.domain ${state.domain} does not match publicBaseUrl host ${publicHost}. ` +
      "Re-run `hearth ngrok setup` to resync.",
    );
  }
  if (!state.trustProxy) {
    problems.push("Managed ngrok needs server.trustProxy=true. Re-run `hearth ngrok setup`.");
  }
  if (!state.binary) {
    problems.push(ngrokInstallHint());
  }
  return problems;
}
