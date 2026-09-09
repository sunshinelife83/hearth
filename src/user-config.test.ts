import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadHearthFiles,
  setHearthConfigValue,
  setHearthConfigValues,
} from "./user-config.js";

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    host: "0.0.0.0",
    port: 8787,
    allowedRoots: ["/work"],
    publicBaseUrl: "https://hearth.example.com",
    artifactsEnabled: true,
    subagents: true,
  }));
  writeFileSync(join(configDir, "auth.json"), JSON.stringify({
    ownerToken: "test-owner-token",
  }));

  const files = loadHearthFiles(env);
  assert.equal(files.migratedLegacyConfig, true);
  assert.equal(files.config.server.host, "0.0.0.0");
  assert.equal(files.config.server.port, 8787);
  assert.deepEqual(files.config.workspaces.allowedRoots, ["/work"]);
  assert.equal(files.config.artifacts.enabled, true);
  assert.equal(files.config.subagents.enabled, true);
  assert.equal(files.config.tools.mode, "codex");
  assert.equal(files.config.ui.enabled, true);
  assert.equal(files.auth.ownerToken, "test-owner-token");
  assert.equal(existsSync(join(configDir, "config.json")), false);
  assert.equal(existsSync(join(configDir, "config.jsonc")), true);
  assert.equal(existsSync(join(configDir, "config.json.v1.0.bak")), true);

  const nextLoad = loadHearthFiles(env);
  assert.equal(nextLoad.migratedLegacyConfig, false);
});

await withConfigDirAsync(async (configDir) => {
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    port: 8787,
    allowedRoots: ["/work"],
  }));

  const results = await Promise.all([
    migrateInChildProcess(configDir),
    migrateInChildProcess(configDir),
  ]);
  assert.equal(results.filter((result) => result.migrated).length, 1);
  assert.equal(results.filter((result) => !result.migrated).length, 1);
  assert.equal(existsSync(join(configDir, "config.json")), false);
  assert.equal(existsSync(join(configDir, "config.jsonc")), true);
  assert.equal(existsSync(join(configDir, "config.json.v1.0.bak")), true);
  assert.equal(loadHearthFiles({ HEARTH_CONFIG_DIR: configDir }).config.server.port, 8787);
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.jsonc"), `{
    // This comment must survive config updates.
    "configVersion": 1,
    "server": {
      "port": 8787,
    },
  }\n`);

  const files = loadHearthFiles(env);
  assert.equal(files.config.server.port, 8787);
  assert.equal(files.config.tools.mode, "codex");

  setHearthConfigValue(["server", "publicBaseUrl"], "https://new.example.com", env);
  const updated = readFileSync(join(configDir, "config.jsonc"), "utf8");
  assert.match(updated, /This comment must survive config updates/);
  assert.equal(loadHearthFiles(env).config.server.publicBaseUrl, "https://new.example.com");

  setHearthConfigValues([
    { path: ["server", "port"], value: 7176 },
    { path: ["tools", "mode"], value: "claude" },
  ], env);
  const multiUpdated = readFileSync(join(configDir, "config.jsonc"), "utf8");
  assert.match(multiUpdated, /This comment must survive config updates/);
  assert.equal(loadHearthFiles(env).config.server.port, 7176);
  assert.equal(loadHearthFiles(env).config.tools.mode, "claude");
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.jsonc"), JSON.stringify({ configVersion: 1 }));
  writeFileSync(join(configDir, "config.json"), "{");
  assert.equal(loadHearthFiles(env).config.server.port, 7176);
  assert.equal(existsSync(join(configDir, "config.json")), true);
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.jsonc"), "{");
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ port: 8787 }));
  assert.throws(() => loadHearthFiles(env), /Unable to read .*config\.jsonc/);
  assert.equal(existsSync(join(configDir, "config.json")), true);
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ unknownSetting: true }));
  assert.throws(
    () => loadHearthFiles(env),
    /Unsupported legacy configuration keys: unknownSetting/,
  );
  assert.equal(existsSync(join(configDir, "config.json")), true);
  assert.equal(existsSync(join(configDir, "config.jsonc")), false);
  assert.equal(existsSync(join(configDir, "config.json.v1.0.bak")), false);
});

withConfigDir((configDir, env) => {
  const legacyPath = join(configDir, "config.json");
  const backupPath = join(configDir, "config.json.v1.0.bak");
  writeFileSync(legacyPath, JSON.stringify({ port: 8787 }));
  writeFileSync(backupPath, JSON.stringify({ port: 7176 }));

  assert.throws(
    () => loadHearthFiles(env),
    (error: unknown) => error instanceof Error
      && error.message.includes(`backup already exists at ${backupPath}`)
      && error.message.includes(`Move ${backupPath} out of the way, then run Hearth again.`),
  );
});

console.log("user config tests passed");

function withConfigDir(
  test: (configDir: string, env: NodeJS.ProcessEnv) => void,
): void {
  const configDir = mkdtempSync(join(tmpdir(), "hearth-user-config-test-"));
  const env = { HEARTH_CONFIG_DIR: configDir };
  try {
    test(configDir, env);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

async function withConfigDirAsync(
  test: (configDir: string) => Promise<void>,
): Promise<void> {
  const configDir = mkdtempSync(join(tmpdir(), "hearth-user-config-test-"));
  try {
    await test(configDir);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

async function migrateInChildProcess(
  configDir: string,
): Promise<{ migrated: boolean }> {
  const moduleUrl = new URL("./user-config.ts", import.meta.url).href;
  const source = [
    `import { loadHearthFiles } from ${JSON.stringify(moduleUrl)};`,
    "const files = loadHearthFiles();",
    "process.stdout.write(JSON.stringify({ migrated: files.migratedLegacyConfig }));",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        env: { ...process.env, HEARTH_CONFIG_DIR: configDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`migration child exited with ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as { migrated: boolean });
    });
  });
}

{
  // Pre-ngrok configs (tls section, cloudflared tunnel keys) fail with a
  // migration hint instead of a raw schema dump.
  withConfigDir((configDir, env) => {
    writeFileSync(join(configDir, "config.jsonc"), JSON.stringify({
      configVersion: 1,
      server: { host: "127.0.0.1", port: 7176, publicBaseUrl: "https://x.example.com" },
      tls: { certFile: null, keyFile: null, acmeDir: null },
      tunnel: { provider: "cloudflared", hostname: "x.example.com", tunnelId: "abc" },
    }));
    writeFileSync(join(configDir, "auth.json"), JSON.stringify({ ownerToken: "test-owner-token-long-enough" }));
    assert.throws(
      () => loadHearthFiles(env),
      (error: unknown) => error instanceof Error
        && error.message.includes("predates ngrok-only Hearth")
        && error.message.includes("hearth ngrok setup"),
    );
  });
}

console.log("legacy tunnel migration tests passed");
