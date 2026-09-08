import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod/v4";
import { LOCAL_AGENT_PROVIDERS, type LocalAgentProvider } from "../local-agent-profiles.js";

/**
 * Fleet lanes (orchestration layer).
 *
 * A lane binds a kind of work ("feature", "tests", "review") to one
 * implementer backend plus optional dials. Lanes live in global config;
 * a project may overlay whole lanes via `<workspaceRoot>/.hearth/fleet.json`,
 * but the overlay applies ONLY after explicit approval (`fleet_approve`),
 * recorded as a content hash under stateDir. Cloned or edited project files
 * fail closed until re-approved. Explicit `target`/`model`/dial flags on
 * `agent_start` always win over lane dials; a `target` that contradicts the
 * lane's provider is a loud error, never a silent switch.
 */

export const LANE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const FLEET_FILE_VERSION = "hearth-fleet.v1";
export const PROJECT_FLEET_PATH = ".hearth/fleet.json";

export const fleetLaneSchema = z.object({
  provider: z.enum(LOCAL_AGENT_PROVIDERS as [LocalAgentProvider, ...LocalAgentProvider[]]),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  writeMode: z.enum(["read_only", "allowed", "full_access"]).optional(),
  timeoutMs: z.number().int().positive().max(7 * 24 * 3600 * 1000).optional(),
}).strict();

export const fleetConfigSchema = z.object({
  lanes: z.record(z.string(), fleetLaneSchema).default({}),
}).strict().superRefine((value, context) => {
  for (const name of Object.keys(value.lanes)) {
    if (!LANE_NAME_RE.test(name)) {
      context.addIssue({
        code: "custom",
        path: ["lanes", name],
        message: `Invalid lane name ${JSON.stringify(name)}: use [A-Za-z0-9._-] starting with alphanumerics.`,
      });
    }
  }
});

export type FleetLane = z.infer<typeof fleetLaneSchema>;
export type FleetConfig = z.infer<typeof fleetConfigSchema>;

const projectFleetFileSchema = z.object({
  version: z.literal(FLEET_FILE_VERSION),
  lanes: z.record(z.string(), fleetLaneSchema).default({}),
}).strict();

export function validateLaneName(name: string): string | undefined {
  if (!LANE_NAME_RE.test(name)) {
    return `Invalid lane name ${JSON.stringify(name)}: use [A-Za-z0-9._-] starting with alphanumerics.`;
  }
  return undefined;
}

export function validateFleetLanes(lanes: Record<string, FleetLane>): string | undefined {
  for (const name of Object.keys(lanes)) {
    const bad = validateLaneName(name);
    if (bad) return bad;
  }
  return undefined;
}

export interface ResolvedLane extends FleetLane {
  name: string;
  source: "global" | "project";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const approvalsPath = (stateDir: string) => join(stateDir, "fleet-approvals.json");

async function readApprovals(stateDir: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(approvalsPath(stateDir), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export interface ProjectFleet {
  present: boolean;
  trusted: boolean;
  config?: FleetConfig;
  /** Fail-closed reason when present but unusable. */
  error?: string;
}

/** Load the project overlay and check its approval. Never throws. */
export async function loadProjectFleet(
  workspaceRoot: string,
  stateDir: string,
): Promise<ProjectFleet> {
  let raw: string;
  try {
    raw = await readFile(join(workspaceRoot, PROJECT_FLEET_PATH), "utf8");
  } catch {
    return { present: false, trusted: false };
  }
  let parsed: z.infer<typeof projectFleetFileSchema>;
  try {
    parsed = projectFleetFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    return { present: true, trusted: false, error: `Project fleet file is invalid and is ignored: ${error instanceof Error ? error.message : String(error)}` };
  }
  const nameError = validateFleetLanes(parsed.lanes);
  if (nameError) return { present: true, trusted: false, error: nameError };
  const approvals = await readApprovals(stateDir);
  if (approvals[workspaceRoot] !== sha256Hex(raw)) {
    return { present: true, trusted: false, config: { lanes: parsed.lanes }, error: "Project fleet file is not approved. Review it, then run fleet_approve." };
  }
  return { present: true, trusted: true, config: { lanes: parsed.lanes } };
}

/** Record approval for the CURRENT content of the project fleet file. */
export async function approveProjectFleet(workspaceRoot: string, stateDir: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let raw: string;
  try {
    raw = await readFile(join(workspaceRoot, PROJECT_FLEET_PATH), "utf8");
  } catch {
    return { ok: false, error: "No project fleet file to approve." };
  }
  try {
    projectFleetFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    return { ok: false, error: `Cannot approve an invalid fleet file: ${error instanceof Error ? error.message : String(error)}` };
  }
  await mkdir(stateDir, { recursive: true });
  const approvals = await readApprovals(stateDir);
  approvals[workspaceRoot] = sha256Hex(raw);
  await writeFile(approvalsPath(stateDir), JSON.stringify(approvals, null, 2), { mode: 0o600 });
  return { ok: true };
}

/**
 * Resolve a lane: project overlay (when trusted) replaces the global lane
 * wholesale; otherwise the global lane applies. Fail-closed on unknown lanes
 * and untrusted project content.
 */
export function resolveLane(
  global: FleetConfig,
  project: ProjectFleet,
  name: string,
): { ok: true; lane: ResolvedLane } | { ok: false; error: string } {
  const nameError = validateLaneName(name);
  if (nameError) return { ok: false, error: nameError };
  if (project.present && !project.trusted && project.config?.lanes[name]) {
    return { ok: false, error: project.error ?? "Project fleet file is not approved." };
  }
  const projected = project.trusted ? project.config?.lanes[name] : undefined;
  const lane = projected ?? global.lanes[name];
  if (!lane) return { ok: false, error: `Unknown fleet lane: ${JSON.stringify(name)}.` };
  return { ok: true, lane: { ...lane, name, source: projected ? "project" : "global" } };
}

/** Effective lane map for status display (trust already applied). */
export function effectiveLanes(
  global: FleetConfig,
  project: ProjectFleet,
): Array<ResolvedLane & { trusted: boolean }> {
  const names = new Set([...Object.keys(global.lanes), ...(project.trusted && project.config ? Object.keys(project.config.lanes) : [])]);
  const out: Array<ResolvedLane & { trusted: boolean }> = [];
  for (const name of [...names].sort()) {
    const resolved = resolveLane(global, project, name);
    if (resolved.ok) out.push({ ...resolved.lane, trusted: true });
  }
  return out;
}
