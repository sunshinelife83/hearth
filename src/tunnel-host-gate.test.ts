import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { writeTestHearthConfig } from "./test-support/config.test.js";

const TOKEN = "test-owner-token-that-is-long-enough";

describe("tunnel Host gate", () => {
  let root = "";
  let base = "";
  let closeServer: () => Promise<void> = async () => undefined;
  let server: { address(): AddressInfo | string | null; close(cb?: () => void): void } | undefined;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "hearth-host-gate-test-"));
    await mkdir(join(root, "project"), { recursive: true });
    const env = writeTestHearthConfig(join(root, "config"), {
      server: { host: "127.0.0.1", port: 7176, publicBaseUrl: "https://abc.ngrok-free.dev", trustProxy: true },
      workspaces: { allowedRoots: [join(root, "project")] },
      storage: { stateDir: join(root, "state") },
      tunnel: { provider: "ngrok", domain: "abc.ngrok-free.dev" },
      logging: { level: "silent" },
    });
    const running = createServer(loadConfig({ ...env, HEARTH_OAUTH_OWNER_TOKEN: TOKEN }));
    closeServer = running.close;
    await new Promise<void>((resolve) => {
      const listener = running.app.listen(0, "127.0.0.1", () => {
        server = listener;
        const address = listener.address() as AddressInfo;
        base = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await closeServer();
    await rm(root, { recursive: true, force: true });
  });

  it("serves landing and dashboard locally", async () => {
    const landing = await fetch(`${base}/`);
    assert.equal(landing.status, 200);
    const dashboard = await fetch(`${base}/dashboard`);
    assert.equal(dashboard.status, 200);
  });

  it("refuses landing and dashboard through the tunnel domain", async () => {
    // fetch forbids overriding Host, so exercise the tunneled path through
    // X-Forwarded-Host exactly as ngrok + trustProxy deliver it.
    const viaTunnel = { "X-Forwarded-Host": "abc.ngrok-free.dev" };
    for (const path of ["/", "/dashboard", "/dashboard/api/status"]) {
      const res = await fetch(`${base}${path}`, { headers: viaTunnel });
      assert.equal(res.status, 404, path);
    }
  });

  it("still serves MCP and health through the tunnel domain", async () => {
    const viaTunnel = { "X-Forwarded-Host": "abc.ngrok-free.dev" };
    const health = await fetch(`${base}/healthz`, { headers: viaTunnel });
    assert.equal(health.status, 200);
    // /mcp without auth is rejected by the bearer gate, not the host gate.
    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...viaTunnel, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.notEqual(mcp.status, 404);
  });
});
