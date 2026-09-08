#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import type { Result as BetterResult } from "better-result";
import * as prompts from "@clack/prompts";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { satisfies } from "semver";
import { loadConfig } from "./config.js";
import { resolveCliWorkspaceContext } from "./cli-workspace.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
  formatLocalAgentProviderStatusSummary,
} from "./local-agent-catalog.js";
import { loadLocalAgentProfiles } from "./local-agent-profiles.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import {
  parseLocalAgentContinueArgs,
  parseLocalAgentRunArgs,
} from "./local-agent-targets.js";
import { createLocalAgentClient } from "./local-agent-client.js";
import { toAgentErrorPayload, type LocalAgentError } from "./local-agent-errors.js";
import {
  formatAgentObservation,
  formatAgentReceipt,
  formatAgentSummary,
  formatAgentTargetCatalog,
  presentAgentObservation,
  presentAgentReceipt,
  presentAgentSummary,
  presentAgentTargetCatalog,
} from "./local-agent-presentation.js";
import {
  type OnboardingDestination,
  SUBAGENT_SKILL_INSTALL_COMMAND,
  resolveOnboardingUsage,
  updateOnboardingSubagentsConfig,
  usesChatGpt,
  usesCodingAgents,
} from "./onboarding.js";
import {
  generateOwnerToken,
  loadHearthFiles,
  setHearthConfigValue,
  setHearthConfigValues,
  writeHearthAuth,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";
import { readReviewRef } from "./review-checkpoints.js";
import { shutdownHttpServer } from "./server-shutdown.js";

type Command =
  | "serve"
  | "mcp"
  | "token"
  | "init"
  | "doctor"
  | "config"
  | "agents"
  | "show-changes"
  | "expose"
  | "id"
  | "connect"
  | "help"
  | "version";
const require = createRequire(import.meta.url);
// Keep in sync with "engines.node" in package.json and the documented range.
const SUPPORTED_NODE_RANGE = ">=22.19 <27";

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve();
      return;
    case "mcp":
      await runMcp();
      return;
    case "token":
      await runTokenCommand(args);
      return;
    case "init":
      await runInit(parseInitArgs(args));
      return;
    case "doctor":
      await runDoctor(parseDoctorArgs(args));
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "agents":
      await runAgentsCommand(args);
      return;
    case "expose":
      await runExpose();
      return;
    case "id":
      runMachineId();
      return;
    case "connect":
      await runConnect(args);
      return;
    case "show-changes":
      await runShowChanges(args);
      return;
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (
    command === "init"
    || command === "mcp"
    || command === "token"
    || command === "doctor"
    || command === "config"
    || command === "agents"
    || command === "show-changes"
    || command === "expose"
    || command === "connect"
    || command === "id"
  ) return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  if (command === "version" || command === "--version" || command === "-v") return "version";
  throw new Error(`Unknown command: ${command}`);
}

async function ensureConfigured(): Promise<void> {
  const files = loadHearthFiles();
  if (files.migratedLegacyConfig) {
    console.log(`Migrated legacy configuration to ${files.configPath}`);
  }
  if (files.migratedFromDevspace) {
    console.log(`Adopted your pre-rename DevSpace install into ${files.dir} (originals kept).`);
  }
  if (files.configExists && files.authExists) return;
  if (process.env.HEARTH_OAUTH_OWNER_TOKEN) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "Hearth is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  hearth init",
        "",
        "Or provide HEARTH_OAUTH_OWNER_TOKEN.",
      ].join("\n"),
    );
  }

  await runInit({ force: false });
}

interface InitOptions {
  force: boolean;
  yes?: boolean;
  roots?: string;
  publicUrl?: string;
  use?: string;
  providers?: string;
}

function parseInitArgs(args: string[]): InitOptions {
  const options: InitOptions = { force: false, yes: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--force") options.force = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--roots") options.roots = args[++index];
    else if (arg.startsWith("--roots=")) options.roots = arg.slice("--roots=".length);
    else if (arg === "--public-url") options.publicUrl = args[++index];
    else if (arg.startsWith("--public-url=")) options.publicUrl = arg.slice("--public-url=".length);
    else if (arg === "--use") options.use = args[++index];
    else if (arg.startsWith("--use=")) options.use = arg.slice("--use=".length);
    else if (arg === "--providers") options.providers = args[++index];
    else if (arg.startsWith("--providers=")) options.providers = arg.slice("--providers=".length);
    else throw new Error(`Unknown init option: ${arg}. Usage: hearth init [--force] [--yes] [--roots <csv>] [--public-url <url>] [--use chatgpt|coding-agents|both] [--providers <csv>]`);
  }
  return options;
}

function parseDoctorArgs(args: string[]): { fix: boolean } {
  for (const arg of args) {
    if (arg === "--fix") return { fix: true };
    if (arg === "--help" || arg === "-h") {
      console.log("Usage:\n  hearth doctor [--fix]\n\n--fix rewrites a trailing /mcp in server.publicBaseUrl to its origin.");
      return { fix: false };
    }
    throw new Error(`Unknown doctor option: ${arg}. Usage: hearth doctor [--fix]`);
  }
  return { fix: false };
}

function parseInitDestinations(value: string | undefined, fallback: OnboardingDestination[]): OnboardingDestination[] {
  if (!value) return fallback;
  const normalized = value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const destinations: OnboardingDestination[] = [];
  for (const part of normalized) {
    if (part === "both") return ["chatgpt", "coding-agents"];
    if (part === "chatgpt" || part === "coding-agents") {
      if (!destinations.includes(part)) destinations.push(part);
      continue;
    }
    throw new Error(`Unknown --use value: ${value}. Use chatgpt, coding-agents, or both.`);
  }
  if (destinations.length === 0) throw new Error(`Unknown --use value: ${value}. Use chatgpt, coding-agents, or both.`);
  return destinations;
}

async function runInit({ force, yes, roots, publicUrl, use, providers }: InitOptions): Promise<void> {
  const files = loadHearthFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`Hearth is already configured at ${files.dir}`);
    prompts.log.info("Run `hearth init --force` to update it.");
    return;
  }

  try {
    if (yes && !use) {
      throw new Error("hearth init --yes requires --use chatgpt|coding-agents|both.");
    }
    const nonInteractive = yes || roots !== undefined || publicUrl !== undefined || use !== undefined || providers !== undefined;
    if (nonInteractive && (!input.isTTY || !output.isTTY)) {
      // Allow fully-flagged runs in non-TTY; fall through to flagged path.
    }
    if (nonInteractive && use === undefined && !yes) {
      // Partial flags still need a destination; default preserves old behavior.
    }
    const fallbackDestinations: OnboardingDestination[] = files.config.server.publicBaseUrl ? ["chatgpt"] : ["coding-agents"];

    let destinations: OnboardingDestination[];
    let rootsInput: string | undefined = roots;
    let publicUrlInput: string | undefined = publicUrl;
    let providersInput: string | undefined = providers;
    if (nonInteractive) {
      destinations = parseInitDestinations(use, fallbackDestinations);
    } else {
      prompts.intro("Hearth setup");
      const destinationAnswer = await prompts.multiselect({
        message: "Where will you use Hearth?",
        options: [
          {
            value: "chatgpt",
            label: "ChatGPT",
            hint: "Connect ChatGPT to projects on this computer.",
          },
          {
            value: "coding-agents",
            label: "Coding Agents",
            hint: "Use Hearth from Codex, Claude Code, OpenCode, Pi, and similar tools.",
          },
        ],
        initialValues: files.config.server.publicBaseUrl ? ["chatgpt"] : ["coding-agents"],
        required: true,
      });
      if (prompts.isCancel(destinationAnswer)) throw new SetupCancelledError();
      destinations = destinationAnswer as OnboardingDestination[];
    }
    const usage = resolveOnboardingUsage(destinations);
    const useChatGpt = usesChatGpt(usage);
    const useCodingAgents = usesCodingAgents(usage);

    let allowedRoots: string[] | undefined;
    if (useChatGpt) {
      const defaultRoots = files.config.workspaces.allowedRoots.join(", ") || process.cwd();
      let rootsAnswer: string;
      if (rootsInput !== undefined) {
        rootsAnswer = rootsInput.trim() || defaultRoots;
        if (!rootsAnswer.trim()) throw new Error("Enter at least one project root via --roots.");
      } else if (nonInteractive) {
        rootsAnswer = defaultRoots;
      } else {
        rootsAnswer = await textPrompt({
          message: `Which project folders can Hearth access? Press Enter to use ${defaultRoots}`,
          placeholder: defaultRoots,
          defaultValue: defaultRoots,
          validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
        });
      }
      allowedRoots = rootsAnswer
        .split(",")
        .map((root) => resolve(expandHomePath(root.trim())))
        .filter(Boolean);
      if (allowedRoots.length === 0) throw new Error("Enter at least one project root.");
    }

    const port = files.config.server.port;

    let publicBaseUrl: string | null = null;
    if (useChatGpt) {
      if (publicUrlInput !== undefined) {
        const trimmed = publicUrlInput.trim() || files.config.server.publicBaseUrl || "";
        const validation = validateRequiredPublicBaseUrl(trimmed || undefined);
        if (validation) throw new Error(validation);
        publicBaseUrl = normalizePublicBaseUrl(trimmed);
      } else if (nonInteractive) {
        if (!files.config.server.publicBaseUrl) {
          throw new Error("hearth init --yes for ChatGPT requires --public-url https://your-tunnel-host.example.com (origin only, without /mcp).");
        }
        publicBaseUrl = normalizePublicBaseUrl(files.config.server.publicBaseUrl);
      } else {
        prompts.note(
          [
            `Point your HTTPS tunnel or reverse proxy to http://127.0.0.1:${port}.`,
            "Paste its public URL below.",
            "",
            "Example: https://your-tunnel-host.example.com",
          ].join("\n"),
          "Connect ChatGPT",
        );
        publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
          message: files.config.server.publicBaseUrl
            ? `What public URL will ChatGPT connect to? Press Enter to keep ${files.config.server.publicBaseUrl}`
            : "What public URL will ChatGPT connect to?",
          placeholder: files.config.server.publicBaseUrl ?? "https://your-tunnel-host.example.com",
          defaultValue: files.config.server.publicBaseUrl ?? "",
          validate: validateRequiredPublicBaseUrl,
        }));
      }
    }

    const currentSubagents = files.config.subagents;
    const availability = getLocalAgentProviderAvailabilitySnapshot();
    const configuredProviders = currentSubagents.providers
      .filter((provider) => provider.enabled)
      .map((provider) => provider.id);
    const initialValues = configuredProviders.length > 0
      ? configuredProviders
      : availability
          .filter((provider) => provider.available)
          .map((provider) => provider.name);
    let selectedProviders: LocalAgentProvider[];
    if (providersInput !== undefined) {
      const wanted = providersInput.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean) as LocalAgentProvider[];
      const known = new Set(availability.map((provider) => provider.name));
      for (const name of wanted) {
        if (!known.has(name as LocalAgentProvider)) throw new Error(`Unknown provider: ${name}.`);
      }
      selectedProviders = wanted;
    } else if (nonInteractive) {
      selectedProviders = initialValues as LocalAgentProvider[];
    } else {
      const providerAnswer = await prompts.multiselect({
        message: "Which Coding Agents should be available?",
        options: availability.map((provider) => ({
          value: provider.name,
          label: provider.name,
          hint: provider.available
            ? provider.note ?? "available"
            : `unavailable: ${provider.reason ?? "provider preflight failed"}`,
        })),
        initialValues,
        required: true,
      });
      if (prompts.isCancel(providerAnswer)) throw new SetupCancelledError();
      selectedProviders = providerAnswer as LocalAgentProvider[];
    }
    const subagents = updateOnboardingSubagentsConfig(
      currentSubagents,
      selectedProviders,
    );

    // `init --force` rotates the owner password so "password not accepted"
    // recovery never keeps a credential the user considers lost.
    const auth = {
      ownerToken: force || !files.auth.ownerToken
        ? generateOwnerToken()
        : files.auth.ownerToken,
    };

    setHearthConfigValues([
      { path: ["server", "port"], value: port },
      ...(useChatGpt
        ? [{ path: ["server", "publicBaseUrl"], value: publicBaseUrl }]
        : []),
      ...(allowedRoots
        ? [{ path: ["workspaces", "allowedRoots"], value: allowedRoots }]
        : []),
      { path: ["subagents"], value: subagents },
    ]);
    writeHearthAuth(auth);

    const lines = [
      ...(allowedRoots ? [`Project folders: ${allowedRoots.join(", ")}`] : []),
      `Coding Agents: ${selectedProviders.join(", ")}`,
      ...(publicBaseUrl ? [`ChatGPT connection URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "Hearth is ready");
    if (useChatGpt) {
      prompts.note(
        [
          `Owner password: ${auth.ownerToken}`,
          "Use this when ChatGPT asks you to approve Hearth access.",
        ].join("\n"),
        "Owner password",
      );
    }
    if (useCodingAgents) {
      prompts.note(
        [
          SUBAGENT_SKILL_INSTALL_COMMAND,
          "",
          "The Skills CLI will let you choose which Coding Agents receive it.",
        ].join("\n"),
        "Install the Subagents skill",
      );
    }
    const nextSteps = [
      useChatGpt ? "Run `hearth serve`, then `hearth connect` for per-host steps." : undefined,
      useCodingAgents ? "Run the skill command above before delegating from your Coding Agents." : undefined,
    ].filter(Boolean).join(" ");
    if (nonInteractive) {
      console.log(["Hearth is ready", ...lines].join("\n"));
      if (useChatGpt) console.log(`Owner password: ${auth.ownerToken}`);
      console.log(nextSteps);
    } else {
      prompts.outro(nextSteps);
    }
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function runTokenCommand(args: string[]): Promise<void> {
  const { loadConfig } = await import("./config.js");
  const { DeviceTokenStore } = await import("./device-tokens.js");
  const [sub, ...rest] = args;
  const store = new DeviceTokenStore(loadConfig().stateDir);
  try {
    if (sub === "create") {
      const name = rest[0]?.trim();
      if (!name) throw new Error("Usage: hearth token create <name>");
      const { token, record } = store.create(name);
      console.log(`Device token created: ${record.createdAt}`);
      console.log(token);
      console.log("Store it now — it is shown only once and cannot be recovered.");
      return;
    }
    if (sub === "list" || sub === undefined) {
      const tokens = store.list();
      if (tokens.length === 0) {
        console.log("No device tokens. Create one: hearth token create <name>");
        return;
      }
      for (const token of tokens) {
        console.log(`${token.name}  created ${token.createdAt}${token.lastUsedAt ? `  last used ${token.lastUsedAt}` : "  never used"}`);
      }
      return;
    }
    if (sub === "revoke") {
      const name = rest[0]?.trim();
      if (!name) throw new Error("Usage: hearth token revoke <name>");
      if (store.revoke(name)) console.log(`Revoked device token: ${name}`);
      else console.log(`No device token named ${name}.`);
      return;
    }
    throw new Error("Usage: hearth token create <name> | list | revoke <name>");
  } finally {
    store.close();
  }
}

async function runMcp(): Promise<void> {
  const files = loadHearthFiles();
  if (!files.configExists || (!files.authExists && !process.env.HEARTH_OAUTH_OWNER_TOKEN)) {
    throw new Error(
      [
        "Hearth is not configured.",
        "",
        "Run `hearth init` once, then point your local MCP client at:",
        "  hearth mcp",
      ].join("\n"),
    );
  }
  const { loadConfig } = await import("./config.js");
  const { runStdioServer } = await import("./stdio-server.js");
  await runStdioServer(loadConfig());
}

function logServeBanner(
  config: { host: string; port: number; publicBaseUrl: string; allowedRoots: string[]; allowedHosts: string[]; logging: { level: string; format: string }; stateDir: string },
  localAgentProviders: readonly import("./local-agent-catalog.js").LocalAgentProviderStatus[],
  scheme: "http" | "https",
): void {
  let machineId = "unknown";
  try {
    const { loadMachineIdentity } = require("./machine-id.js") as typeof import("./machine-id.js");
    machineId = loadMachineIdentity(config.stateDir).id;
  } catch {
    // Banner must never fail because identity storage is unavailable.
  }
  const publicMcpUrl = new URL("/mcp", config.publicBaseUrl).toString();
  console.log(`hearth listening on ${scheme}://${config.host}:${config.port}/mcp`);
  console.log(`public MCP URL: ${publicMcpUrl}`);
  console.log(`machine: ${machineId} (hearth id, diagnostic label only — not a security boundary)`);
  console.log(`dashboard: ${scheme}://${config.host}:${config.port}/dashboard`);
  console.log(`public base url: ${config.publicBaseUrl}`);
  console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
  console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
  if (config.allowedHosts.includes("*")) {
    console.warn("warning: Host header allowlist is disabled because server.allowedHosts contains '*'");
  }
  if (scheme === "https") console.log("tls: native termination from tls.certFile/tls.keyFile");
  console.log("auth: Owner password approval required");
  console.log(`logging: ${config.logging.level} ${config.logging.format}`);
  console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);
  console.log("next: run `hearth connect` for ChatGPT / Claude / generic MCP steps");
}

async function serve(): Promise<void> {
  const sqliteStatus = checkSqliteNative();
  if (sqliteStatus !== "ok") {
    throw new Error(
      [
        "better-sqlite3 could not load for this Node runtime.",
        sqliteStatus,
        "",
        "Try reinstalling or rebuilding dependencies under the active Node version:",
        "  npm rebuild better-sqlite3",
      ].join("\n"),
    );
  }

  const { createServer } = await import("./server.js");
  const config = loadConfig();
  const { app, close, localAgentProviders } = createServer(config);
  const tlsOn = Boolean(config.tls.certFile && config.tls.keyFile);
  if (Boolean(config.tls.certFile) !== Boolean(config.tls.keyFile)) {
    throw new Error("tls.certFile and tls.keyFile must be set together (or both left null).");
  }
  let httpServer;
  if (tlsOn) {
    const { readFileSync } = await import("node:fs");
    const { createServer: createHttpsServer } = await import("node:https");
    const { expandHomePath } = await import("./roots.js");
    httpServer = createHttpsServer(
      {
        key: readFileSync(expandHomePath(config.tls.keyFile!)),
        cert: readFileSync(expandHomePath(config.tls.certFile!)),
      },
      app,
    ).listen(config.port, config.host, () => {
      logServeBanner(config, localAgentProviders, "https");
    });
  } else {
    httpServer = app.listen(config.port, config.host, () => {
      logServeBanner(config, localAgentProviders, "http");
    });
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("hearth shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

async function runDoctor({ fix }: { fix: boolean }): Promise<void> {
  const files = loadHearthFiles();
  console.log(`Config dir: ${files.dir}`);
  console.log(`Config file: ${files.configExists ? files.configPath : "missing"}`);
  console.log(`Auth file: ${files.authExists ? files.authPath : "missing"}`);
  console.log(`Node: ${process.version} (${nodeVersionStatus()})`);
  console.log(`Node ABI: ${process.versions.modules}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Git: ${checkGitAvailable()}`);
  console.log(`Bash shell: ${checkBashShell()}`);
  console.log(`SQLite native dependency: ${checkSqliteNative()}`);

  try {
    if (fix) {
      const raw = String(files.config.server.publicBaseUrl ?? "");
      if (/\/mcp\/?$/i.test(raw.trim())) {
        const origin = new URL(raw).origin;
        setHearthConfigValue(["server", "publicBaseUrl"], origin);
        console.log(`Fixed publicBaseUrl: stripped trailing /mcp -> ${origin}`);
      }
    }
    const config = loadConfig();
    let machineId = "unknown";
    try {
      const { loadMachineIdentity } = await import("./machine-id.js");
      machineId = loadMachineIdentity(config.stateDir).id;
    } catch {
      // Identity is advisory in doctor output.
    }
    console.log(`Machine: ${machineId} (hearth id)`);
    console.log(`Local MCP URL: http://${config.host}:${config.port}/mcp`);
    console.log(`Public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`);
    console.log(`Dashboard: http://${config.host}:${config.port}/dashboard`);
    console.log(`Allowed roots: ${config.allowedRoots.join(", ") || "(none — MCP open_workspace will reject every path)"}`);
    console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
    console.log(`Redirect hosts: ${config.oauth.allowedRedirectHosts.join(", ")}`);
    const providers = buildLocalAgentProviderStatuses(
      config.subagents,
      getLocalAgentProviderAvailabilitySnapshot(),
    );
    console.log(`Subagents: ${config.subagents.enabled ? "enabled" : "disabled"}`);
    console.log(`Subagent providers: ${formatLocalAgentProviderStatusSummary(providers)}`);
    console.log(`Tool mode: ${config.toolMode}`);
    const warnings: string[] = [];
    if (config.allowedHosts.includes("*")) warnings.push("server.allowedHosts contains '*': Host header checks are disabled (local debugging only).");
    if (config.allowedRoots.length === 0) warnings.push("workspaces.allowedRoots is empty: MCP file tools fall back to cwd. Run hearth init to set narrow roots.");
    if (!config.publicBaseUrl.startsWith("https://") && config.publicBaseUrl !== `http://${config.host}:${config.port}`) {
      warnings.push("server.publicBaseUrl is http: remote MCP clients require public https. Use your tunnel's https origin.");
    }
    for (const host of ["chatgpt.com", "claude.ai"]) {
      if (!config.oauth.allowedRedirectHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`) || allowed.endsWith(host))) {
        warnings.push(`oauth.allowedRedirectHosts is missing ${host}: that host's OAuth redirect will be rejected.`);
      }
    }
    if (process.platform === "win32") warnings.push("Windows: shell tools require Git Bash, WSL, MSYS2, or Cygwin Bash (PowerShell/cmd not supported).");
    for (const warning of warnings) console.log(`warning: ${warning}`);
    if (!fix && /\/mcp\/?$/i.test(String(files.config.server.publicBaseUrl ?? ""))) {
      console.log("hint: run `hearth doctor --fix` to strip trailing /mcp from publicBaseUrl.");
    }
  } catch (error) {
    console.log(`Config status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runConnect(args: string[]): Promise<void> {
  const host = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
  if (args.includes("--help") || args.includes("-h")) {
    console.log(["Usage:", "  hearth connect [chatgpt|claude|generic]", "", "Prints copy-paste MCP connection steps for this PC."].join("\n"));
    return;
  }
  if (host && !["chatgpt", "claude", "generic", "all"].includes(host)) {
    throw new Error(`Unknown connect target: ${host}. Use chatgpt, claude, or generic.`);
  }
  const config = loadConfig();
  const { loadMachineIdentity } = await import("./machine-id.js");
  const identity = loadMachineIdentity(config.stateDir);
  const publicMcpUrl = new URL("/mcp", config.publicBaseUrl).toString();
  const localMcpUrl = `http://${config.host}:${config.port}/mcp`;
  const wanted = host ?? "all";
  const lines: string[] = [
    `machine: ${identity.id} (${identity.hostname})`,
    `public MCP URL (use this in remote clients): ${publicMcpUrl}`,
    `local MCP URL: ${localMcpUrl}`,
    `dashboard: http://${config.host}:${config.port}/dashboard`,
    `tool mode: ${config.toolMode} (ChatGPT works with either; Claude Desktop prefers tools.mode claude)`,
    "",
  ];
  if (wanted === "all" || wanted === "chatgpt") {
    lines.push(
      "ChatGPT:",
      `  1. hearth serve (keep running) + tunnel pointing at http://${config.host}:${config.port} (proxy the whole origin, not only /mcp).`,
      `  2. Add connector URL: ${publicMcpUrl}`,
      "  3. Approve with the Owner password from ~/.hearth/auth.json (hearth init prints it).",
      "",
    );
  }
  if (wanted === "all" || wanted === "claude") {
    lines.push(
      "Claude (Desktop / Code with remote MCP):",
      `  1. Ensure oauth.allowedRedirectHosts includes claude.ai (current: ${config.oauth.allowedRedirectHosts.join(", ")}).`,
      `  2. Add MCP server URL: ${publicMcpUrl} and approve with the Owner password.`,
      "  3. For local-only use without OAuth: hearth token create claude-local, then `hearth mcp` as a stdio server with that bearer.",
      "",
    );
  }
  if (wanted === "all" || wanted === "generic") {
    lines.push(
      "Any MCP client (generic):",
      `  Remote (OAuth): ${publicMcpUrl}`,
      `  Local stdio (no OAuth browser round-trip): hearth mcp`,
      "  Local with device token: hearth token create <name>, then use it as the MCP Authorization bearer.",
      "",
    );
  }
  lines.push("Do not reuse this public URL on another PC: OAuth tokens are bound to this machine's resource URL and owner password.");
  lines.push("The machine id is a diagnostic label, not a security boundary: copying stateDir copies the identity, so it cannot prove which PC answered or prevent cloning.");
  console.log(lines.join("\n"));
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadHearthFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  if (key !== "publicBaseUrl") {
    throw new Error("Only `hearth config set publicBaseUrl <url|null>` is supported right now.");
  }

  const value = rest.join(" ").trim();
  if (!value) {
    throw new Error("Missing publicBaseUrl value.");
  }

  setHearthConfigValue(
    ["server", "publicBaseUrl"],
    normalizeOptionalPublicBaseUrl(value),
  );
  console.log(`Updated ${files.configPath}`);
}

function runMachineId(): void {
  const config = loadConfig();
  void import("./machine-id.js").then(({ loadMachineIdentity }) => {
    const identity = loadMachineIdentity(config.stateDir);
    console.log(JSON.stringify(identity, null, 2));
  });
}

/**
 * Relay-free exposure report: tells the owner exactly what stands between
 * this PC and a direct public URL, without routing through any tunnel
 * service. Honest by design: a public URL needs (1) an inbound route to this
 * machine and (2) a domain with a valid certificate. Hearth automates
 * everything after those two owner-provided prerequisites.
 */
async function runExpose(): Promise<void> {
  const config = loadConfig();
  const { loadMachineIdentity } = await import("./machine-id.js");
  const identity = loadMachineIdentity(config.stateDir);
  const { execFileSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { expandHomePath } = await import("./roots.js");

  let publicIp: string | undefined;
  try {
    const out = execFileSync("dig", ["+short", "+time=5", "myip.opendns.com", "@resolver1.opendns.com"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim().split("\n").pop()?.trim();
    if (out && /^[0-9a-fA-F.:]+$/.test(out)) publicIp = out;
  } catch {
    // dig absent or blocked: report without a public IP guess.
  }

  const certSet = Boolean(config.tls.certFile && config.tls.keyFile);
  const certPresent = certSet
    && existsSync(expandHomePath(config.tls.certFile!))
    && existsSync(expandHomePath(config.tls.keyFile!));
  const publicUrl = new URL(config.publicBaseUrl);
  const directHttps = publicUrl.protocol === "https:" && certSet;

  const lines = [
    `machine: ${identity.id} (${identity.hostname}, ${identity.platform}/${identity.arch})`,
    `bind: ${config.host}:${config.port}  (hearth serve)`,
    `public base url: ${config.publicBaseUrl}`,
    `public MCP URL (keep one URL per PC — reusing it elsewhere splits approvals and audit): ${new URL("/mcp", config.publicBaseUrl).toString()}`,
    `public IP seen from here: ${publicIp ?? "unknown (dig unavailable or blocked)"}`,
    `native TLS: ${!certSet ? "off (tls.certFile/tls.keyFile unset)" : certPresent ? "cert + key present" : "CONFIGURED BUT FILES MISSING"}`,
    `ACME webroot: ${config.tls.acmeDir ?? "unset"}`,
    "",
    "OAuth tokens are bound to this machine's resource URL and Owner password.",
    "Run `hearth connect` for ChatGPT / Claude / generic MCP steps.",
    "",
    directHttps && certPresent
      ? "status: DIRECT — publicBaseUrl is https and TLS material is present. Forward TCP 443 to this machine, point your domain's A/AAAA record at the public IP, restart serve."
      : "status: NOT directly reachable — to drop the relay you need:",
    ...(!directHttps || !certPresent ? [
      "  1. A domain whose A/AAAA record points at this machine (public IP above).",
      "  2. TCP 443 (and TCP 80 for issuance) forwarded to this machine.",
      "  3. Certificates, e.g.: certbot certonly --webroot -w <dir> -d <domain>",
      "     with tls.acmeDir set to <dir> so Hearth serves the HTTP-01 challenge.",
      "  4. tls.certFile/tls.keyFile set to the issued files,",
      "     hearth config set publicBaseUrl https://<domain>, then restart serve.",
    ] : []),
    "",
    "Without an inbound route + domain, some relay must carry the traffic;",
    "that relay can be your own VPS — never a third party you don't control.",
  ];
  console.log(lines.join("\n"));
}

function printHelp(): void {
  console.log(
    [
      "Hearth",
      "",
      "Usage:",
      "  hearth                 Run first-time setup if needed, then start the server",
      "  hearth serve           Start the server",
      "  hearth init [--force] [--yes --use chatgpt|coding-agents|both --roots <csv> --public-url <url> --providers <csv>]",
      "  hearth doctor [--fix]  Show config, runtime, and native dependency status",
      "  hearth connect [chatgpt|claude|generic]  Print copy-paste MCP connection steps for this PC",
      "  hearth config get      Print persisted config",
      "  hearth config set publicBaseUrl <url|null>  (origin only, without /mcp)",
      "  hearth show-changes <review-ref> [--json]",
      "  hearth agents ls       List subagent sessions",
      "  hearth agents run <profile-or-provider> [--model <model>] [--effort <level>] <prompt>",
      "  hearth agents continue <id> [--model <model>] [--effort <level>] <prompt>",
      "  hearth agents show <id>",
      "  hearth agents daemon <status|stop|logs>",
      "  hearth expose          Relay-free exposure report for this PC (own domain + TLS)",
      "  hearth id              Print this machine's stable Hearth identity",
      "  hearth -v, --version   Print the installed version",
      "",
      "Examples:",
      "  npm install -g @sunshinelive83/hearth",
      "  hearth init",
      "  hearth serve",
      "  hearth connect",
      "",
      "For temporary tunnels:",
      "  hearth config set publicBaseUrl https://your-tunnel-host.example.com",
      "  hearth serve",
    ].join("\n"),
  );
}

async function runShowChanges(args: string[]): Promise<void> {
  const { args: commandArgs, json } = extractJsonOption(args);
  const [reviewRef, ...extra] = commandArgs;
  if (!reviewRef || extra.length > 0) {
    throw new Error("Usage: hearth show-changes <review-ref> [--json]");
  }

  const config = loadConfig();
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const review = await readReviewRef(scope.workspaceRoot, reviewRef);
  if (json) {
    printJson(review);
    return;
  }
  console.log(review.patch || review.result);
}

async function runAgentsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const { args: commandArgs, json } = extractJsonOption(rest);
  switch (subcommand) {
    case "ls":
    case "list":
      await runAgentsList(commandArgs, json);
      return;
    case "run":
      await runAgentsRun(commandArgs, json);
      return;
    case "continue":
      await runAgentsContinue(commandArgs, json);
      return;
    case "show":
      await runAgentsShow(commandArgs, json);
      return;
    case "targets":
      await runAgentsTargets(commandArgs, json);
      return;
    case "daemon":
      await runAgentsDaemon(commandArgs, json);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printAgentsHelp();
      return;
    default:
      throw new Error(`Unknown agents command: ${subcommand}`);
  }
}

async function runAgentsTargets(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) throw new Error("Usage: hearth agents targets [--json]");
  const config = loadConfig();
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const profiles = await loadLocalAgentProfiles(config, scope.workspaceRoot);
  const providers = buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );
  const catalog = buildLocalAgentCatalog(config.subagents, profiles, providers);
  const output = presentAgentTargetCatalog(catalog);
  if (json) printJson(output);
  else console.log(formatAgentTargetCatalog(output));
}

async function runAgentsList(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) throw new Error("Usage: hearth agents ls [--json]");
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const result = await client.list(resolveCliWorkspaceContext(config.allowedRoots));
  const agents = presentAgentResult(result, json);
  if (!agents) return;

  const summaries = agents.map(presentAgentSummary);
  if (json) {
    printJson(summaries);
    return;
  }

  if (agents.length === 0) {
    console.log("No subagent sessions found for this workspace.");
    return;
  }

  for (const summary of summaries) {
    console.log(formatAgentSummary(summary));
  }
}

async function runAgentsRun(args: string[], json: boolean): Promise<void> {
  const parsed = parseLocalAgentRunArgs(args);
  const config = loadConfig();
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const client = createLocalAgentClient(config);
  const result = await client.start({
    target: parsed.target,
    prompt: parsed.prompt,
    workspaceRoot: scope.workspaceRoot,
    workspaceId: scope.workspaceId,
    model: parsed.model,
    effort: parsed.effort,
  });
  const record = presentAgentResult(result, json);
  if (!record) return;
  const receipt = presentAgentReceipt(record);
  if (json) {
    printJson(receipt);
    return;
  }
  console.log(formatAgentReceipt(receipt));
}

async function runAgentsContinue(args: string[], json: boolean): Promise<void> {
  const parsed = parseLocalAgentContinueArgs(args);
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const result = await client.continue(parsed.agentId, parsed.prompt, {
    model: parsed.model,
    effort: parsed.effort,
  }, scope);
  const record = presentAgentResult(result, json);
  if (!record) return;
  const receipt = presentAgentReceipt(record);
  if (json) {
    printJson(receipt);
    return;
  }
  console.log(formatAgentReceipt(receipt));
}

async function runAgentsShow(args: string[], json: boolean): Promise<void> {
  const [id, ...extra] = args;
  if (!id || extra.length > 0) throw new Error("Usage: hearth agents show <id> [--json]");

  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const initial = await client.get(id, scope);
  let record = presentAgentResult(initial, json);
  if (!record) return;

  const deadline = Date.now() + 15_000;
  while ((record.status === "starting" || record.status === "running") && Date.now() < deadline) {
    await sleep(500);
    const refreshed = presentAgentResult(await client.get(id, scope), json);
    if (!refreshed) return;
    record = refreshed;
  }

  const observation = presentAgentObservation(record);
  if (json) printJson(observation);
  else console.log(formatAgentObservation(observation));
}

async function runAgentsDaemon(args: string[], json: boolean): Promise<void> {
  const [subcommand, ...extra] = args;
  if (extra.length > 0) throw new Error("Usage: hearth agents daemon <status|stop|logs> [--json]");
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  switch (subcommand) {
    case "status": {
      const status = presentAgentResult(await client.status(), json);
      if (!status) return;
      printJson(status);
      return;
    }
    case "stop": {
      const status = presentAgentResult(await client.stop(), json);
      if (!status) return;
      if (json) printJson(status);
      else console.log("Local agent daemon stop requested.");
      return;
    }
    case "logs": {
      const logs = presentAgentResult(await client.logs(), json);
      if (logs === undefined) return;
      if (json) printJson({ logs });
      else console.log(logs || "No local agent daemon logs found.");
      return;
    }
    default:
      throw new Error("Usage: hearth agents daemon <status|stop|logs>");
  }
}

function extractJsonOption(args: string[]): { args: string[]; json: boolean } {
  const commandArgs: string[] = [];
  let json = false;
  let optionsEnded = false;
  for (const argument of args) {
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      commandArgs.push(argument);
      continue;
    }
    if (!optionsEnded && argument === "--json") {
      json = true;
      continue;
    }
    commandArgs.push(argument);
  }
  return { args: commandArgs, json };
}

function presentAgentResult<T, E extends LocalAgentError>(
  result: BetterResult<T, E>,
  json: boolean,
): T | undefined {
  if (result.isOk()) return result.value;
  if (json) {
    printJson({ error: toAgentErrorPayload(result.error) });
    process.exitCode = 1;
    return undefined;
  }
  throw new Error(result.error.message);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function printAgentsHelp(): void {
  console.log(
    [
      "Hearth agents",
      "",
      "Usage:",
      "  hearth agents ls [--json]",
      "  hearth agents run <profile-or-provider> [--model <model>] [--effort <level>] [--json] <prompt>",
      "  hearth agents continue <id> [--model <model>] [--effort <level>] [--json] <prompt>",
      "  hearth agents show <id> [--json]",
      "  hearth agents targets [--json]",
      "  hearth agents daemon <status|stop|logs> [--json]",
    ].join("\n"),
  );
}

function printVersion(): void {
  const packageJson = require("../package.json") as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("Unable to read Hearth package version.");
  }

  console.log(packageJson.version);
}

function normalizeOptionalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "none") return null;

  return normalizePublicBaseUrl(trimmed);
}

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  if (/(^|\/)mcp$/i.test(parsed.pathname)) {
    throw new Error(
      `Use the origin without /mcp (for example https://${parsed.host}). Got: ${trimmed}`,
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

type TextPromptOptions = Omit<Parameters<typeof prompts.text>[0], "validate"> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) => options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

function validateRequiredPublicBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter the public URL from your tunnel or reverse proxy.";
  if (trimmed.endsWith("/mcp")) return "Enter the base URL only, without /mcp.";
  return validatePublicBaseUrl(trimmed);
}

function validatePublicBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "Use an http or https URL.";
  } catch {
    return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
  }
}

function assertSupportedNode(): void {
  if (satisfies(process.versions.node, SUPPORTED_NODE_RANGE)) return;

  throw new Error(
    [
      `Hearth requires Node ${SUPPORTED_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
      "Install Node 22 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"),
  );
}

function nodeVersionStatus(): string {
  return satisfies(process.versions.node, SUPPORTED_NODE_RANGE)
    ? `supported ${SUPPORTED_NODE_RANGE}`
    : `unsupported, requires ${SUPPORTED_NODE_RANGE}`;
}

class SetupCancelledError extends Error {}

function checkSqliteNative(): string {
  try {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkGitAvailable(): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

function checkBashShell(): string {
  try {
    const { shell, args } = getShellConfig();
    return `${shell} ${args.join(" ")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
