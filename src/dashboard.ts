import { randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { TaskStore } from "./task-store.js";
import type { LocalAgentProviderStatus } from "./local-agent-catalog.js";
import { createLocalAgentClient } from "./local-agent-client.js";
import { listSnapshots } from "./snapshot-manager.js";
import { probeSandboxAdapter } from "./policy/sandbox.js";
import { hearthVersion } from "./app-version.js";
import { recentLogEntries, logEvent } from "./logger.js";
import { setHearthConfigValue } from "./user-config.js";
import { RateLimiter, ipRateLimitMiddleware } from "./rate-limit.js";
import { fleetConfigSchema } from "./orchestration/lanes.js";
import { loadMachineIdentity } from "./machine-id.js";

/**
 * Local ops-console dashboard (Hearth interface layer).
 *
 * Served by `hearth serve` at /dashboard with JSON APIs under /dashboard/api.
 * Auth is an owner-password login issuing a short-lived HMAC-signed session
 * cookie (never the owner token itself). All state-changing APIs require a
 * JSON content type (fetch-only CSRF mitigation) plus the session cookie.
 * The dashboard exposes the same policy-gated state the MCP surface sees;
 * it performs no privileged execution of its own beyond config edits through
 * the validated allowlist below.
 */

export interface DashboardContext {
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  taskStore?: TaskStore;
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[];
}

const SESSION_TTL_MS = 12 * 3600 * 1000;
const SESSION_COOKIE = "hearth_session";

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function dashboardDirectory(): string {
  const dist = fileURLToPath(new URL("../dist/dashboard", import.meta.url));
  if (existsSync(dist)) return dist;
  return fileURLToPath(new URL("./dashboard", import.meta.url));
}

const configEditSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])).min(1).max(4),
  value: z.unknown(),
});

const ALLOWED_CONFIG_PATHS: Array<{ path: string[]; validate: (value: unknown) => unknown }> = [
  { path: ["execution", "mode"], validate: (v) => z.enum(["readonly", "supervised", "autonomous"]).parse(v) },
  { path: ["execution", "sandbox"], validate: (v) => z.enum(["auto", "none"]).parse(v) },
  { path: ["execution", "sandboxNetwork"], validate: (v) => z.enum(["allow", "deny"]).parse(v) },
  { path: ["execution", "requireSandboxForAutonomous"], validate: (v) => z.boolean().parse(v) },
  { path: ["fleet"], validate: (v) => fleetConfigSchema.parse(v) },
  { path: ["workspaces", "profiles"], validate: (v) => z.array(z.record(z.string(), z.unknown())).parse(v) },
];

export function registerDashboard(app: Express, context: DashboardContext): void {
  const { config, workspaces, taskStore } = context;
  const sessionSecret = randomBytes(32);
  const sessions = new Map<string, number>();
  const loginLimiter = new RateLimiter({
    keyPrefix: "dashboard-login",
    rule: { limit: 10, windowMs: 15 * 60 * 1000 },
  });

  const signSession = (id: string): string =>
    `${id}.${createHmac("sha256", sessionSecret).update(id).digest("hex")}`;

  const readSession = (req: Request): string | undefined => {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    if (!cookie) return undefined;
    const dot = cookie.lastIndexOf(".");
    if (dot <= 0) return undefined;
    const id = cookie.slice(0, dot);
    const signature = cookie.slice(dot + 1);
    const expected = createHmac("sha256", sessionSecret).update(id).digest("hex");
    if (!safeEqual(signature, expected)) return undefined;
    const expires = sessions.get(id);
    if (!expires || expires < Date.now()) {
      sessions.delete(id);
      return undefined;
    }
    return id;
  };

  const requireSession = (req: Request, res: Response, next: NextFunction): void => {
    if (!readSession(req)) {
      res.status(401).json({ error: "Dashboard session required. POST /dashboard/api/login first." });
      return;
    }
    next();
  };

  const requireJson = (req: Request, res: Response, next: NextFunction): void => {
    if (!req.is("application/json")) {
      res.status(415).json({ error: "JSON content type required." });
      return;
    }
    next();
  };

  const configEnv = { ...process.env, HEARTH_CONFIG_DIR: config.configDir };

  app.post(
    "/dashboard/api/login",
    ipRateLimitMiddleware(loginLimiter, config.oauth.trustProxy),
    express.json({ limit: "16kb" }),
    (req, res) => {
      const parsed = z.object({ ownerToken: z.string().min(1).max(500) }).safeParse(req.body);
      if (!parsed.success || !safeEqual(parsed.data.ownerToken, config.oauth.ownerToken)) {
        logEvent(config.logging, "warn", "dashboard_login_denied", {});
        res.status(401).json({ error: "Invalid owner password." });
        return;
      }
      const id = randomBytes(16).toString("hex");
      sessions.set(id, Date.now() + SESSION_TTL_MS);
      res.cookie(SESSION_COOKIE, signSession(id), {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_TTL_MS,
      });
      logEvent(config.logging, "info", "dashboard_login", {});
      res.json({ ok: true });
    },
  );

  app.post("/dashboard/api/logout", express.json({ limit: "1kb" }), (req, res) => {
    const id = readSession(req);
    if (id) sessions.delete(id);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  app.get("/dashboard/api/me", (req, res) => {
    res.json({ authenticated: readSession(req) !== undefined });
  });

  app.get("/dashboard/api/status", requireSession, (_req, res) => {
    const tasks = taskStore?.list() ?? [];
    const byStatus: Record<string, number> = {};
    for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    res.json({
      version: hearthVersion(),
      mode: config.execution.mode,
      sandbox: config.execution.sandbox,
      sandboxAdapter: probeSandboxAdapter(),
      requireSandboxForAutonomous: config.execution.requireSandboxForAutonomous,
      toolMode: config.toolMode,
      publicBaseUrl: config.publicBaseUrl,
      providers: context.resolveLocalAgentProviders(),
      workspaces: workspaces.listWorkspaces(),
      tasks: byStatus,
      lanes: config.fleet.lanes,
    });
  });

  app.get("/dashboard/api/workspaces", requireSession, (_req, res) => {
    res.json({
      open: workspaces.listWorkspaces(),
      allowedRoots: config.allowedRoots,
      profiles: config.workspaceProfiles,
    });
  });

  app.get("/dashboard/api/tasks", requireSession, (req, res) => {
    const limit = Math.min(Math.max(1, Number(req.query.limit ?? 50)), 200);
    res.json({ tasks: (taskStore?.list() ?? []).slice(0, limit) });
  });

  app.get("/dashboard/api/agents", requireSession, async (req, res) => {
    const workspaceId = String(req.query.workspaceId ?? "");
    if (!workspaceId) {
      res.status(400).json({ error: "workspaceId query parameter required." });
      return;
    }
    try {
      const workspace = workspaces.getWorkspace(workspaceId);
      const client = createLocalAgentClient(config);
      const result = await client.list({ workspaceId, workspaceRoot: workspace.root });
      if (result.isErr()) {
        res.status(502).json({ error: `${result.error.code}: ${result.error.message}` });
        return;
      }
      res.json({ agents: result.value });
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/dashboard/api/snapshots", requireSession, async (req, res) => {
    const workspaceId = String(req.query.workspaceId ?? "");
    if (!workspaceId) {
      res.status(400).json({ error: "workspaceId query parameter required." });
      return;
    }
    try {
      const workspace = workspaces.getWorkspace(workspaceId);
      res.json({ snapshots: await listSnapshots({ root: workspace.root, workspaceId }) });
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/dashboard/api/logs", requireSession, (req, res) => {
    const limit = Math.min(Math.max(1, Number(req.query.limit ?? 100)), 200);
    res.json({ entries: recentLogEntries(limit) });
  });

  app.get("/dashboard/api/setup", requireSession, (_req, res) => {
    const providers = context.resolveLocalAgentProviders();
    let machineId: string | undefined;
    try {
      machineId = loadMachineIdentity(config.stateDir).id;
    } catch {
      machineId = undefined;
    }
    res.json({
      machineId,
      allowedRoots: config.allowedRoots,
      hasAllowedRoots: config.allowedRoots.length > 0,
      publicBaseUrl: config.publicBaseUrl,
      publicMcpUrl: new URL("/mcp", config.publicBaseUrl).toString(),
      toolMode: config.toolMode,
      redirectHosts: config.oauth.allowedRedirectHosts,
      subagentsEnabled: config.subagents.enabled,
      providers: providers.map((provider) => ({
        id: provider.id,
        enabled: provider.enabled,
        available: provider.available,
      })),
      fleetLanes: Object.keys(config.fleet.lanes),
      healthEndpoint: "/healthz",
      mcpEndpoint: "/mcp",
    });
  });

  app.get("/dashboard/api/config", requireSession, (_req, res) => {
    res.json({
      execution: {
        mode: config.execution.mode,
        sandbox: config.execution.sandbox,
        sandboxNetwork: config.execution.sandboxNetwork,
        requireSandboxForAutonomous: config.execution.requireSandboxForAutonomous,
      },
      toolMode: config.toolMode,
      publicBaseUrl: config.publicBaseUrl,
      allowedRoots: config.allowedRoots,
      fleet: config.fleet,
      subagents: {
        enabled: config.subagents.enabled,
        providers: config.subagents.providers.map((provider) => ({
          id: provider.id,
          enabled: provider.enabled,
          ...(provider.model ? { model: provider.model } : {}),
          ...(provider.effort ? { effort: provider.effort } : {}),
        })),
      },
      workspaceProfiles: config.workspaceProfiles,
    });
  });

  app.put("/dashboard/api/config", requireSession, requireJson, express.json({ limit: "64kb" }), (req, res) => {
    const parsed = configEditSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Body must be { path: [...], value }." });
      return;
    }
    const allowed = ALLOWED_CONFIG_PATHS.find(
      (entry) => entry.path.length === parsed.data.path.length
        && entry.path.every((segment, index) => segment === parsed.data.path[index]),
    );
    if (!allowed) {
      res.status(403).json({ error: "Config path is not editable from the dashboard." });
      return;
    }
    let value: unknown;
    try {
      value = allowed.validate(parsed.data.value);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      setHearthConfigValue(allowed.path, value, configEnv);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    logEvent(config.logging, "info", "dashboard_config_edit", { path: allowed.path.join(".") });
    res.json({ ok: true, restartRequired: true });
  });

  app.get("/dashboard", (_req, res) => {
    res.sendFile("index.html", { root: dashboardDirectory() });
  });
  app.use(
    "/dashboard",
    express.static(dashboardDirectory(), { fallthrough: false }),
  );
}
