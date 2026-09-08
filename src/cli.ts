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
import {
  NGROK_AGENT_API,
  checkNgrokAuth,
  findNgrok,
  isNgrokChildAlive,
  ngrokInstallHint,
  ngrokPaths,
  ngrokVersion,
  normalizeNgrokDomain,
  parseAgentTunnels,
  startNgrokChild,
  validateManagedNgrok,
  validateNgrokDomain,
  waitForAgentDomain,
} from "./tunnel-ngrok.js";

type Command =
  | "serve"
  | "mcp"
  | "token"
  | "init"
  | "doctor"
  | "config"
  | "agents"
  | "show-changes"
  | "id"
  | "connect"
  | "ngrok"
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
      await serve(args);
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
    case "id":
      runMachineId();
      return;
    case "connect":
      await runConnect(args);
      return;
    case "ngrok":
      await runNgrokCli(args);
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
    || command === "connect"
    || command === "ngrok"
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
          throw new Error("hearth init --yes for ChatGPT requires --public-url https://xxx.ngrok-free.dev (origin only, without /mcp).");
        }
        publicBaseUrl = normalizePublicBaseUrl(files.config.server.publicBaseUrl);
      } else {
      prompts.note(
        [
          `Point ngrok at http://127.0.0.1:${port} (see \`hearth ngrok setup\`),`,
          "then paste its public URL below.",
          "",
          "Example: https://your-domain.ngrok-free.dev",
        ].join("\n"),
        "Connect ChatGPT",
      );
        publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
          message: files.config.server.publicBaseUrl
            ? `What public URL will ChatGPT connect to? Press Enter to keep ${files.config.server.publicBaseUrl}`
            : "What public URL will ChatGPT connect to?",
          placeholder: files.config.server.publicBaseUrl ?? "https://xxx.ngrok-free.dev",
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
  config: { host: string; port: number; publicBaseUrl: string; allowedRoots: string[]; allowedHosts: string[]; logging: { level: string; format: string }; stateDir: string; tunnel: { provider: string; domain: string | null } },
  localAgentProviders: readonly import("./local-agent-catalog.js").LocalAgentProviderStatus[],
  liveDomain: string | null,
): void {
  let machineId = "unknown";
  try {
    const { loadMachineIdentity } = require("./machine-id.js") as typeof import("./machine-id.js");
    machineId = loadMachineIdentity(config.stateDir).id;
  } catch {
    // Banner must never fail because identity storage is unavailable.
  }
  const publicMcpUrl = new URL("/mcp", config.publicBaseUrl).toString();
  console.log(`hearth listening on http://${config.host}:${config.port}/mcp`);
  console.log(`public MCP URL: ${publicMcpUrl}`);
  if (liveDomain) {
    console.log(`tunnel: ngrok ${liveDomain} live (managed — server, URL, and tunnel in one command)`);
  } else if (config.tunnel.provider === "ngrok" && config.tunnel.domain) {
    console.log(`tunnel: ngrok ${config.tunnel.domain} saved (pass --ngrok to serve through it)`);
  }
  console.log(`machine: ${machineId} (hearth id, diagnostic label only — not a security boundary)`);
  console.log(`dashboard: http://${config.host}:${config.port}/dashboard`);
  console.log(`public base url: ${config.publicBaseUrl}`);
  console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
  console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
  if (config.allowedHosts.includes("*")) {
    console.warn("warning: Host header allowlist is disabled because server.allowedHosts contains '*'");
  }
  console.log("auth: Owner password approval required");
  console.log(`logging: ${config.logging.level} ${config.logging.format}`);
  console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);
  console.log("next: run `hearth connect` for ChatGPT / Claude / generic MCP steps");
}

async function serve(argv: string[] = []): Promise<void> {
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
  const useNgrok = argv.includes("--ngrok");
  if (useNgrok && config.tunnel.provider !== "ngrok") {
    throw new Error("`serve --ngrok` needs a saved ngrok domain. Run `hearth ngrok setup` first.");
  }
  if (!useNgrok && config.tunnel.provider === "ngrok" && config.tunnel.domain) {
    console.log(`tunnel: ngrok domain ${config.tunnel.domain} saved but --ngrok not passed; serving locally only.`);
  }
  const managedNgrok = useNgrok ? await startManagedNgrok(config) : undefined;
  const { app, close, localAgentProviders } = createServer(config);
  const httpServer = app.listen(config.port, config.host, () => {
    logServeBanner(config, localAgentProviders, managedNgrok?.domain ?? null);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (managedNgrok) {
      try {
        await managedNgrok.stop();
      } catch (error) {
        console.error(`ngrok shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
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
    console.log(`Tunnel: ${describeNgrokConfig(config.tunnel)}`);
    const warnings: string[] = [];
    warnings.push(...checkNgrokConfig({ ...config, trustProxy: config.oauth.trustProxy }));
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
    config.tunnel.provider === "ngrok" && config.tunnel.domain
      ? `tunnel: managed ngrok (${config.tunnel.domain}) — \`hearth serve --ngrok\` starts everything`
      : "tunnel: none managed (`hearth ngrok setup` provisions this PC's static domain)",
    `local MCP URL: ${localMcpUrl}`,
    `dashboard: http://${config.host}:${config.port}/dashboard`,
    `tool mode: ${config.toolMode} (ChatGPT works with either; Claude Desktop prefers tools.mode claude)`,
    "",
  ];
  if (wanted === "all" || wanted === "chatgpt") {
    lines.push(
      "ChatGPT:",
      `  1. hearth serve --ngrok (keep running; it serves this PC's static domain).`,
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


function printNgrokHelp(): void {
  console.log(
    [
      "Hearth ngrok (managed per-PC tunnel — the only remote-access path)",
      "",
      "Usage:",
      "  hearth ngrok setup [--domain <static-domain>] [--yes]",
      "  hearth ngrok status [--json]",
      "  hearth serve --ngrok   Start the server with the tunnel (plain serve stays local-only)",
      "",
      "setup saves this PC's static ngrok domain (e.g. xxx.ngrok-free.dev),",
      "syncs server.publicBaseUrl, and enables server.trustProxy. Your ngrok",
      "authtoken stays in ngrok's own config: run `ngrok config add-authtoken`",
      "once if setup reports missing auth.",
    ].join("\n"),
  );
}

async function runNgrokCli(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printNgrokHelp();
    return;
  }
  if (subcommand === "status") {
    await runNgrokStatus(rest.includes("--json"));
    return;
  }
  if (subcommand === "setup") {
    await runNgrokSetup(rest);
    return;
  }
  throw new Error(`Unknown ngrok command: ${subcommand}. Usage: hearth ngrok <setup|status>`);
}

function describeNgrokConfig(tunnel: { provider: string; domain: string | null }): string {
  if (tunnel.provider !== "ngrok") return "none (local-only until `hearth ngrok setup`)";
  if (!tunnel.domain) return "ngrok (incomplete — re-run `hearth ngrok setup`)";
  return `ngrok ${tunnel.domain}`;
}

function checkNgrokConfig(config: {
  stateDir: string;
  publicBaseUrl: string;
  trustProxy: boolean;
  tunnel: { provider: string; domain: string | null };
}): string[] {
  const warnings: string[] = [];
  if (config.tunnel.provider !== "ngrok") return warnings;
  const binary = findNgrok();
  if (!binary) {
    warnings.push("tunnel.provider is ngrok but no ngrok binary is on PATH.");
    return warnings;
  }
  if (!config.tunnel.domain) {
    warnings.push("Managed ngrok tunnel is incomplete (domain missing). Re-run `hearth ngrok setup`.");
    return warnings;
  }
  let publicHost = "";
  try {
    publicHost = new URL(config.publicBaseUrl).hostname.toLowerCase();
  } catch {
    // loadConfig already guarantees a parseable publicBaseUrl.
  }
  if (publicHost !== config.tunnel.domain.toLowerCase()) {
    warnings.push(`tunnel.domain ${config.tunnel.domain} does not match publicBaseUrl host ${publicHost}. Re-run \`hearth ngrok setup\`.`);
  }
  if (!config.trustProxy) {
    warnings.push("Managed ngrok needs server.trustProxy=true so rate limits see real client IPs. Re-run `hearth ngrok setup`.");
  }
  const childPid = isNgrokChildAlive(ngrokPaths(config.stateDir).pidPath);
  if (childPid) {
    warnings.push(`A serve-managed ngrok child (pid ${childPid}) looks alive while serve may not be running; restart serve --ngrok to reconcile.`);
  }
  return warnings;
}

async function runNgrokStatus(json: boolean): Promise<void> {
  const files = loadHearthFiles();
  if (!files.configExists || (!files.authExists && !process.env.HEARTH_OAUTH_OWNER_TOKEN)) {
    throw new Error("Hearth is not configured. Run `hearth init` first, then `hearth ngrok setup`.");
  }
  const config = loadConfig();
  const tunnel = config.tunnel;
  if (tunnel.provider !== "ngrok" || !tunnel.domain) {
    if (json) {
      console.log(JSON.stringify({ provider: tunnel.provider, configured: false }));
      return;
    }
    console.log("No managed ngrok tunnel. Run `hearth ngrok setup --domain <static-domain>` on this PC.");
    return;
  }
  const binary = findNgrok();
  let version = "unknown";
  if (binary) {
    try {
      version = ngrokVersion(binary);
    } catch {
      // Version is advisory; the auth and agent checks below are authoritative.
    }
  }
  const auth = binary ? checkNgrokAuth(binary) : { ok: false, output: "ngrok not on PATH" };
  const childPid = isNgrokChildAlive(ngrokPaths(config.stateDir).pidPath);
  let agentUrl: string | undefined;
  let agentError: string | undefined;
  try {
    const response = await fetch(`${NGROK_AGENT_API}/tunnels`);
    if (!response.ok) throw new Error(`agent API returned ${response.status}`);
    const live = parseAgentTunnels(await response.json() as unknown);
    agentUrl = live.map((tunnel) => tunnel.publicUrl).join(", ") || undefined;
  } catch (error) {
    agentError = error instanceof Error ? error.message : String(error);
  }
  if (json) {
    console.log(JSON.stringify({
      provider: "ngrok",
      configured: true,
      domain: tunnel.domain,
      publicMcpUrl: new URL("/mcp", config.publicBaseUrl).toString(),
      ngrok: binary ? { binary, version, authOk: auth.ok } : null,
      childPid: childPid ?? null,
      agentUrl: agentUrl ?? null,
      agentError: agentError ?? null,
    }));
    return;
  }
  console.log([
    `tunnel: ngrok ${tunnel.domain}`,
    `public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`,
    `ngrok: ${binary ? `${binary} (${version}), auth ${auth.ok ? "ok" : "MISSING — run `ngrok config add-authtoken`"}` : "NOT FOUND on PATH"}`,
    childPid ? `serve-managed child: running (pid ${childPid})` : "serve-managed child: not running (start with `hearth serve --ngrok`)",
    agentUrl ? `agent serving: ${agentUrl}` : `agent: not reachable (${agentError ?? "is ngrok running?"})`,
  ].join("\n"));
}

function parseNgrokSetupArgs(args: string[]): { domain?: string; yes: boolean } {
  const options: { domain?: string; yes: boolean } = { yes: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--domain") options.domain = args[++index];
    else if (arg.startsWith("--domain=")) options.domain = arg.slice("--domain=".length);
    else throw new Error(`Unknown ngrok setup option: ${arg}. Usage: hearth ngrok setup [--domain <static-domain>] [--yes]`);
  }
  return options;
}

async function runNgrokSetup(args: string[]): Promise<void> {
  const options = parseNgrokSetupArgs(args);
  const files = loadHearthFiles();
  if (!files.configExists || (!files.authExists && !process.env.HEARTH_OAUTH_OWNER_TOKEN)) {
    throw new Error("Hearth is not configured. Run `hearth init` first, then `hearth ngrok setup`.");
  }
  const config = loadConfig();

  const binary = findNgrok();
  if (!binary) throw new Error(ngrokInstallHint());
  try {
    ngrokVersion(binary);
  } catch {
    // Version is advisory; the auth check below is authoritative.
  }
  const auth = checkNgrokAuth(binary);
  if (!auth.ok) {
    throw new Error(
      [
        "ngrok has no authtoken configured.",
        "Run `ngrok config add-authtoken <your-token>` once (token from https://dashboard.ngrok.com/get-started/your-authtoken), then re-run `hearth ngrok setup`.",
      ].join("\n"),
    );
  }

  let domain = options.domain?.trim();
  if (domain === undefined) {
    if (options.yes || !input.isTTY || !output.isTTY) {
      domain = config.tunnel.domain ?? undefined;
      if (!domain) throw new Error("Non-interactive setup needs --domain <static-domain>.");
    } else {
      prompts.note(
        "Hearth binds this PC to its static ngrok domain (free accounts get one stable xxx.ngrok-free.dev). Only AI endpoints are reachable through it; the dashboard stays localhost-only.",
        "Managed ngrok",
      );
      domain = await textPrompt({
        message: config.tunnel.domain
          ? `Which static ngrok domain should this PC serve? Press Enter to keep ${config.tunnel.domain}`
          : "Which static ngrok domain should this PC serve?",
        placeholder: "xxx.ngrok-free.dev",
        defaultValue: config.tunnel.domain ?? "",
        validate: validateNgrokDomain,
      });
    }
  }
  const domainError = validateNgrokDomain(domain);
  if (domainError) throw new Error(domainError);
  const normalizedDomain = normalizeNgrokDomain(domain!);

  setHearthConfigValues([
    { path: ["tunnel", "provider"], value: "ngrok" },
    { path: ["tunnel", "domain"], value: normalizedDomain },
    { path: ["server", "publicBaseUrl"], value: `https://${normalizedDomain}` },
    { path: ["server", "trustProxy"], value: true },
  ]);

  const lines = [
    `Domain: ${normalizedDomain}`,
    `Public MCP URL: https://${normalizedDomain}/mcp`,
    "server.trustProxy was enabled so rate limits see real client IPs via x-forwarded-for.",
    "Note: ngrok free shows a browser interstitial page on HTML traffic; API calls are unaffected. The Owner approval page needs one click-through.",
  ];
  if (options.yes || !input.isTTY || !output.isTTY) {
    console.log(["Hearth ngrok is ready", ...lines].join("\n"));
  } else {
    prompts.note(lines.join("\n"), "Hearth ngrok is ready");
    prompts.outro("Run `hearth serve --ngrok` — server and tunnel start together. `hearth ngrok status` checks health.");
  }
}

/**
 * Validate managed-ngrok config and start the supervised agent.
 * Fail-fast: an ngrok setup that cannot serve the saved domain must stop
 * `serve`, never leave Hearth reachable locally but dark publicly.
 */
async function startManagedNgrok(config: {
  host: string;
  port: number;
  publicBaseUrl: string;
  stateDir: string;
  oauth: { trustProxy: boolean };
  tunnel: { provider: string; domain: string | null };
}): Promise<{ stop(): Promise<void>; domain: string }> {
  const binary = findNgrok();
  const problems = validateManagedNgrok({
    domain: config.tunnel.domain,
    publicBaseUrl: config.publicBaseUrl,
    trustProxy: config.oauth.trustProxy,
    binary,
  });
  if (problems.length > 0) {
    throw new Error(["Managed ngrok is misconfigured:", ...problems.map((problem) => `  - ${problem}`)].join("\n"));
  }
  if (binary && !checkNgrokAuth(binary).ok) {
    throw new Error("ngrok has no authtoken configured. Run `ngrok config add-authtoken <your-token>`, then restart serve.");
  }
  const paths = ngrokPaths(config.stateDir);
  console.log(`tunnel: starting managed ngrok for ${config.tunnel.domain} ...`);
  const supervised = startNgrokChild({
    binary: binary!,
    port: config.port,
    pidPath: paths.pidPath,
    onLog: (line) => console.error(`[ngrok] ${line}`),
  });
  supervised.process.once("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[ngrok] agent exited with code ${code}; public URL is dark while serve keeps running locally. Restart serve --ngrok or run \`hearth ngrok status\`.`);
    }
  });
  try {
    await waitForAgentDomain(config.tunnel.domain!);
  } catch (error) {
    await supervised.stop().catch(() => undefined);
    throw error instanceof Error ? error : new Error(String(error));
  }
  console.log(`tunnel: ngrok serving https://${config.tunnel.domain} (static domain confirmed live)`);
  return { stop: supervised.stop, domain: config.tunnel.domain! };
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

function printHelp(): void {
  console.log(
    [
      "Hearth",
      "",
      "Usage:",
      "  hearth                 Run first-time setup if needed, then start the server",
      "  hearth serve [--ngrok]   Start the server (add --ngrok to also start the managed tunnel)",
      "  hearth init [--force] [--yes --use chatgpt|coding-agents|both --roots <csv> --public-url <url> --providers <csv>]",
      "  hearth doctor [--fix]  Show config, runtime, and native dependency status",
      "  hearth ngrok setup [--domain <static-domain>] [--yes]",
      "  hearth ngrok status [--json]  Managed per-PC ngrok tunnel",
      "  hearth connect [chatgpt|claude|generic]  Print copy-paste MCP connection steps for this PC",
      "  hearth config get      Print persisted config",
      "  hearth config set publicBaseUrl <url|null>  (origin only, without /mcp)",
      "  hearth show-changes <review-ref> [--json]",
      "  hearth agents ls       List subagent sessions",
      "  hearth agents run <profile-or-provider> [--model <model>] [--effort <level>] <prompt>",
      "  hearth agents continue <id> [--model <model>] [--effort <level>] <prompt>",
      "  hearth agents show <id>",
      "  hearth agents daemon <status|stop|logs>",
      "  hearth id              Print this machine's stable Hearth identity",
      "  hearth -v, --version   Print the installed version",
      "",
      "Examples:",
      "  npm install -g @sunshinelife83/hearth",
      "  hearth init",
      "  hearth serve",
      "  hearth connect",
      "",
      "For temporary tunnels:",
      "  hearth config set publicBaseUrl https://xxx.ngrok-free.dev",
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
    return "Enter a valid URL, for example https://xxx.ngrok-free.dev.";
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
