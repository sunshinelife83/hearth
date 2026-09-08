import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import { writeTestHearthConfig } from "./test-support/config.test.js";

describe("hearth id command", () => {
  let root = "";
  let env: NodeJS.ProcessEnv;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-id-test-"));
    mkdirSync(join(root, "project"), { recursive: true });
    env = writeTestHearthConfig(join(root, "config"), {
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

  it("id prints a stable machine identity", () => {
    const first = JSON.parse(runCli("id")) as { id: string };
    assert.match(first.id, /^hearth-[0-9a-f]{12}$/);
    const second = JSON.parse(runCli("id")) as { id: string };
    assert.equal(second.id, first.id);
  });
});
