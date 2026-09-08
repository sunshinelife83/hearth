import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { describe, it, before, after } from "node:test";
import { writeTestHearthConfig } from "./test-support/config.test.js";

const STUB = `#!/bin/sh
if [ "$1" = "--version" ] || [ "$1" = "version" ]; then echo "ngrok version 3.x (stub)"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "check" ]; then
  if [ "$STUB_AUTH" = "fail" ]; then echo "no authtoken" >&2; exit 1; fi
  echo "Valid configuration"; exit 0
fi
echo "stub: unknown args $*" >&2; exit 1
`;

describe("hearth ngrok commands (stubbed ngrok)", () => {
  let root = "";
  let binDir = "";
  let homeDir = "";
  let env: NodeJS.ProcessEnv;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-ngrok-cli-test-"));
    binDir = join(root, "bin");
    homeDir = join(root, "home");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(join(root, "project"), { recursive: true });
    const stub = join(binDir, "ngrok");
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
    const output = runCli({}, "ngrok", "status");
    assert.match(output, /No managed ngrok tunnel/);
  });

  it("setup fails without ngrok on PATH", () => {
    const emptyBin = join(root, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    const output = runCliError(
      { PATH: emptyBin },
      "ngrok", "setup", "--domain", "abc.ngrok-free.dev", "--yes",
    );
    assert.match(output, /ngrok was not found/);
  });

  it("setup fails without an authtoken", () => {
    const output = runCliError(
      { STUB_AUTH: "fail" },
      "ngrok", "setup", "--domain", "abc.ngrok-free.dev", "--yes",
    );
    assert.match(output, /add-authtoken/);
  });

  it("setup saves the domain and syncs publicBaseUrl plus trustProxy", () => {
    const output = runCli({}, "ngrok", "setup", "--domain", "https://abc.ngrok-free.dev/", "--yes");
    assert.match(output, /Hearth ngrok is ready/);
    assert.match(output, /https:\/\/abc\.ngrok-free\.dev\/mcp/);

    const status = JSON.parse(runCli({}, "ngrok", "status", "--json")) as Record<string, unknown>;
    assert.equal(status.configured, true);
    assert.equal(status.domain, "abc.ngrok-free.dev");
    assert.equal(status.publicMcpUrl, "https://abc.ngrok-free.dev/mcp");
    assert.deepEqual((status.ngrok as Record<string, unknown>).authOk, true);

    const doctor = runCli({}, "doctor");
    assert.match(doctor, /Tunnel: ngrok abc\.ngrok-free\.dev/);
    assert.doesNotMatch(doctor, /does not match/);
  });

  it("setup rejects bad domains", () => {
    const output = runCliError({}, "ngrok", "setup", "--domain", "https://x.ngrok-free.dev/mcp", "--yes");
    assert.match(output, /without \/mcp/);
  });

  it("serve --ngrok fails fast without a saved domain", () => {
    const fresh = mkdtempSync(join(tmpdir(), "hearth-ngrok-serve-test-"));
    try {
      mkdirSync(join(fresh, "project"), { recursive: true });
      const freshEnv = writeTestHearthConfig(join(fresh, "config"), {
        workspaces: { allowedRoots: [join(fresh, "project")] },
        storage: { stateDir: join(fresh, "state") },
        logging: { level: "silent" },
      });
      let output = "";
      try {
        execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", "--ngrok"], {
          encoding: "utf8",
          env: { ...process.env, ...freshEnv, HOME: homeDir, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
          timeout: 60_000,
        });
        assert.fail("expected serve --ngrok to fail");
      } catch (error) {
        const stderr = (error as { stderr?: unknown }).stderr;
        output = typeof stderr === "string" ? stderr : String((error as Error).message);
      }
      assert.match(output, /needs a saved ngrok domain/);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
