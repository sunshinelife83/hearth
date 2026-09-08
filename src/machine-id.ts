import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, platform, arch } from "node:os";
import { join } from "node:path";

/**
 * Stable per-PC diagnostic identifier.
 *
 * Each machine running Hearth owns a random stable id persisted in
 * stateDir (`machine.json`). It is a diagnostic label only, NOT a security
 * boundary: anyone who copies stateDir copies the identity, so it cannot
 * prove which physical machine answered, and it cannot prevent URL reuse or
 * cloning. Reachability comes from the managed ngrok tunnel
 * (`hearth serve --ngrok`) or local-only operation. The id lets the owner
 * recognize this PC in banners, dashboards, approvals, and audit logs.
 *
 * Future direction: replace this shared-secret-free label with a device
 * keypair (private key stays on the PC at 0600, public key identifies the
 * device), so approvals and audit entries can bind to an unclonable key.
 */

export interface MachineIdentity {
  /** Stable id, e.g. "hearth-9f3a2c1d4e5b". Created once, never rotated automatically. */
  id: string;
  hostname: string;
  platform: string;
  arch: string;
  createdAt: string;
}

export function loadMachineIdentity(stateDir: string): MachineIdentity {
  const path = join(stateDir, "machine.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MachineIdentity>;
    if (typeof parsed.id === "string" && /^hearth-[0-9a-f]{12}$/.test(parsed.id)) {
      return {
        id: parsed.id,
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
      };
    }
  } catch {
    // Missing or corrupt: mint a fresh identity below.
  }
  const identity: MachineIdentity = {
    id: `hearth-${randomBytes(6).toString("hex")}`,
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}

export function machineFileExists(stateDir: string): boolean {
  return existsSync(join(stateDir, "machine.json"));
}
