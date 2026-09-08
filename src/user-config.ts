import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import * as z from "zod/v4";
import {
  defaultHearthConfig,
  hearthConfigSchema,
  type HearthConfig,
  type HearthConfigInput,
} from "./config-schema.js";
import { migrateLegacyConfig } from "./config-migration.js";
import { expandHomePath } from "./roots.js";

const hearthAuthConfigSchema = z.object({
  ownerToken: z.string().optional(),
}).passthrough();

export type HearthUserConfig = HearthConfig;
export type HearthAuthConfig = z.infer<typeof hearthAuthConfigSchema>;

export interface HearthFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: HearthConfig;
  auth: HearthAuthConfig;
  migratedLegacyConfig: boolean;
  /** One-time adopt of a pre-rename ~/.devspace install (config + auth copied, originals kept). */
  migratedFromDevspace: boolean;
}

export interface HearthConfigEdit {
  path: (string | number)[];
  value: unknown;
}

export function hearthConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHomePath(env.HEARTH_CONFIG_DIR ?? join(homedir(), ".hearth")));
}

export function hearthConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(hearthConfigDir(env), "config.jsonc");
}

export function hearthLegacyConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(hearthConfigDir(env), "config.json");
}

export function hearthLegacyConfigBackupPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(hearthConfigDir(env), "config.json.v1.0.bak");
}

export function hearthAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(hearthConfigDir(env), "auth.json");
}

export function hearthSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(hearthConfigDir(env), "skills");
}

export function hearthAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(hearthConfigDir(env), "agents");
}

export function loadHearthFiles(env: NodeJS.ProcessEnv = process.env): HearthFiles {
  const dir = hearthConfigDir(env);
  const configPath = hearthConfigPath(env);
  const legacyConfigPath = hearthLegacyConfigPath(env);
  const authPath = hearthAuthPath(env);
  const migratedFromDevspace = migrateFromLegacyDevspaceDir(env, dir);
  const migratedLegacyConfig = !existsSync(configPath) && existsSync(legacyConfigPath)
    ? migrateLegacyConfigFile(legacyConfigPath, configPath, hearthLegacyConfigBackupPath(env))
    : false;
  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);

  return {
    dir,
    configPath,
    authPath,
    configExists,
    authExists,
    config: configExists ? readJsoncConfig(configPath) : defaultHearthConfig(),
    auth: authExists ? readJsonFile(authPath, hearthAuthConfigSchema) : {},
    migratedLegacyConfig,
    migratedFromDevspace,
  };
}

/**
 * One-time adoption of a pre-rename DevSpace install: when the Hearth config
 * dir has neither config nor auth but ~/.devspace does, copy both files over
 * (owner-only permissions) and leave the originals untouched. Explicit
 * HEARTH_CONFIG_DIR opts out of the adoption.
 */
function migrateFromLegacyDevspaceDir(env: NodeJS.ProcessEnv, dir: string): boolean {
  if (env.HEARTH_CONFIG_DIR) return false;
  if (existsSync(join(dir, "config.jsonc")) || existsSync(join(dir, "auth.json"))) return false;
  // HEARTH_LEGACY_DEVSPACE_DIR is a test hook; production uses ~/.devspace.
  const legacyDir = env.HEARTH_LEGACY_DEVSPACE_DIR ?? join(homedir(), ".devspace");
  const legacyConfig = join(legacyDir, "config.jsonc");
  const legacyAuth = join(legacyDir, "auth.json");
  if (!existsSync(legacyConfig) && !existsSync(legacyAuth)) return false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const file of [legacyConfig, legacyAuth]) {
      if (!existsSync(file)) continue;
      const dest = join(dir, basename(file));
      writeFileSync(dest, readFileSync(file));
      try {
        chmodSync(dest, 0o600);
      } catch {
        // Non-POSIX platforms: best effort.
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function writeHearthConfig(
  config: HearthConfigInput,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = hearthConfigPath(env);
  const parsed = hearthConfigSchema.parse(config);
  atomicWrite(filePath, serializeConfig(parsed), 0o600);
  return filePath;
}

export function setHearthConfigValue(
  path: (string | number)[],
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return setHearthConfigValues([{ path, value }], env);
}

export function setHearthConfigValues(
  edits: HearthConfigEdit[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const files = loadHearthFiles(env);
  const source = files.configExists
    ? readFileSync(files.configPath, "utf8")
    : serializeConfig(files.config);
  const updated = edits.reduce(
    (document, edit) => applyEdits(document, modify(document, edit.path, edit.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    })),
    source,
  );
  parseJsoncConfig(updated, files.configPath);
  atomicWrite(files.configPath, updated.endsWith("\n") ? updated : `${updated}\n`, 0o600);
  return files.configPath;
}

export function writeHearthAuth(
  auth: HearthAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = hearthAuthPath(env);
  mkdirSync(hearthConfigDir(env), { recursive: true });
  writeJsonFile(filePath, hearthAuthConfigSchema.parse(auth), 0o600);
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

function migrateLegacyConfigFile(
  legacyPath: string,
  configPath: string,
  backupPath: string,
): boolean {
  if (existsSync(backupPath)) {
    throw new Error(
      `Unable to migrate ${legacyPath}: backup already exists at ${backupPath}. `
      + `Move ${backupPath} out of the way, then run Hearth again.`,
    );
  }

  let migrated: HearthConfig;
  try {
    migrated = migrateLegacyConfig(JSON.parse(readFileSync(legacyPath, "utf8")) as unknown);
  } catch (error) {
    throw fileError("migrate", legacyPath, error);
  }

  const temporaryPath = temporaryFilePath(configPath);
  let published = false;
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(temporaryPath, serializeConfig(migrated), { mode: 0o600, flag: "wx" });
    readJsoncConfig(temporaryPath);
    try {
      // A hard link publishes the complete temporary file atomically without
      // replacing config.jsonc if another first-start process won the race.
      linkSync(temporaryPath, configPath);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      readJsoncConfig(configPath);
      return false;
    }
    published = true;
    renameSync(legacyPath, backupPath);
  } catch (error) {
    if (published && existsSync(legacyPath)) {
      rmSync(configPath, { force: true });
    }
    throw fileError("migrate", legacyPath, error);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return true;
}

function readJsoncConfig(filePath: string): HearthConfig {
  try {
    return parseJsoncConfig(readFileSync(filePath, "utf8"), filePath);
  } catch (error) {
    if (error instanceof HearthConfigFileError) throw error;
    throw fileError("read", filePath, error);
  }
}

function parseJsoncConfig(source: string, filePath: string): HearthConfig {
  const errors: ParseError[] = [];
  const value = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new HearthConfigFileError(
      `Unable to read ${filePath}: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }
  try {
    return hearthConfigSchema.parse(value);
  } catch (error) {
    throw fileError("read", filePath, withLegacyTunnelHint(value, error));
  }
}

/**
 * One-time breaking migration aid: pre-ngrok configs carry a `tls` section
 * and cloudflared-era `tunnel` keys that strict validation rejects. Detect
 * them and tell the owner exactly how to migrate instead of dumping Zod.
 */
function withLegacyTunnelHint(value: unknown, error: unknown): unknown {
  if (!(error instanceof z.ZodError)) return error;
  if (typeof value !== "object" || value === null) return error;
  const record = value as Record<string, unknown>;
  const tunnel = record.tunnel as Record<string, unknown> | undefined;
  const stale: string[] = [];
  if ("tls" in record) stale.push("`tls`");
  if (
    tunnel !== null && typeof tunnel === "object" && tunnel !== undefined
    && (tunnel.provider === "cloudflared" || "hostname" in tunnel || "tunnelId" in tunnel)
  ) {
    stale.push("cloudflared-era `tunnel` keys");
  }
  if (stale.length === 0) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `${reason}\nYour config predates ngrok-only Hearth (stale ${stale.join(" and ")}). ` +
    "To migrate: delete the `tls` section from your config.jsonc, re-run " +
    "`hearth ngrok setup --domain <your-static-domain>` to recreate `tunnel`, " +
    "and restart serve (auth.json is untouched).",
  );
}

function serializeConfig(config: HearthConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function atomicWrite(filePath: string, source: string, mode: number): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = temporaryFilePath(filePath);
  try {
    writeFileSync(temporaryPath, source, { mode, flag: "wx" });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function temporaryFilePath(filePath: string): string {
  return join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
}

function readJsonFile<T>(filePath: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
  } catch (error) {
    throw fileError("read", filePath, error);
  }
}

function writeJsonFile(filePath: string, value: unknown, mode: number): void {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function fileError(action: "read" | "migrate", filePath: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new HearthConfigFileError(`Unable to ${action} ${filePath}: ${reason}`);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

class HearthConfigFileError extends Error {}
