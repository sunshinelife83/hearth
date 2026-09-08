import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { probeSandboxAdapter, resetSandboxProbeCache, wrapCommandWithSandbox } from "./sandbox.js";

describe("sandbox adapters", () => {
  it("probes to a valid adapter id for the current platform", () => {
    resetSandboxProbeCache();
    const adapter = probeSandboxAdapter();
    assert.ok(["bwrap", "seatbelt", "none"].includes(adapter));
  });

  it("wraps commands with bwrap: read-only root, writable workspace, tmpfs temp", () => {
    const wrapped = wrapCommandWithSandbox(
      { executable: "/bin/zsh", args: ["-lc", "npm test"] },
      "bwrap",
      { workspaceRoot: "/home/user/project", allowNetwork: false },
    );
    assert.equal(wrapped.executable, "bwrap");
    assert.ok(wrapped.args.includes("--ro-bind"));
    assert.deepEqual(wrapped.args.slice(0, 2), ["--ro-bind", "/"]);
    assert.ok(wrapped.args.includes("/home/user/project"));
    assert.ok(wrapped.args.includes("--tmpfs"));
    assert.ok(wrapped.args.includes("--unshare-net"), "network denied adds --unshare-net");
    assert.deepEqual(wrapped.args.slice(-4), ["--", "/bin/zsh", "-lc", "npm test"], "original shell runs verbatim after --");
  });

  it("keeps the network when allowed under bwrap", () => {
    const wrapped = wrapCommandWithSandbox(
      { executable: "/bin/sh", args: ["-c", "ls"] },
      "bwrap",
      { workspaceRoot: "/ws", allowNetwork: true },
    );
    assert.equal(wrapped.args.includes("--unshare-net"), false);
  });

  it("wraps commands with a seatbelt profile denying writes outside the workspace", () => {
    const wrapped = wrapCommandWithSandbox(
      { executable: "/bin/zsh", args: ["-c", "make"] },
      "seatbelt",
      { workspaceRoot: "/Users/user/project", allowNetwork: true },
    );
    assert.equal(wrapped.executable, "sandbox-exec");
    assert.equal(wrapped.args[0], "-p");
    const profile = wrapped.args[1] ?? "";
    assert.match(profile, /\(deny file-write\*\)/);
    assert.match(profile, /\/Users\/user\/project/);
    assert.deepEqual(wrapped.args.slice(-3), ["/bin/zsh", "-c", "make"]);
  });

  it("returns the command untouched for the none adapter", () => {
    const shell = { executable: "/bin/sh", args: ["-c", "ls"] };
    const wrapped = wrapCommandWithSandbox(shell, "none", { workspaceRoot: "/ws", allowNetwork: true });
    assert.deepEqual(wrapped, shell);
  });
});
