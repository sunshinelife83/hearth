import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../config.js";
import { buildLocalMcpServer } from "../stdio-server.js";
import { writeTestHearthConfig } from "../test-support/config.test.js";

/**
 * Real-daemon IPC roundtrip (orchestration transport E2E, no model invoked).
 *
 * Boots the REAL agent daemon as a socket-speaking child process and drives
 * MCP agent_start through client → daemon → manager. A bogus target is used
 * deliberately: target resolution happens inside the manager, so
 * UNKNOWN_TARGET proving the full round trip (spawn, hello, dispatch, error
 * propagation back as a tool isError) without spending model quota.
 *
 * The daemon child inherits its owner token from process.env, so the token
 * is installed here and restored afterwards. The detached daemon exits on
 * its own idle shutdown; the socket dir is removed in cleanup.
 */
describe("orchestration daemon roundtrip (real IPC, no model)", () => {
  let root = "";
  let workspaceRoot = "";
  let client: Client;
  let closeServer: () => Promise<void>;
  let savedToken: string | undefined;
  let savedConfigDir: string | undefined;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "hearth-daemon-roundtrip-"));
    workspaceRoot = join(root, "project");
    await mkdir(workspaceRoot, { recursive: true });
    const env = writeTestHearthConfig(join(root, "config"), {
      server: { host: "127.0.0.1", port: 7176, publicBaseUrl: null },
      workspaces: { allowedRoots: [workspaceRoot] },
      storage: { stateDir: join(root, "state") },
      tools: { mode: "claude" },
      ui: { enabled: false },
      logging: { level: "silent" },
      subagents: { enabled: true, providers: [{ id: "codex", enabled: true }] },
    });
    savedToken = process.env.HEARTH_OAUTH_OWNER_TOKEN;
    savedConfigDir = process.env.HEARTH_CONFIG_DIR;
    process.env.HEARTH_OAUTH_OWNER_TOKEN = "test-owner-token-that-is-long-enough";
    const config = loadConfig(env);
    const local = buildLocalMcpServer(config);
    closeServer = local.close;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "daemon-roundtrip-client", version: "0.0.1" });
    await Promise.all([
      local.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  after(async () => {
    await client.close();
    await closeServer();
    if (savedToken === undefined) delete process.env.HEARTH_OAUTH_OWNER_TOKEN;
    else process.env.HEARTH_OAUTH_OWNER_TOKEN = savedToken;
    if (savedConfigDir === undefined) delete process.env.HEARTH_CONFIG_DIR;
    else process.env.HEARTH_CONFIG_DIR = savedConfigDir;
    await rm(root, { recursive: true, force: true });
  });

  it("reaches the manager and returns UNKNOWN_TARGET as a tool error", async () => {
    const opened = await client.callTool({ name: "open_workspace", arguments: { path: workspaceRoot } });
    const workspaceId = ((opened.structuredContent ?? {}) as { workspaceId?: string }).workspaceId!;
    const result = await client.callTool({
      name: "agent_start",
      arguments: { workspaceId, target: "nope-not-a-provider", prompt: "prove the round trip" },
    });
    assert.equal(result.isError, true);
    const text = ((result.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n");
    // Manager-resolved, not a transport failure: the daemon booted and answered.
    assert.match(text, /UNKNOWN_TARGET|Unknown subagent profile or provider/);
    assert.ok(!/DAEMON_STARTUP_FAILURE|DAEMON_UNAVAILABLE/.test(text), "daemon must boot and answer");
  });
});
