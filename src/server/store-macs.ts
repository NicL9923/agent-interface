import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { StoreDatabase } from "./store-database.js";

export interface MacDevice {
  id: string;
  userId: string;
  name: string;
  model?: string;
  osVersion?: string;
  appVersion?: string;
  createdAt: number;
  lastSeenAt?: number;
}
export interface MacEnrollment { name: string; model?: string; osVersion?: string; appVersion?: string }
type Row = { id: string; user_id: string; name: string; model: string | null; os_version: string | null; app_version: string | null;
  credential_hash: string; created_at: number; last_seen_at: number | null };

/** A person may link this many Macs at once. */
export const MAX_MACS = 5;
const digest = (credential: string) => createHash("sha256").update(credential).digest();
const device = (row: Row): MacDevice => ({
  id: row.id, userId: row.user_id, name: row.name, createdAt: row.created_at,
  ...(row.model ? { model: row.model } : {}), ...(row.os_version ? { osVersion: row.os_version } : {}),
  ...(row.app_version ? { appVersion: row.app_version } : {}), ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {}),
});

/** Linked Macs. Only a credential's hash is kept, and a revoked Mac never comes back. */
export class MacRepository {
  constructor(private readonly database: StoreDatabase) {}
  private get db() { return this.database.db; }
  /** Links a new Mac and returns its credential, which is never readable again. Undefined at the limit. */
  enroll(userId: string, info: MacEnrollment, now = Date.now()): { device: MacDevice; credential: string } | undefined {
    return this.database.transaction(() => {
      if (this.linked(userId).length >= MAX_MACS) return undefined;
      const id = "mac_" + randomBytes(16).toString("base64url"), credential = randomBytes(32).toString("base64url");
      this.db.prepare("INSERT INTO mac_devices(id,user_id,name,model,os_version,app_version,credential_hash,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, userId, info.name, info.model ?? null, info.osVersion ?? null, info.appVersion ?? null, digest(credential).toString("hex"), now);
      return { device: this.get(id)!, credential };
    });
  }
  private get(id: string) {
    const row = this.db.prepare("SELECT * FROM mac_devices WHERE id=? AND revoked_at IS NULL").get(id) as Row | undefined;
    return row && device(row);
  }
  /** The person's Macs that are still linked, oldest first. */
  linked(userId: string): MacDevice[] {
    return (this.db.prepare("SELECT * FROM mac_devices WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at,rowid").all(userId) as Row[]).map(device);
  }
  /** The linked Mac this credential belongs to, compared in constant time. */
  authenticate(id: string, credential: string): MacDevice | undefined {
    const row = this.db.prepare("SELECT * FROM mac_devices WHERE id=? AND revoked_at IS NULL").get(id) as Row | undefined;
    if (!row) return undefined;
    const expected = Buffer.from(row.credential_hash, "hex"), supplied = digest(credential);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied) ? device(row) : undefined;
  }
  /** Revokes one of this person's Macs. False when it is not theirs or already revoked. */
  revoke(id: string, userId: string, now = Date.now()) {
    return this.db.prepare("UPDATE mac_devices SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL").run(now, id, userId).changes === 1;
  }
  seen(id: string, at = Date.now()) {
    this.db.prepare("UPDATE mac_devices SET last_seen_at=? WHERE id=? AND revoked_at IS NULL").run(at, id);
  }
}
