import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  normalizeScopePaths,
  scopesOverlap,
  ownsScope,
  createOverlapGuard,
} from "./scope.js";

describe("delegation scopes", () => {
  it("normalizes against the root and rejects escapes", () => {
    const root = "/repo/proj";
    // `resolve` is platform-dependent: on Windows "/repo/proj" resolves to
    // "<drive>:\repo\proj", so compute expectations instead of hardcoding POSIX paths.
    assert.deepEqual(normalizeScopePaths(root, undefined), { ok: true, paths: [resolve(root)] });
    assert.deepEqual(normalizeScopePaths(root, ["src", "./src/../src"]), { ok: true, paths: [resolve(root, "src")] });
    const escape = normalizeScopePaths(root, ["../other"]);
    assert.equal(escape.ok, false);
    assert.match(escape.ok === false ? escape.error : "", /escapes the workspace/);
    const many = normalizeScopePaths(root, Array.from({ length: 21 }, (_, i) => `d${i}`));
    assert.equal(many.ok, false);
  });

  it("detects containment overlap both directions", () => {
    assert.equal(scopesOverlap(["/r/a"], ["/r/a/b"]), true);
    assert.equal(scopesOverlap(["/r/a/b"], ["/r/a"]), true);
    assert.equal(scopesOverlap(["/r/a"], ["/r/b"]), false);
    assert.equal(scopesOverlap(["/r"], ["/r/a", "/r/b"]), true);
  });

  it("only stopped/error release ownership", () => {
    for (const status of ["starting", "running", "idle", "paused"]) assert.equal(ownsScope(status), true);
    assert.equal(ownsScope("stopped"), false);
    assert.equal(ownsScope("error"), false);
  });

  it("blocks overlapping live scopes, frees stale and released ones", async () => {
    const guard = createOverlapGuard();
    guard.track({ agentId: "a1", workspaceId: "ws", scopePaths: ["/r/src"] });
    const live = async () => [{ id: "a1", status: "running" }];
    assert.equal(await guard.check("ws", ["/r/src/x.ts"], live), "a1");
    assert.equal(await guard.check("ws", ["/r/other"], live), undefined);
    assert.equal(await guard.check("ws2", ["/r/src/x.ts"], live), undefined, "different workspace is free");

    // Stale entry (agent gone from backend) is dropped, not blocking.
    assert.equal(await guard.check("ws", ["/r/src/x.ts"], async () => []), undefined);
    assert.equal(await guard.check("ws", ["/r/src/x.ts"], live), undefined, "stale entry was pruned");

    // Release on terminal observation.
    guard.track({ agentId: "a2", workspaceId: "ws", scopePaths: ["/r"] });
    guard.release("a2");
    assert.equal(await guard.check("ws", ["/r/anything"], async () => [{ id: "a2", status: "running" }]), undefined);

    // Backend unreachable never blocks.
    guard.track({ agentId: "a3", workspaceId: "ws", scopePaths: ["/r"] });
    assert.equal(await guard.check("ws", ["/r"], async () => { throw new Error("down"); }), undefined);
  });
});
