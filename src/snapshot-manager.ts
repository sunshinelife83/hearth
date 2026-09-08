import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, getGitEligibility, safeWorkspaceRefSegment } from "./git.js";

/**
 * Workspace snapshots built on the git object model (same technique as the
 * review checkpoints): a temporary index captures the full worktree state
 * (tracked + untracked, not ignored) into a tree commit referenced under
 * refs/hearth/snapshots/<workspace>/<epochMs>. Rollback diffs the current
 * worktree tree against the snapshot tree and applies the reverse patch, so
 * the user's HEAD and branches are never touched.
 *
 * Known limitation (documented): git-ignored files are not captured.
 */

export interface SnapshotRecord {
  snapshotId: string;
  ref: string;
  label: string;
  createdAt: string;
}

export interface SnapshotCreateResult extends SnapshotRecord {
  dirtyBaseline: boolean;
}

const SNAPSHOT_REF_PREFIX = "refs/hearth/snapshots";
const SNAPSHOT_AUTHOR_ENV_BASE = "hearth-snapshot";

export class SnapshotError extends Error {}

export async function createSnapshot(input: {
  root: string;
  workspaceId: string;
  label: string;
}): Promise<SnapshotCreateResult> {
  const eligibility = await getGitEligibility(input.root);
  if (!eligibility.ok || !eligibility.gitRoot) {
    throw new SnapshotError(eligibility.message ?? "snapshots require a Git workspace.");
  }
  const gitRoot = eligibility.gitRoot;

  const head = await headCommit(gitRoot);
  const tempDir = await mkdtemp(join(tmpdir(), "hearth-snapshot-index-"));
  try {
    const env = snapshotEnv(join(tempDir, "index"));
    if (head) await git(gitRoot, ["read-tree", head], { env });
    await git(gitRoot, ["add", "-A", "--", input.root], { env });
    const tree = (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
    const parentArgs = head ? ["-p", head] : [];
    const commit = (
      await git(gitRoot, ["commit-tree", tree, ...parentArgs, "-m", `Hearth snapshot: ${input.label}`], { env })
    ).stdout.trim();

    const createdAt = new Date().toISOString();
    const ref = snapshotRef(input.workspaceId, createdAt);
    await git(gitRoot, ["update-ref", ref, commit]);

    return {
      snapshotId: commit,
      ref,
      label: input.label,
      createdAt,
      dirtyBaseline: head ? false : true,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function listSnapshots(input: {
  root: string;
  workspaceId: string;
}): Promise<SnapshotRecord[]> {
  const eligibility = await getGitEligibility(input.root);
  if (!eligibility.ok || !eligibility.gitRoot) return [];
  const gitRoot = eligibility.gitRoot;

  const prefix = `${SNAPSHOT_REF_PREFIX}/${safeWorkspaceRefSegment(input.workspaceId)}/`;
  const refs = (await git(gitRoot, [
    "for-each-ref",
    "--format=%(refname)\t%(objectname)\t%(creatordate:iso-strict)",
    SNAPSHOT_REF_PREFIX,
  ])).stdout.trim();
  if (!refs) return [];

  const records: SnapshotRecord[] = [];
  for (const line of refs.split("\n")) {
    const [ref, commit, createdAt] = line.split("\t");
    if (!ref?.startsWith(prefix) || !commit) continue;
    const message = (await git(gitRoot, ["log", "-1", "--format=%s", commit])).stdout.trim();
    records.push({
      snapshotId: commit,
      ref,
      label: message.replace(/^Hearth snapshot: /, ""),
      createdAt: createdAt || "",
    });
  }
  return records.sort((a, b) => b.ref.localeCompare(a.ref));
}

export async function rollbackSnapshot(input: {
  root: string;
  workspaceId: string;
  snapshotId: string;
}): Promise<{ files: number }> {
  const eligibility = await getGitEligibility(input.root);
  if (!eligibility.ok || !eligibility.gitRoot) {
    throw new SnapshotError(eligibility.message ?? "rollback requires a Git workspace.");
  }
  const gitRoot = eligibility.gitRoot;

  const known = await listSnapshots({ root: input.root, workspaceId: input.workspaceId });
  const target = known.find((record) => record.snapshotId === input.snapshotId);
  if (!target) {
    throw new SnapshotError(`Unknown snapshot for this workspace: ${input.snapshotId}`);
  }

  const targetTree = (
    await git(gitRoot, ["rev-parse", "--verify", `${target.snapshotId}^{tree}`])
  ).stdout.trim();

  const tempDir = await mkdtemp(join(tmpdir(), "hearth-rollback-"));
  try {
    const env = snapshotEnv(join(tempDir, "index"));
    const head = await headCommit(gitRoot);
    if (head) await git(gitRoot, ["read-tree", head], { env });
    await git(gitRoot, ["add", "-A", "--", input.root], { env });
    const currentTree = (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
    const patch = (await git(gitRoot, ["diff", "--binary", "--no-color", currentTree, targetTree], {
      maxBuffer: 100 * 1024 * 1024,
    })).stdout;

    if (!patch.trim()) return { files: 0 };

    const patchPath = join(tempDir, "rollback.patch");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(patchPath, patch, "utf8");
    await git(gitRoot, ["apply", "--binary", "--whitespace=nowarn", patchPath], {});

    return { files: patch.split("\n").filter((line) => line.startsWith("diff --git ")).length };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function headCommit(gitRoot: string): Promise<string | undefined> {
  try {
    return (await git(gitRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function snapshotEnv(indexPath: string): NodeJS.ProcessEnv {
  return {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "Hearth",
    GIT_AUTHOR_EMAIL: `${SNAPSHOT_AUTHOR_ENV_BASE}@users.noreply.local`,
    GIT_COMMITTER_NAME: "Hearth",
    GIT_COMMITTER_EMAIL: `${SNAPSHOT_AUTHOR_ENV_BASE}@users.noreply.local`,
  };
}

function snapshotRef(workspaceId: string, createdAt: string): string {
  const epoch = Date.parse(createdAt);
  return `${SNAPSHOT_REF_PREFIX}/${safeWorkspaceRefSegment(workspaceId)}/${Number.isFinite(epoch) ? epoch : Date.now()}`;
}
