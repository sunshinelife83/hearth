import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { writeTestHearthConfig } from "./test-support/config.test.js";

/**
 * ACME HTTP-01 passthrough: only /.well-known/acme-challenge/* is served
 * from the configured directory so certbot webroot mode can provision
 * certificates for relay-free TLS while the server runs.
 */
describe("ACME challenge passthrough", () => {
  let root = "";
  let base = "";
  let closeServer: () => Promise<void> = async () => undefined;
  let listener: { close(cb?: () => void): void } | undefined;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "hearth-acme-test-"));
    const acmeDir = join(root, "acme");
    await mkdir(acmeDir, { recursive: true });
    await writeFile(join(acmeDir, "token123"), "challenge-response");
    const env = writeTestHearthConfig(join(root, "config"), {
      server: { host: "127.0.0.1", port: 7176, publicBaseUrl: null },
      workspaces: { allowedRoots: [root] },
      storage: { stateDir: join(root, "state") },
      tools: { mode: "claude" },
      ui: { enabled: false },
      logging: { level: "silent" },
      tls: { acmeDir },
    });
    const running = createServer(loadConfig(env));
    closeServer = running.close;
    await new Promise<void>((resolve) => {
      const started = running.app.listen(0, "127.0.0.1", () => {
        listener = started;
        base = `http://127.0.0.1:${(started.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => listener?.close(() => resolve()) ?? resolve());
    await closeServer();
    await rm(root, { recursive: true, force: true });
  });

  it("serves challenge files and nothing else", async () => {
    const ok = await fetch(`${base}/.well-known/acme-challenge/token123`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "challenge-response");

    const missing = await fetch(`${base}/.well-known/acme-challenge/nope`);
    assert.equal(missing.status, 404);

    const escape = await fetch(`${base}/.well-known/acme-challenge/../config.jsonc`);
    assert.ok([400, 403, 404].includes(escape.status), "path escape must not serve files");
  });
});
