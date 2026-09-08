import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

/**
 * Long-lived local tokens for MCP clients that cannot run the OAuth
 * authorization-code flow (stdio/LAN clients launched by the user). Tokens
 * are shown once at creation and stored hashed; they carry the same
 * authority as the OAuth "hearth" scope and are revoked by name.
 */

export interface DeviceTokenRecord {
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

const DEVICE_TOKEN_PREFIX = "dvst_";

export class DeviceTokenStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  /** Returns the plaintext token exactly once; only the hash is persisted. */
  create(name: string): { token: string; record: DeviceTokenRecord } {
    const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const now = new Date().toISOString();
    this.database.sqlite
      .prepare(
        `insert into device_tokens (token_hash, name, created_at) values (?, ?, ?)
         on conflict(token_hash) do nothing`,
      )
      .run(hashToken(token), name, now);
    return { token, record: { name, createdAt: now } };
  }

  /** Verifies a presented token, refreshing last_used_at. */
  verify(token: string): DeviceTokenRecord | undefined {
    if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return undefined;
    const hash = hashToken(token);
    const row = this.database.sqlite
      .prepare("select name, created_at, last_used_at from device_tokens where token_hash = ?")
      .get(hash) as { name: string; created_at: string; last_used_at: string | null } | undefined;
    if (!row) return undefined;
    this.database.sqlite
      .prepare("update device_tokens set last_used_at = ? where token_hash = ?")
      .run(new Date().toISOString(), hash);
    return {
      name: row.name,
      createdAt: row.created_at,
      ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    };
  }

  list(): DeviceTokenRecord[] {
    const rows = this.database.sqlite
      .prepare("select name, created_at, last_used_at from device_tokens order by created_at desc")
      .all() as Array<{ name: string; created_at: string; last_used_at: string | null }>;
    return rows.map((row) => ({
      name: row.name,
      createdAt: row.created_at,
      ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    }));
  }

  revoke(name: string): boolean {
    const result = this.database.sqlite
      .prepare("delete from device_tokens where name = ?")
      .run(name);
    return Number(result.changes) > 0;
  }

  close(): void {
    this.database.close();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
