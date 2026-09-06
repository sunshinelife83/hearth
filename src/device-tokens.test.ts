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
    root = await mkdtemp(join(tmpdir(), "devspace-device-token-test-"));
    stateDir = join(root, "state");
    provider = new SingleUserOAuthProvider({
      ownerToken: "test-owner-token-that-is-long-enough",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 2592000,
      scopes: ["devspace"],
      allowedRedirectHosts: ["chatgpt.com"],
      trustProxy: false,
    }, new URL("https://tunnel.example.com/mcp"), stateDir);
    store = new DeviceTokenStore(stateDir);
  });

  after(async () => {
    provider.close();
    await rm(root, { recursive: true, force: true });
  });

  it("creates a token once, verifies it through the OAuth provider, and records usage", async () => {
    const { token } = store.create("laptop");
    assert.ok(token.startsWith("dvst_"));

    const auth = await provider.verifyAccessToken(token);
    assert.equal(auth.clientId, "device:laptop");
    assert.deepEqual(auth.scopes, ["devspace"]);
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
