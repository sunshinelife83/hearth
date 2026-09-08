import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_ENV_ALLOWLIST, filterChildEnvironment } from "./env-allowlist.js";

const parentEnv: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/home/user",
  SHELL: "/bin/zsh",
  // secrets and credentials that must not leak into tool shells
  HEARTH_OAUTH_OWNER_TOKEN: "super-secret-owner-token",
  ANTHROPIC_API_KEY: "sk-ant-secret",
  OPENAI_API_KEY: "sk-openai-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  GITHUB_TOKEN: "ghp-secret",
  // non-secret custom vars
  CUSTOM_BUILD_FLAG: "1",
};

describe("environment allowlist filter", () => {
  it("keeps default allowlisted variables and drops everything else", () => {
    const filtered = filterChildEnvironment(parentEnv, { allowAll: false });
    assert.equal(filtered.PATH, "/usr/bin");
    assert.equal(filtered.HOME, "/home/user");
    assert.equal(filtered.HEARTH_OAUTH_OWNER_TOKEN, undefined);
    assert.equal(filtered.ANTHROPIC_API_KEY, undefined);
    assert.equal(filtered.OPENAI_API_KEY, undefined);
    assert.equal(filtered.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(filtered.GITHUB_TOKEN, undefined);
    assert.equal(filtered.CUSTOM_BUILD_FLAG, undefined);
  });

  it("passes Hearth workspace markers when a workspace is bound", () => {
    const envWithMarkers = { ...parentEnv, HEARTH_WORKSPACE_ID: "ws_abc", HEARTH_WORKSPACE_ROOT: "/repo" };
    const filtered = filterChildEnvironment(envWithMarkers, { allowAll: false }, { workspaceId: "ws_abc" });
    assert.equal(filtered.HEARTH_WORKSPACE_ID, "ws_abc");
    assert.equal(filtered.HEARTH_WORKSPACE_ROOT, "/repo");
  });

  it("honors extra allowlist entries", () => {
    const filtered = filterChildEnvironment(
      parentEnv,
      { allowAll: false, extraAllowlist: ["CUSTOM_BUILD_FLAG"] },
    );
    assert.equal(filtered.CUSTOM_BUILD_FLAG, "1");
    assert.equal(filtered.GITHUB_TOKEN, undefined);
  });

  it("passes the full environment when allowAll is set (escape hatch)", () => {
    const filtered = filterChildEnvironment(parentEnv, { allowAll: true });
    assert.equal(filtered.GITHUB_TOKEN, "ghp-secret");
    assert.equal(filtered.HEARTH_OAUTH_OWNER_TOKEN, "super-secret-owner-token");
  });

  it("default allowlist excludes common credential variable names", () => {
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "STRIPE_SECRET_KEY"]) {
      assert.equal(DEFAULT_ENV_ALLOWLIST.includes(name), false, name);
    }
  });
});
