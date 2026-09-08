import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeNgrokDomain,
  parseAgentTunnels,
  validateManagedNgrok,
  validateNgrokDomain,
} from "./tunnel-ngrok.js";

describe("ngrok domain validation", () => {
  it("accepts bare domains and full origins", () => {
    assert.equal(validateNgrokDomain("abc123.ngrok-free.dev"), undefined);
    assert.equal(normalizeNgrokDomain("https://ABC123.ngrok-free.dev/"), "abc123.ngrok-free.dev");
  });

  it("rejects blanks, /mcp suffixes, ports, and non-domains", () => {
    assert.match(validateNgrokDomain("") ?? "", /static ngrok domain/);
    assert.match(validateNgrokDomain("https://x.ngrok-free.dev/mcp") ?? "", /without \/mcp/);
    assert.match(validateNgrokDomain("x.ngrok-free.dev:8443") ?? "", /no .*port/i);
    assert.match(validateNgrokDomain("localhost") ?? "", /ngrok domain/);
  });
});

describe("agent API parsing", () => {
  it("extracts https tunnels and skips the rest", () => {
    const parsed = parseAgentTunnels({
      tunnels: [
        { public_url: "https://abc.ngrok-free.dev", proto: "https" },
        { public_url: "http://abc.ngrok-free.dev", proto: "http" },
        { public_url: 42, proto: "https" },
        "junk",
      ],
    });
    assert.deepEqual(parsed, [{ publicUrl: "https://abc.ngrok-free.dev", proto: "https" }]);
  });

  it("returns empty for malformed payloads", () => {
    assert.deepEqual(parseAgentTunnels(null), []);
    assert.deepEqual(parseAgentTunnels({}), []);
    assert.deepEqual(parseAgentTunnels({ tunnels: "nope" }), []);
  });
});

describe("managed ngrok validation", () => {
  const good = {
    domain: "abc.ngrok-free.dev",
    publicBaseUrl: "https://abc.ngrok-free.dev",
    trustProxy: true,
    binary: "/usr/bin/ngrok",
  };

  it("accepts a complete managed tunnel", () => {
    assert.deepEqual(validateManagedNgrok(good), []);
  });

  it("blocks missing domains, mismatched hosts, missing trust, and missing binaries", () => {
    assert.ok(validateManagedNgrok({ ...good, domain: null }).join("\n").match(/ngrok setup/));
    assert.ok(validateManagedNgrok({ ...good, publicBaseUrl: "https://other.ngrok-free.dev" }).join("\n").match(/does not match/));
    assert.ok(validateManagedNgrok({ ...good, trustProxy: false }).join("\n").match(/trustProxy/));
    assert.ok(validateManagedNgrok({ ...good, binary: null }).join("\n").match(/not found on PATH/));
    assert.ok(validateManagedNgrok({ ...good, publicBaseUrl: "not a url %%%" }).join("\n").match(/not a valid URL/));
  });
});
