import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { DeviceTokenStore } from "./device-tokens.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";

describe("device tokens", () => {
  let root = "";
  let stateDir = "";
  let provider: SingleUserOAuthProvider;
  let store: DeviceTokenStore;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "hearth-device-token-test-"));
    stateDir = join(root, "state");
    provider = new SingleUserOAuthProvider({
      ownerToken: "test-owner-token-that-is-long-enough",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 2592000,
      scopes: ["hearth"],
      allowedRedirectHosts: ["chatgpt.com"],
      trustProxy: false,
    }, new URL("https://tunnel.example.com/mcp"), stateDir);
    store = new DeviceTokenStore(stateDir);
  });

  after(async () => {
    provider.close();
    store.close();
    await rmFixtureDir(root);
  });

  it("creates a token once, verifies it through the OAuth provider, and records usage", async () => {
    const { token } = store.create("laptop");
    assert.ok(token.startsWith("dvst_"));

    const auth = await provider.verifyAccessToken(token);
    assert.equal(auth.clientId, "device:laptop");
    assert.deepEqual(auth.scopes, ["hearth"]);
    assert.equal(auth.resource?.href, "https://tunnel.example.com/mcp");

    const again = await provider.verifyAccessToken(token);
    assert.equal(again.clientId, "device:laptop");
  });

  it("rejects unknown and malformed tokens", async () => {
    await assert.rejects(() => provider.verifyAccessToken("dvst_not-a-real-token"), InvalidTokenError);
    await assert.rejects(() => provider.verifyAccessToken("random-garbage"), InvalidTokenError);
  });

  it("revokes by name so the token stops verifying", async () => {
    const { token } = store.create("old-machine");
    await provider.verifyAccessToken(token);
    assert.equal(store.revoke("old-machine"), true);
    await assert.rejects(() => provider.verifyAccessToken(token), InvalidTokenError);
    assert.equal(store.revoke("old-machine"), false);
    assert.ok(store.list().some((record) => record.name === "laptop"));
  });
});

async function rmFixtureDir(root: string): Promise<void> {
  // Windows keeps an OS lock on open SQLite files (EBUSY/EPERM/ENOTEMPTY on
  // rm). All fixture stores are closed before this runs, but the OS can hold
  // the lock briefly after close, so retry with backoff. POSIX deletes open
  // files fine, so this is a no-op fast path there.
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}
