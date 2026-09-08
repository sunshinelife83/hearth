import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildIngressConfig,
  finalizeIngressConfig,
  installTunnelCredentials,
  normalizeTunnelHostname,
  parseTunnelCreate,
  parseTunnelList,
  tunnelNameForMachine,
  tunnelPaths,
  validateIngressModel,
  validateManagedTunnel,
  validateRenderedConfig,
  validateTunnelHostname,
  writeTunnelConfig,
  TUNNEL_PUBLIC_PATHS,
} from "./tunnel-cloudflared.js";

const TUNNEL_ID = "12345678-1234-1234-1234-123456789abc";

describe("tunnel naming and paths", () => {
  it("derives a cloudflared-safe name from the machine id", () => {
    assert.equal(tunnelNameForMachine("hearth-9f3a2c1d4e5b"), "hearth-9f3a2c1d4e5b");
  });

  it("rejects malformed machine ids", () => {
    assert.throws(() => tunnelNameForMachine("bogus"), /tunnel name/);
    assert.throws(() => tunnelNameForMachine("hearth-XYZ"), /tunnel name/);
  });

  it("keeps credentials, config, and pid under the state dir", () => {
    const paths = tunnelPaths("/state", TUNNEL_ID);
    assert.equal(paths.credentialsPath, join("/state", "tunnels", "cloudflared", `${TUNNEL_ID}.json`));
    assert.equal(paths.configPath, join("/state", "tunnels", "cloudflared", "config.yml"));
    assert.equal(paths.pidPath, join("/state", "tunnels", "cloudflared", "cloudflared.pid"));
  });
});

describe("ingress config", () => {
  const model = { hostname: "hearth.example.com", origin: "http://127.0.0.1:7176" };

  it("renders one rule per AI endpoint plus an edge catch-all", () => {
    const rendered = buildIngressConfig(model);
    for (const path of TUNNEL_PUBLIC_PATHS) {
      assert.ok(rendered.includes(`path: "${path}"`), `missing rule for ${path}`);
    }
    assert.ok(rendered.includes("hostname: hearth.example.com"));
    const lines = rendered.split("\n");
    const ruleStarts = lines.map((line, index) => ({ line, index })).filter(({ line }) => /^\s*-\s/.test(line));
    assert.ok(ruleStarts.length > TUNNEL_PUBLIC_PATHS.length);
    assert.match(lines[ruleStarts.at(-1)!.index]!, /http_status:404/);
  });

  it("never exposes the dashboard, landing, or secrets", () => {
    const rendered = finalizeIngressConfig(buildIngressConfig(model), TUNNEL_ID, "/state/creds.json");
    assert.doesNotMatch(rendered, /dashboard/);
    assert.doesNotMatch(rendered, /auth\.json/);
    assert.doesNotMatch(rendered, /PLACEHOLDER/);
    assert.ok(rendered.includes(TUNNEL_ID));
  });

  it("validates a rendered file structurally", () => {
    const rendered = finalizeIngressConfig(buildIngressConfig(model), TUNNEL_ID, "/state/creds.json");
    assert.deepEqual(validateRenderedConfig(rendered, model.hostname), []);
  });

  it("rejects a catch-all that is not last", () => {
    const bad = [
      "tunnel: x",
      "credentials-file: y",
      "ingress:",
      "  - service: http_status:404",
      "  - hostname: hearth.example.com",
      '    path: "^/mcp$"',
      "    service: http://127.0.0.1:7176",
    ].join("\n");
    assert.match(validateRenderedConfig(bad, model.hostname).join("\n"), /last rule/);
  });

  it("rejects dashboard exposure and placeholders", () => {
    const rendered = finalizeIngressConfig(buildIngressConfig(model), TUNNEL_ID, "/x.json");
    assert.ok(validateRenderedConfig(`${rendered}\n  - hostname: hearth.example.com\n    path: "^/dashboard$"\n    service: x`, model.hostname).join("\n").match(/dashboard/));
    assert.ok(validateRenderedConfig("tunnel: PLACEHOLDER_TUNNEL_ID", model.hostname).length > 0);
  });

  it("validates the ingress model", () => {
    assert.deepEqual(validateIngressModel(model), []);
    assert.ok(validateIngressModel({ hostname: "x/mcp", origin: model.origin }).length > 0);
    assert.ok(validateIngressModel({ hostname: "  ", origin: model.origin }).length > 0);
    assert.ok(validateIngressModel({ hostname: model.hostname, origin: "ftp://x" }).length > 0);
    assert.ok(validateIngressModel({ hostname: model.hostname, origin: "not-a-url" }).length > 0);
  });
});

describe("cloudflared output parsing", () => {
  it("parses tunnel list JSON", () => {
    const parsed = parseTunnelList(JSON.stringify([{ id: TUNNEL_ID, name: "hearth-abc" }]));
    assert.deepEqual(parsed, [{ id: TUNNEL_ID, name: "hearth-abc" }]);
  });

  it("parses tunnel list text tables", () => {
    const parsed = parseTunnelList(`ID  NAME\n${TUNNEL_ID}  hearth-abc\n`);
    assert.equal(parsed[0]?.id, TUNNEL_ID);
    assert.equal(parsed[0]?.name, "hearth-abc");
  });

  it("parses tunnel create output", () => {
    const parsed = parseTunnelCreate(
      `Tunnel credentials written to /home/u/.cloudflared/${TUNNEL_ID}.json\nCreated tunnel hearth-abc with id ${TUNNEL_ID}`,
    );
    assert.equal(parsed?.tunnelId, TUNNEL_ID);
    assert.equal(parsed?.credentialsSource, `/home/u/.cloudflared/${TUNNEL_ID}.json`);
  });

  it("returns undefined when create output has no id", () => {
    assert.equal(parseTunnelCreate("all good, no id here"), undefined);
  });
});

describe("hostname validation", () => {
  it("accepts bare hostnames and full origins", () => {
    assert.equal(validateTunnelHostname("hearth.example.com"), undefined);
    assert.equal(normalizeTunnelHostname("https://Hearth.Example.com/"), "hearth.example.com");
  });

  it("rejects blanks, /mcp suffixes, and ports", () => {
    assert.match(validateTunnelHostname("") ?? "", /public hostname/);
    assert.match(validateTunnelHostname("https://x.example.com/mcp") ?? "", /without \/mcp/);
    assert.match(validateTunnelHostname("x.example.com:8443") ?? "", /no .*port/i);
  });
});

describe("credential and config files", () => {
  it("stores credentials and config owner-only", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "hearth-tunnel-test-"));
    try {
      const source = join(dir, "source.json");
      writeFileSync(source, JSON.stringify({ TunnelID: TUNNEL_ID }));
      const creds = installTunnelCredentials(join(dir, "state"), TUNNEL_ID, source);
      assert.equal((statSync(creds).mode & 0o777), 0o600);
      const configPath = writeTunnelConfig(
        join(dir, "state"),
        TUNNEL_ID,
        buildIngressConfig({ hostname: "hearth.example.com", origin: "http://127.0.0.1:7176" }),
      );
      assert.equal((statSync(configPath).mode & 0o777), 0o600);
      assert.ok(readFileSync(configPath, "utf8").includes(TUNNEL_ID));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses non-JSON credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-tunnel-test-"));
    try {
      const source = join(dir, "bad.json");
      writeFileSync(source, "not json");
      assert.throws(() => installTunnelCredentials(join(dir, "state"), TUNNEL_ID, source));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("managed tunnel validation", () => {
  const good = {
    hostname: "hearth.example.com",
    tunnelId: TUNNEL_ID,
    publicBaseUrl: "https://hearth.example.com",
    trustProxy: true,
    binary: "/usr/bin/cloudflared",
    credentialsExist: true,
    ingressContent: finalizeIngressConfig(
      buildIngressConfig({ hostname: "hearth.example.com", origin: "http://127.0.0.1:7176" }),
      TUNNEL_ID,
      "/state/creds.json",
    ),
  };

  it("accepts a complete managed tunnel", () => {
    assert.deepEqual(validateManagedTunnel(good), []);
  });

  it("blocks mismatched hosts, missing trust, and missing pieces", () => {
    assert.ok(validateManagedTunnel({ ...good, publicBaseUrl: "https://other.example.com" }).join("\n").match(/does not match/));
    assert.ok(validateManagedTunnel({ ...good, trustProxy: false }).join("\n").match(/trustProxy/));
    assert.ok(validateManagedTunnel({ ...good, binary: null }).join("\n").match(/not found on PATH/));
    assert.ok(validateManagedTunnel({ ...good, credentialsExist: false }).join("\n").match(/credentials/));
    assert.ok(validateManagedTunnel({ ...good, ingressContent: undefined }).join("\n").match(/ingress file/));
    assert.ok(validateManagedTunnel({ ...good, hostname: null }).join("\n").match(/Re-run/));
  });
});
