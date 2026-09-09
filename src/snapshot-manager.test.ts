import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createSnapshot, listSnapshots, rollbackSnapshot, SnapshotError } from "./snapshot-manager.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function readNormalized(path: string): Promise<string> {
  // Defensive: even with core.autocrlf=false pinned above, normalize so a
  // surprising runner-level CRLF conversion cannot flake the test.
  return (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
}

describe("snapshot manager", () => {
  let root = "";
  let workspaceRoot = "";

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "hearth-snapshot-test-"));
    workspaceRoot = join(root, "repo");
    await mkdir(workspaceRoot, { recursive: true });
    await git(workspaceRoot, ["init", "-q"]);
    await git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    await git(workspaceRoot, ["config", "user.name", "Test"]);
    // Windows checkouts default to core.autocrlf=true, which converts LF
    // blobs to CRLF working-tree files on `git apply`. The snapshot
    // round-trip preserves blob bytes, so pin the fixture repo to LF to keep
    // the assertions deterministic across platforms.
    await git(workspaceRoot, ["config", "core.autocrlf", "false"]);
    await git(workspaceRoot, ["config", "core.eol", "lf"]);
    await writeFile(join(workspaceRoot, "app.txt"), "version one\n");
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "index.ts"), "export const a = 1;\n");
    await git(workspaceRoot, ["add", "-A"]);
    await git(workspaceRoot, ["commit", "-q", "-m", "initial"]);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("captures and rolls back edits, creations, and deletions", async () => {
    const snapshot = await createSnapshot({
      root: workspaceRoot,
      workspaceId: "ws_test",
      label: "before refactor",
    });
    assert.match(snapshot.snapshotId, /^[0-9a-f]{40}$/);

    // Mutate: edit a tracked file, delete another, create a new one.
    await writeFile(join(workspaceRoot, "app.txt"), "version two\n");
    await rm(join(workspaceRoot, "src", "index.ts"));
    await writeFile(join(workspaceRoot, "generated.txt"), "transient\n");

    const rollback = await rollbackSnapshot({
      root: workspaceRoot,
      workspaceId: "ws_test",
      snapshotId: snapshot.snapshotId,
    });
    assert.equal(rollback.files, 3);

    assert.equal(await readNormalized(join(workspaceRoot, "app.txt")), "version one\n");
    assert.equal(await readNormalized(join(workspaceRoot, "src", "index.ts")), "export const a = 1;\n");
    await assert.rejects(() => readFile(join(workspaceRoot, "generated.txt"), "utf8"));
  });

  it("lists snapshots for the workspace with labels", async () => {
    await createSnapshot({ root: workspaceRoot, workspaceId: "ws_test", label: "second" });
    const records = await listSnapshots({ root: workspaceRoot, workspaceId: "ws_test" });
    assert.ok(records.length >= 2);
    assert.ok(records.some((record) => record.label === "before refactor"));
    assert.ok(records.every((record) => /^[0-9a-f]{40}$/.test(record.snapshotId)));
  });

  it("refuses to roll back to unknown snapshot ids", async () => {
    const known = await listSnapshots({ root: workspaceRoot, workspaceId: "ws_test" });
    const head = (await git(workspaceRoot, ["rev-parse", "HEAD"])).trim();
    assert.ok(!known.some((record) => record.snapshotId === head));

    await assert.rejects(
      () => rollbackSnapshot({ root: workspaceRoot, workspaceId: "ws_test", snapshotId: head }),
      SnapshotError,
    );
  });

  it("does not move HEAD when rolling back", async () => {
    const snapshot = await createSnapshot({ root: workspaceRoot, workspaceId: "ws_test", label: "third" });
    const headBefore = (await git(workspaceRoot, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(workspaceRoot, "app.txt"), "version three\n");
    await rollbackSnapshot({ root: workspaceRoot, workspaceId: "ws_test", snapshotId: snapshot.snapshotId });

    const headAfter = (await git(workspaceRoot, ["rev-parse", "HEAD"])).trim();
    assert.equal(headAfter, headBefore);
    assert.equal(await readNormalized(join(workspaceRoot, "app.txt")), "version one\n");
  });
});
