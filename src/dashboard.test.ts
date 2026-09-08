import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { writeTestHearthConfig } from "./test-support/config.test.js";

const TOKEN = "test-owner-token-that-is-long-enough";

describe("local dashboard", () => {
  let root = "";
  let base = "";
  let closeServer: () => Promise<void> = async () => undefined;
  let server: { address(): AddressInfo | string | null; close(cb?: () => void): void } | undefined;

  const json = (body: unknown) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "hearth-dashboard-test-"));
    await mkdir(join(root, "project"), { recursive: true });
    const env = writeTestHearthConfig(join(root, "config"), {
      server: { host: "127.0.0.1", port: 7176, publicBaseUrl: null },
      workspaces: { allowedRoots: [join(root, "project")] },
      storage: { stateDir: join(root, "state") },
      tools: { mode: "claude" },
      ui: { enabled: false },
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

  const login = async (token: string) => {
    const res = await fetch(`${base}/dashboard/api/login`, json({ ownerToken: token }));
    return { status: res.status, cookie: res.headers.get("set-cookie") ?? "", body: await res.json().catch(() => ({})) };
  };

  it("serves the login page without auth and gates APIs", async () => {
    const landing = await fetch(`${base}/`);
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /Hearth — local AI engineering runtime/);

    const page = await fetch(`${base}/dashboard`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Hearth Dashboard/);

    for (const asset of ["/dashboard/app.js", "/dashboard/styles.css"]) {
      const res = await fetch(`${base}${asset}`);
      assert.equal(res.status, 200, asset);
    }

    const denied = await fetch(`${base}/dashboard/api/status`);
    assert.equal(denied.status, 401);

    const bad = await login("wrong-password");
    assert.equal(bad.status, 401);
    assert.equal(bad.cookie, "", "no session cookie on failed login");
  });

  it("logs in with the owner password and serves status", async () => {
    const good = await login(TOKEN);
    assert.equal(good.status, 200);
    assert.match(good.cookie, /hearth_session=/);
    assert.ok(!good.cookie.includes(TOKEN), "session cookie must not contain the token");
    const cookie = good.cookie.split(";")[0]!;

    const status = await fetch(`${base}/dashboard/api/status`, { headers: { Cookie: cookie } });
    assert.equal(status.status, 200);
    const body = await status.json() as Record<string, unknown>;
    assert.equal(body.mode, "supervised");
    assert.ok(Array.isArray(body.providers));

    const me = await fetch(`${base}/dashboard/api/me`, { headers: { Cookie: cookie } });
    assert.deepEqual(await me.json(), { authenticated: true });
  });

  it("rejects forged session cookies", async () => {
    const forged = await fetch(`${base}/dashboard/api/status`, {
      headers: { Cookie: "hearth_session=aaa.bbbb" },
    });
    assert.equal(forged.status, 401);
  });

  it("serves workspaces, tasks, logs, setup, and safe config", async () => {
    const { cookie } = await login(TOKEN);
    const withAuth = { headers: { Cookie: cookie.split(";")[0]! } };

    for (const path of ["/dashboard/api/workspaces", "/dashboard/api/tasks", "/dashboard/api/logs", "/dashboard/api/setup", "/dashboard/api/config"]) {
      const res = await fetch(`${base}${path}`, withAuth);
      assert.equal(res.status, 200, path);
    }
    const config = await (await fetch(`${base}/dashboard/api/config`, withAuth)).json() as Record<string, unknown>;
    assert.ok(!JSON.stringify(config).includes(TOKEN), "safe config must not leak the owner token");
    assert.ok(config.execution !== undefined && config.fleet !== undefined);
  });

  it("validates config edits through the allowlist", async () => {
    const { cookie } = await login(TOKEN);
    const auth = { headers: { Cookie: cookie.split(";")[0]!, "Content-Type": "application/json" } };

    const forbidden = await fetch(`${base}/dashboard/api/config`, {
      ...auth, method: "PUT", body: JSON.stringify({ path: ["oauth", "ownerToken"], value: "x" }),
    });
    assert.equal(forbidden.status, 403);

    const badValue = await fetch(`${base}/dashboard/api/config`, {
      ...auth, method: "PUT", body: JSON.stringify({ path: ["execution", "mode"], value: "yolo" }),
    });
    assert.equal(badValue.status, 400);

    const ok = await fetch(`${base}/dashboard/api/config`, {
      ...auth, method: "PUT", body: JSON.stringify({ path: ["execution", "mode"], value: "supervised" }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json() as Record<string, unknown>).restartRequired, true);
  });

  it("requires JSON content type for mutations (fetch-only CSRF)", async () => {
    const { cookie } = await login(TOKEN);
    const res = await fetch(`${base}/dashboard/api/config`, {
      method: "PUT",
      headers: { Cookie: cookie.split(";")[0]!, "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(res.status, 415);
  });
});
