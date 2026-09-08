import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { describe, it, before, after } from "node:test";
import { writeTestHearthConfig } from "./test-support/config.test.js";

const STUB_UUID = "12345678-1234-1234-1234-123456789abc";

const STUB = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "cloudflared version 2026.1.0 (stub)"; exit 0; fi
if [ "$1" = "tunnel" ] && [ "$2" = "list" ]; then
  if [ "$STUB_LOGIN" = "fail" ]; then echo "failed to read cert.pem" >&2; exit 1; fi
  if [ -n "$STUB_EXISTING_TUNNEL" ]; then
    if [ "$3" = "--output" ]; then echo "[{\\"id\\":\\"$STUB_EXISTING_ID\\",\\"name\\":\\"$STUB_EXISTING_TUNNEL\\"}]";
    else printf 'ID\\tNAME\\n%s\\t%s\\n' "$STUB_EXISTING_ID" "$STUB_EXISTING_TUNNEL"; fi
  else
    if [ "$3" = "--output" ]; then echo "[]"; else echo "no tunnels"; fi
  fi
  exit 0
fi
if [ "$1" = "tunnel" ] && [ "$2" = "create" ]; then
  CREDS="$STUB_CREDSDIR/${STUB_UUID}.json"
  mkdir -p "$STUB_CREDSDIR"
  echo '{"AccountTag":"stub","TunnelID":"${STUB_UUID}","TunnelSecret":"c3R1Yg=="}' > "$CREDS"
  echo "Tunnel credentials written to $CREDS"
  echo "Created tunnel $3 with id ${STUB_UUID}"
  exit 0
fi
if [ "$1" = "tunnel" ] && [ "$2" = "route" ]; then echo "routed"; exit 0; fi
if [ "$1" = "tunnel" ] && [ "$2" = "info" ]; then echo "connections: 4"; exit 0; fi
echo "stub: unknown args $*" >&2; exit 1
`;

describe("hearth tunnel commands (stubbed cloudflared)", () => {
  let root = "";
  let binDir = "";
  let credsDir = "";
  let homeDir = "";
  let env: NodeJS.ProcessEnv;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-tunnel-cli-test-"));
    binDir = join(root, "bin");
    credsDir = join(root, "cloudflared-home");
    homeDir = join(root, "home");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(credsDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(join(root, "project"), { recursive: true });
    const stub = join(binDir, "cloudflared");
    writeFileSync(stub, STUB);
    chmodSync(stub, 0o755);
    env = writeTestHearthConfig(join(root, "config"), {
      workspaces: { allowedRoots: [join(root, "project")] },
      storage: { stateDir: join(root, "state") },
      logging: { level: "silent" },
    });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const baseEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    ...env,
    HOME: homeDir,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    STUB_CREDSDIR: credsDir,
  });
  const runCli = (extraEnv: NodeJS.ProcessEnv, ...args: string[]): string =>
    execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      encoding: "utf8",
      env: { ...baseEnv(), ...extraEnv },
      timeout: 60_000,
    });
  const runCliError = (extraEnv: NodeJS.ProcessEnv, ...args: string[]): string => {
    try {
      runCli(extraEnv, ...args);
      assert.fail("expected CLI to fail");
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      return typeof stderr === "string" ? stderr : String((error as Error).message);
    }
    throw new Error("unreachable");
  };

  it("status reports no managed tunnel before setup", () => {
    const output = runCli({}, "tunnel", "status");
    assert.match(output, /No managed tunnel/);
  });

  it("setup fails without cloudflared on PATH", () => {
    const output = runCliError(
      { PATH: `/usr/bin${delimiter}/bin` },
      "tunnel", "setup", "--hostname", "hearth.example.com", "--yes",
    );
    assert.match(output, /cloudflared was not found/);
  });

  it("setup fails when cloudflared is not logged in", () => {
    const output = runCliError(
      { STUB_LOGIN: "fail" },
      "tunnel", "setup", "--hostname", "hearth.example.com", "--yes",
    );
    assert.match(output, /not logged in/);
  });

  it("setup provisions a tunnel, writes locked-down files, and updates config", () => {
    const output = runCli({}, "tunnel", "setup", "--hostname", "hearth.example.com", "--yes");
    assert.match(output, /Hearth tunnel is ready/);
    assert.match(output, /https:\/\/hearth\.example\.com\/mcp/);

    const status = JSON.parse(runCli({}, "tunnel", "status", "--json")) as Record<string, unknown>;
    assert.equal(status.configured, true);
    assert.equal(status.hostname, "hearth.example.com");
    assert.equal(status.tunnelId, STUB_UUID);
    assert.equal(status.publicMcpUrl, "https://hearth.example.com/mcp");
    assert.equal(status.ingressOk, true);

    const doctor = runCli({}, "doctor");
    assert.match(doctor, /Tunnel: cloudflared hearth\.example\.com/);
    assert.doesNotMatch(doctor, /tunnel\.hostname .* does not match/);
  });

  it("re-running setup reuses the existing tunnel", () => {
    const output = runCli(
      { STUB_EXISTING_TUNNEL: "placeholder", STUB_EXISTING_ID: STUB_UUID },
      "tunnel", "status", "--json",
    );
    const status = JSON.parse(output) as Record<string, unknown>;
    assert.equal(status.configured, true);

    const idOutput = runCli({}, "id");
    const machineId = (JSON.parse(idOutput) as { id: string }).id;
    const reuse = runCli(
      { STUB_EXISTING_TUNNEL: `hearth-${machineId.replace(/^hearth-/, "")}`, STUB_EXISTING_ID: STUB_UUID },
      "tunnel", "setup", "--hostname", "hearth.example.com", "--yes",
    );
    assert.match(reuse, /Reusing tunnel/);
  });

  it("setup refuses an existing remote tunnel without local credentials", () => {
    const output = runCliError(
      { STUB_EXISTING_TUNNEL: "taken-name", STUB_EXISTING_ID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      "tunnel", "setup", "--hostname", "hearth.example.com", "--name", "taken-name", "--yes",
    );
    assert.match(output, /without local credentials/);
  });

  it("setup rejects bad hostnames", () => {
    const output = runCliError({}, "tunnel", "setup", "--hostname", "https://x.example.com/mcp", "--yes");
    assert.match(output, /without \/mcp/);
  });
});
