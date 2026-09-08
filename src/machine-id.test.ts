import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadMachineIdentity } from "./machine-id.js";

describe("per-PC machine identity", () => {
  it("mints a stable id once and keeps it", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-machine-test-"));
    try {
      const first = loadMachineIdentity(dir);
      assert.match(first.id, /^hearth-[0-9a-f]{12}$/);
      const second = loadMachineIdentity(dir);
      assert.equal(second.id, first.id, "identity is stable across loads");
      assert.equal(second.createdAt, first.createdAt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers from a corrupt file with a fresh id", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-machine-test-"));
    try {
      writeFileSync(join(dir, "machine.json"), "not-json{{{");
      const identity = loadMachineIdentity(dir);
      assert.match(identity.id, /^hearth-[0-9a-f]{12}$/);
      const parsed = JSON.parse(readFileSync(join(dir, "machine.json"), "utf8")) as { id: string };
      assert.equal(parsed.id, identity.id, "recovery persists the new id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores the identity owner-only on POSIX", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "hearth-machine-test-"));
    try {
      loadMachineIdentity(dir);
      const mode = statSync(join(dir, "machine.json")).mode & 0o777;
      assert.equal(mode, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
