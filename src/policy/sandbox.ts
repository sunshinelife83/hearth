import { execFileSync } from "node:child_process";
import type { ShellCommand } from "../process-platform.js";

/**
 * OS sandbox adapters for model-invoked commands (best-effort, ADR-006).
 *
 * - bwrap (Linux, bubblewrap): read-only root, workspace + /tmp writable,
 *   optional network unsharing.
 * - seatbelt (macOS, sandbox-exec): default-allow profile denying writes
 *   outside the workspace and temp directories.
 * - none: no wrapper (Windows has no usable equivalent here; containers are
 *   the recommended hardening path there — documented, not built yet).
 *
 * The sandbox is a hardening layer on top of the policy engine, never the
 * only boundary.
 */

export type SandboxAdapterId = "bwrap" | "seatbelt" | "none";

export interface SandboxOptions {
  workspaceRoot: string;
  allowNetwork: boolean;
}

let cachedAdapter: SandboxAdapterId | undefined;

export function resetSandboxProbeCache(): void {
  cachedAdapter = undefined;
}

/** Probe (once per process) which sandbox adapter is usable. */
export function probeSandboxAdapter(
  platform: NodeJS.Platform = process.platform,
): SandboxAdapterId {
  if (cachedAdapter) return cachedAdapter;
  cachedAdapter = probe(platform);
  return cachedAdapter;
}

function probe(platform: NodeJS.Platform): SandboxAdapterId {
  if (platform === "linux") {
    return commandWorks("bwrap", ["--version"]) ? "bwrap" : "none";
  }
  if (platform === "darwin") {
    return commandWorks("sandbox-exec", ["-h"]) ? "seatbelt" : "none";
  }
  return "none";
}

function commandWorks(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wrap a resolved shell command so it runs inside the sandbox. The original
 * shell invocation becomes the sandboxed child verbatim.
 */
export function wrapCommandWithSandbox(
  shell: ShellCommand,
  adapter: SandboxAdapterId,
  options: SandboxOptions,
): ShellCommand {
  if (adapter === "none") return shell;

  if (adapter === "bwrap") {
    const args = [
      "--ro-bind", "/", "/",
      "--dev-bind", "/dev", "/dev",
      "--proc", "/proc",
      "--bind", options.workspaceRoot, options.workspaceRoot,
      "--tmpfs", "/tmp",
      "--tmpfs", "/run",
      "--die-with-parent",
      "--new-session",
      ...(options.allowNetwork ? [] : ["--unshare-net"]),
      shell.executable,
      ...shell.args,
    ];
    return { executable: "bwrap", args };
  }

  // seatbelt: profile denies writes outside the workspace/temp, allows the rest.
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath "${options.workspaceRoot}") (subpath "/private/tmp") (subpath "/tmp") (literal "/dev/null") (subpath "/dev/stdout") (subpath "/dev/stderr"))`,
  ].join(" ");
  return {
    executable: "sandbox-exec",
    args: ["-p", profile, shell.executable, ...shell.args],
  };
}
