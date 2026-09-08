import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../config.js";
import { buildLocalMcpServer } from "../stdio-server.js";
import { writeTestHearthConfig } from "../test-support/config.test.js";
import {
  fleetConfigSchema,
  resolveLane,
  effectiveLanes,
  loadProjectFleet,
  approveProjectFleet,
  PROJECT_FLEET_PATH,
  type FleetConfig,
} from "./lanes.js";

const global: FleetConfig = {
  lanes: {
    feature: { provider: "opencode", model: "org/model" },
    tests: { provider: "codex", effort: "medium" },
  },
};

const absent = { present: false, trusted: false } as const;

describe("fleet lanes", () => {
  it("rejects bad lane names and unknown providers at parse time", () => {
    assert.throws(() => fleetConfigSchema.parse({ lanes: { "bad name!": { provider: "codex" } } }), /Invalid lane name/);
    assert.throws(() => fleetConfigSchema.parse({ lanes: { ok: { provider: "hal9000" } } }));
    assert.throws(() => fleetConfigSchema.parse({ lanes: { ok: { provider: "codex", timeoutMs: -5 } } }));
    const parsed = fleetConfigSchema.parse({ lanes: { ok: { provider: "pi", writeMode: "read_only" } } });
    assert.equal(parsed.lanes.ok?.provider, "pi");
  });

  it("resolves global lanes and rejects unknown names", () => {
    const resolved = resolveLane(global, absent, "feature");
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.lane.provider, "opencode");
      assert.equal(resolved.lane.source, "global");
    }
    const missing = resolveLane(global, absent, "nope");
    assert.equal(missing.ok, false);
    assert.match(missing.ok === false ? missing.error : "", /Unknown fleet lane/);
  });

  it("project overlay replaces the lane whole, but only when approved", async () => {
    const root = await mkdtemp(join(tmpdir(), "hearth-lane-test-"));
    const stateDir = join(root, "state");
    try {
      await mkdir(join(root, ".hearth"), { recursive: true });
      await writeFile(join(root, PROJECT_FLEET_PATH), JSON.stringify({
        version: "hearth-fleet.v1",
        lanes: { feature: { provider: "pi", model: "x/y" } },
      }));

      const untrusted = await loadProjectFleet(root, stateDir);
      assert.equal(untrusted.present, true);
      assert.equal(untrusted.trusted, false);
      const blocked = resolveLane(global, untrusted, "feature");
      assert.equal(blocked.ok, false);
      assert.match(blocked.ok === false ? blocked.error : "", /not approved/);
      // Untouched global lanes still resolve while the overlay is untrusted.
      assert.equal(resolveLane(global, untrusted, "tests").ok, true);

      assert.deepEqual(await approveProjectFleet(root, stateDir), { ok: true });
      const trusted = await loadProjectFleet(root, stateDir);
      assert.equal(trusted.trusted, true);
      const resolved = resolveLane(global, trusted, "feature");
      assert.equal(resolved.ok, true);
      if (resolved.ok) {
        assert.equal(resolved.lane.provider, "pi");
        assert.equal(resolved.lane.source, "project");
      }

      // Editing the file after approval fails closed until re-approved.
      await writeFile(join(root, PROJECT_FLEET_PATH), JSON.stringify({
        version: "hearth-fleet.v1",
        lanes: { feature: { provider: "grok" } },
      }));
      const edited = await loadProjectFleet(root, stateDir);
      assert.equal(edited.trusted, false);
      assert.equal(resolveLane(global, edited, "feature").ok, false);

      const effective = effectiveLanes(global, trusted);
      assert.deepEqual(effective.map((lane) => `${lane.name}:${lane.provider}:${lane.source}`).sort(), [
        "feature:pi:project",
        "tests:codex:global",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("approve refuses missing or invalid project files", async () => {
    const root = await mkdtemp(join(tmpdir(), "hearth-lane-test-"));
    try {
      const missing = await approveProjectFleet(root, join(root, "state"));
      assert.equal(missing.ok, false);
      await mkdir(join(root, ".hearth"), { recursive: true });
      await writeFile(join(root, PROJECT_FLEET_PATH), "{oops");
      const invalid = await approveProjectFleet(root, join(root, "state"));
      assert.equal(invalid.ok, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("fleet lanes over MCP", () => {
  let root = "";
  let workspaceRoot = "";
  let client: Client;
  let closeServer: () => Promise<void>;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "hearth-lane-mcp-test-"));
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
      fleet: { lanes: { feature: { provider: "codex" }, review: { provider: "pi" } } },
    });
    const config = loadConfig(env);
    const local = buildLocalMcpServer(config);
    closeServer = local.close;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "lane-mcp-test-client", version: "0.0.1" });
    await Promise.all([
      local.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  after(async () => {
    await client.close();
    await closeServer();
    await rm(root, { recursive: true, force: true });
  });

  const textOf = (result: unknown) =>
    ((result as { content?: Array<{ text?: string }> }).content ?? []).map((b) => b.text ?? "").join("\n");

  async function workspaceId(): Promise<string> {
    const opened = await client.callTool({ name: "open_workspace", arguments: { path: workspaceRoot } });
    return ((opened.structuredContent ?? {}) as { workspaceId?: string }).workspaceId!;
  }

  it("fleet_status shows global lanes and no overlay", async () => {
    const id = await workspaceId();
    const status = await client.callTool({ name: "fleet_status", arguments: { workspaceId: id } });
    assert.match(textOf(status), /feature -> codex \[global\]/);
    assert.match(textOf(status), /Project overlay: none/);
  });

  it("unknown lanes and contradicting targets fail loud pre-dispatch", async () => {
    const id = await workspaceId();
    const unknown = await client.callTool({
      name: "agent_start", arguments: { workspaceId: id, prompt: "hi", lane: "nope" },
    });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /Unknown fleet lane/);

    const mismatch = await client.callTool({
      name: "agent_start", arguments: { workspaceId: id, prompt: "hi", lane: "feature", target: "opencode" },
    });
    assert.equal(mismatch.isError, true);
    assert.match(textOf(mismatch), /binds implementer/);
  });

  it("lanes needing a disabled provider are rejected before dispatch", async () => {
    const id = await workspaceId();
    const result = await client.callTool({
      name: "agent_start", arguments: { workspaceId: id, prompt: "hi", lane: "review" },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /not enabled/);
  });

  it("project overlay flows through approve before applying", async () => {
    const id = await workspaceId();
    await mkdir(join(workspaceRoot, ".hearth"), { recursive: true });
    await writeFile(join(workspaceRoot, PROJECT_FLEET_PATH), JSON.stringify({
      version: "hearth-fleet.v1",
      lanes: { feature: { provider: "pi" } },
    }));

    const before = await client.callTool({ name: "fleet_status", arguments: { workspaceId: id } });
    assert.match(textOf(before), /NOT approved/);

    // Untrusted overlay must not hijack the lane.
    const hijack = await client.callTool({
      name: "agent_start", arguments: { workspaceId: id, prompt: "hi", lane: "feature", target: "pi" },
    });
    assert.equal(hijack.isError, true);
    assert.match(textOf(hijack), /not approved|binds implementer/);

    const approved = await client.callTool({ name: "fleet_approve", arguments: { workspaceId: id } });
    assert.equal(approved.isError, undefined);

    const after = await client.callTool({ name: "fleet_status", arguments: { workspaceId: id } });
    assert.match(textOf(after), /feature -> pi \[project\]/);
    assert.match(textOf(after), /Project overlay: approved/);
  });
});
