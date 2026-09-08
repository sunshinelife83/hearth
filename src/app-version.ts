import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Runtime package version. Used where Hearth announces itself to external
 * tools (e.g. codex app-server clientInfo) so the value never drifts from
 * package.json.
 */
export function hearthVersion(fallback = "0.0.0"): string {
  try {
    const version = (require("../package.json") as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : fallback;
  } catch {
    return fallback;
  }
}
