import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../config.js";
import { buildLocalMcpServer } from "../stdio-server.js";
import { writeTestHearthConfig } from "../test-support/config.test.js";
import { buildRepoMap, formatRepoMap } from "./repo-map.js";

describe("context engine (repo map + search)", () => {
  let root = "";
  let client: Client;
  let closeServer: () => Promise<void>;
  let workspaceRoot = "";

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "hearth-context-test-"));
    workspaceRoot = join(root, "project");
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await mkdir(join(workspaceRoot, "node_modules"), { recursive: true });
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ name: "ctx", scripts: {} }));
    await writeFile(join(workspaceRoot, "src", "auth.ts"), "export function login(user: string) {\n  return user;\n}\n");
    await writeFile(join(workspaceRoot, "src", "api.ts"), "export const endpoint = '/api/login';\n");
    // node_modules must be invisible to the map and search.
    await writeFile(join(workspaceRoot, "node_modules", "noise.ts"), "export const login = 'noise';\n");

    const env = writeTestHearthConfig(join(root, "config"), {
      server: { host: "127.0.0.1", port: 7176, publicBaseUrl: null },
      workspaces: { allowedRoots: [workspaceRoot] },
      storage: { stateDir: join(root, "state") },
      tools: { mode: "claude" },
      ui: { enabled: false },
      logging: { level: "silent" },
    });
    const config = loadConfig(env);
    const local = buildLocalMcpServer(config);
    closeServer = local.close;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "context-test-client", version: "0.0.1" });
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

  it("builds a bounded repo map that skips dependency directories", async () => {
    const map = await buildRepoMap(workspaceRoot);
    assert.equal(map.totalFiles, 3, "node_modules is excluded");
    assert.deepEqual(map.manifests, ["package.json"]);
    assert.ok(map.languages.some((lang) => lang.extension === ".ts"));
    const text = formatRepoMap(map);
    assert.match(text, /package\.json/);
    assert.match(text, /src/);
  });

  it("exposes context_overview and search over MCP", async () => {
    const opened = await client.callTool({
      name: "open_workspace",
      arguments: { path: workspaceRoot },
    });
    const workspaceId = ((opened.structuredContent ?? {}) as { workspaceId?: string }).workspaceId!;

    const overview = await client.callTool({
      name: "context_overview",
      arguments: { workspaceId },
    });
    const overviewText = (overview.content as Array<{ type: string; text?: string }>)
      .map((block) => block.text ?? "").join("\n");
    assert.match(overviewText, /Repository map/);
    assert.match(overviewText, /package\.json/);

    const search = await client.callTool({
      name: "search",
      arguments: { workspaceId, pattern: "login", glob: "*.ts" },
    });
    const searchText = (search.content as Array<{ type: string; text?: string }>)
      .map((block) => block.text ?? "").join("\n");
    assert.match(searchText, /auth\.ts/, "search finds the source match");
    assert.doesNotMatch(searchText, /node_modules/, "search skips dependency directories");

    const empty = await client.callTool({
      name: "search",
      arguments: { workspaceId, pattern: "definitely-not-present-xyz" },
    });
    const emptyText = (empty.content as Array<{ type: string; text?: string }>)
      .map((block) => block.text ?? "").join("\n");
    assert.match(emptyText, /No matches/);
  });
});
