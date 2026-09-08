import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import {
  recordProcessJournal,
  removeProcessJournal,
  reapProcessJournal,
  listProcessJournal,
} from "./process-journal.js";

describe("orphan process journal + reaper", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "hearth-journal-test-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("drops entries for dead PIDs without killing anything", async () => {
    const deadPid = 42424242; // implausible live PID
    await recordProcessJournal(dir, {
      pid: deadPid,
      workspaceId: "ws_1",
      workspaceRoot: dir,
      commandPreview: "npm test",
      startedAt: new Date().toISOString(),
    });
    const events: string[] = [];
    const report = await reapProcessJournal(dir, (event) => { events.push(event); });
    assert.equal(report.reaped, 0);
    assert.equal(report.skipped, 1);
    assert.ok(events.includes("orphan_reap_stale"));
    assert.deepEqual(await listProcessJournal(dir), []);
  });

  it("never kills a PID whose cmdline no longer matches (reuse guard)", async () => {
    // Our own process is alive but its cmdline won't contain the fake marker.
    const selfPid = process.pid;
    const journalDir = join(dir, "reuse");
    await mkdir(journalDir, { recursive: true });
    await recordProcessJournal(journalDir, {
      pid: selfPid,
      workspaceId: "ws_1",
      workspaceRoot: "/nonexistent-workspace-marker-xyz",
      commandPreview: "definitely-not-in-cmdline-zzzzz",
      startedAt: new Date().toISOString(),
    });
    const events: string[] = [];
    const report = await reapProcessJournal(journalDir, (event) => { events.push(event); });
    assert.equal(report.reaped, 0, "must not kill self on non-matching cmdline");
    assert.ok(events.includes("orphan_reap_pid_reused") || report.skipped === 1);
    assert.equal(process.pid, selfPid, "test process survived");
  });

  it("round-trips record/list/remove", async () => {
    const journalDir = join(dir, "roundtrip");
    await mkdir(journalDir, { recursive: true });
    await recordProcessJournal(journalDir, {
      pid: 123456,
      workspaceId: "ws_9",
      workspaceRoot: journalDir,
      commandPreview: "echo hi",
      startedAt: new Date().toISOString(),
    });
    const listed = await listProcessJournal(journalDir);
    assert.equal(listed.length, 1);
    await removeProcessJournal(journalDir, 123456);
    assert.deepEqual(await listProcessJournal(journalDir), []);
  });

  it("ignores corrupt entries safely", async () => {
    const journalDir = join(dir, "corrupt");
    await mkdir(journalDir, { recursive: true });
    await writeFile(join(journalDir, "proc-999.json"), "not-json{{{");
    const report = await reapProcessJournal(journalDir);
    assert.equal(report.reaped, 0);
  });
});
