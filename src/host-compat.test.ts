import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, it, before, after } from "node:test";
import { SqliteOAuthStore, SqliteOAuthClientsStore } from "./oauth-store.js";
import { defaultHearthConfig } from "./config-schema.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { writeTestHearthConfig } from "./test-support/config.test.js";

describe("multi-host compat: redirects, publicBaseUrl, connect", () => {
  it("accepts subdomains of allowed redirect hosts", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-redirect-test-"));
    try {
      const store = new SqliteOAuthStore(dir);
      try {
        const clients = new SqliteOAuthClientsStore(store, ["chatgpt.com", "claude.ai", "anthropic.com"]);
        const client = clients.registerClient({
          redirect_uris: [
            "https://chatgpt.com/connector_platform_oauth_redirect",
            "https://sub.chatgpt.com/callback",
            "https://claude.ai/api/mcp/auth_callback",
            "https://sub.anthropic.com/callback",
          ],
        });
        assert.ok(client.client_id.startsWith("hearth-"));
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects redirect hosts outside the allowlist", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-redirect-test-"));
    try {
      const store = new SqliteOAuthStore(dir);
      try {
        const clients = new SqliteOAuthClientsStore(store, ["chatgpt.com"]);
        assert.throws(
          () =>
            clients.registerClient({
              redirect_uris: ["https://evil.example.com/callback"],
            }),
          /redirect_uri is not allowed/,
        );
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults include ChatGPT and Claude redirect hosts", () => {
    const defaults = defaultHearthConfig();
    for (const host of ["chatgpt.com", "claude.ai", "anthropic.com"]) {
      assert.ok(defaults.oauth.allowedRedirectHosts.includes(host), `missing ${host}`);
    }
  });
});

describe("hearth connect / doctor --fix", () => {
  let root = "";
  let env: NodeJS.ProcessEnv;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-connect-test-"));
    mkdirSync(join(root, "project"), { recursive: true });
    env = writeTestHearthConfig(join(root, "config"), {
      server: { publicBaseUrl: "https://example-tunnel.example.com" },
      workspaces: { allowedRoots: [join(root, "project")] },
      storage: { stateDir: join(root, "state") },
      logging: { level: "silent" },
    });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const runCli = (...args: string[]): string =>
    execFileSync("node", ["--import", "tsx", "src/cli.ts", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 60_000,
    });

  it("connect prints per-host steps with this PC's MCP URL", () => {
    const output = runCli("connect");
    assert.match(output, /machine: hearth-[0-9a-f]{12}/);
    assert.match(output, /https:\/\/example-tunnel\.example\.com\/mcp/);
    assert.match(output, /ChatGPT:/);
    assert.match(output, /Claude/);
    assert.match(output, /Any MCP client/);
    assert.match(output, /Do not reuse this public URL/);
  });

  it("connect supports a single host filter", () => {
    const output = runCli("connect", "claude");
    assert.match(output, /Claude/);
    assert.doesNotMatch(output, /Any MCP client/);
  });

  it("doctor --fix strips a saved /mcp suffix", () => {
    const badEnv = writeTestHearthConfig(join(root, "bad-config"), {
      server: { publicBaseUrl: "https://example.com/mcp" as unknown as string },
      workspaces: { allowedRoots: [join(root, "project")] },
      storage: { stateDir: join(root, "bad-state") },
      logging: { level: "silent" },
    });
    const runBad = (...args: string[]): string =>
      execFileSync("node", ["--import", "tsx", "src/cli.ts", ...args], {
        encoding: "utf8",
        env: { ...process.env, ...badEnv },
        timeout: 60_000,
      });
    const beforeFix = runBad("doctor");
    assert.match(beforeFix, /Invalid publicBaseUrl|Config status/);
    const fixed = runBad("doctor", "--fix");
    assert.match(fixed, /Fixed publicBaseUrl.*https:\/\/example\.com/);
    const afterFix = runBad("doctor");
    assert.match(afterFix, /https:\/\/example\.com\/mcp/);
    rmSync(join(root, "bad-config"), { recursive: true, force: true });
    rmSync(join(root, "bad-state"), { recursive: true, force: true });
  });

  it("healthz binds the public MCP URL to this machine id", async () => {
    const srvRoot = mkdtempSync(join(tmpdir(), "hearth-healthz-test-"));
    try {
      mkdirSync(join(srvRoot, "project"), { recursive: true });
      const srvEnv = writeTestHearthConfig(join(srvRoot, "config"), {
        server: { host: "127.0.0.1", port: 7176, publicBaseUrl: "https://example-tunnel.example.com" },
        workspaces: { allowedRoots: [join(srvRoot, "project")] },
        storage: { stateDir: join(srvRoot, "state") },
        logging: { level: "silent" },
      });
      const running = createServer(loadConfig({ ...srvEnv, HEARTH_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough" }));
      const listener = await new Promise<ReturnType<typeof running.app.listen>>((resolve) => {
        const l = running.app.listen(0, "127.0.0.1", () => resolve(l));
      });
      try {
        const address = listener.address() as AddressInfo;
        const base = `http://127.0.0.1:${address.port}`;
        const health = await (await fetch(`${base}/healthz`)).json() as Record<string, unknown>;
        assert.equal(health.ok, true);
        assert.match(String(health.machineId), /^hearth-[0-9a-f]{12}$/);
        assert.equal(health.mcp, "https://example-tunnel.example.com/mcp");
        const landing = await (await fetch(`${base}/`)).text();
        assert.match(landing, /hearth connect/);
      } finally {
        await new Promise<void>((resolve) => listener.close(() => resolve()));
        await running.close();
      }
    } finally {
      rmSync(srvRoot, { recursive: true, force: true });
    }
  });
});
