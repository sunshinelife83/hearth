import { readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Orphan process reaper (§5). The process manager is in-memory, so a crash,
 * force kill, daemon restart, or reboot can leave child processes running
 * with no owner. Each live process is journaled to stateDir; on boot, stale
 * entries are validated (never kill unrelated PIDs) and reaped.
 *
 * Safety rules:
 * - A PID is only signaled when its current command line still matches the
 *   journaled marker (workspace root or command preview). PID reuse without
 *   a match is never killed — the entry is dropped with an audit note.
 * - Group kill (negative PID) only when the journaled pgid is sane (>1) and
 *   the leader still matches; otherwise fall back to the single PID.
 * - Unknown platform without /proc or ps: report stale, do not kill.
 */

export interface ProcessJournalEntry {
  pid: number;
  pgid?: number;
  workspaceId: string;
  workspaceRoot: string;
  commandPreview: string;
  startedAt: string;
}

export interface ReapReport {
  reaped: number;
  skipped: number;
  errors: string[];
  details: string[];
}

const entryFile = (dir: string, pid: number) => join(dir, `proc-${pid}.json`);

export async function recordProcessJournal(dir: string, entry: ProcessJournalEntry): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(entryFile(dir, entry.pid), JSON.stringify(entry), { mode: 0o600 });
}

export async function removeProcessJournal(dir: string, pid: number): Promise<void> {
  await rm(entryFile(dir, pid), { force: true });
}

export async function listProcessJournal(dir: string): Promise<ProcessJournalEntry[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const entries: ProcessJournalEntry[] = [];
  for (const file of files) {
    if (!file.startsWith("proc-") || !file.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, file), "utf8");
      const parsed = JSON.parse(raw) as ProcessJournalEntry;
      if (typeof parsed.pid === "number" && parsed.pid > 1) entries.push(parsed);
    } catch {
      // Corrupt entry: drop it on reap.
      entries.push({ pid: -1, workspaceId: "", workspaceRoot: "", commandPreview: "", startedAt: "" });
    }
  }
  return entries;
}

function procCmdline(pid: number): string | undefined {
  try {
    if (process.platform === "linux" && existsSync(`/proc/${pid}/cmdline`)) {
      const raw = execFileSync("cat", [`/proc/${pid}/cmdline`], { timeout: 3_000 });
      return raw.toString("utf8").replaceAll("\0", " ");
    }
  } catch {
    return undefined;
  }
  try {
    const out = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { timeout: 5_000 });
    const text = out.toString("utf8").trim();
    return text ? text : undefined;
  } catch {
    return undefined;
  }
}

function matchesEntry(cmdline: string, entry: ProcessJournalEntry): boolean {
  if (entry.workspaceRoot && cmdline.includes(entry.workspaceRoot)) return true;
  if (entry.commandPreview && entry.commandPreview.length >= 8 && cmdline.includes(entry.commandPreview.slice(0, 64))) {
    return true;
  }
  return false;
}

/** Reap stale journal entries. Never throws; reports per-entry outcomes. */
export async function reapProcessJournal(
  dir: string,
  audit: (event: string, details: Record<string, unknown>) => void = () => undefined,
): Promise<ReapReport> {
  const report: ReapReport = { reaped: 0, skipped: 0, errors: [], details: [] };
  const entries = await listProcessJournal(dir);
  for (const entry of entries) {
    if (entry.pid <= 1) {
      report.skipped += 1;
      report.details.push(`dropped corrupt journal entry`);
      continue;
    }
    const cmdline = procCmdline(entry.pid);
    if (cmdline === undefined) {
      // No such process (or no way to confirm): drop the stale entry.
      await removeProcessJournal(dir, entry.pid);
      audit("orphan_reap_stale", { pid: entry.pid, workspaceId: entry.workspaceId });
      report.skipped += 1;
      report.details.push(`pid ${entry.pid}: not running, entry dropped`);
      continue;
    }
    if (!matchesEntry(cmdline, entry)) {
      // PID reused by an unrelated process: never kill, just drop.
      await removeProcessJournal(dir, entry.pid);
      audit("orphan_reap_pid_reused", { pid: entry.pid, workspaceId: entry.workspaceId });
      report.skipped += 1;
      report.details.push(`pid ${entry.pid}: cmdline no longer matches, left alone`);
      continue;
    }
    try {
      if (entry.pgid && entry.pgid > 1 && entry.pgid !== process.pid) {
        try {
          process.kill(-entry.pgid, "SIGTERM");
        } catch {
          process.kill(entry.pid, "SIGTERM");
        }
      } else {
        process.kill(entry.pid, "SIGTERM");
      }
      await removeProcessJournal(dir, entry.pid);
      audit("orphan_reaped", { pid: entry.pid, workspaceId: entry.workspaceId });
      report.reaped += 1;
      report.details.push(`pid ${entry.pid}: terminated`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push(`pid ${entry.pid}: ${message}`);
      report.details.push(`pid ${entry.pid}: kill failed (${message})`);
    }
  }
  return report;
}
