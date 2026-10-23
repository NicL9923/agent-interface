import type { User } from "../shared/types.js";
import { httpError } from "./http-error.js";
import type { StoreDatabase } from "./store-database.js";

/** Household members, web and native sessions, and the native sign-in handshake. */
export class AccountRepository {
  constructor(private readonly database: StoreDatabase) {}
  private get db() { return this.database.db; }
  user(user: User) {
    this.db
      .prepare(
        "INSERT INTO users(id,email,name,picture) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name,picture=excluded.picture",
      )
      .run(user.id, user.email, user.name, user.picture ?? null);
    return user;
  }
  users(): User[] {
    return this.db
      .prepare("SELECT * FROM users ORDER BY name")
      .all() as unknown as User[];
  }
  getUser(id: string): User | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(id) as unknown as User | undefined;
  }
  session(hash: string, userId: string, csrf: string, expires: number) {
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
      .run(hash, userId, csrf, expires);
  }
  getSession(hash: string) {
    return this.db
      .prepare(
        "SELECT user_id AS userId,csrf,expires FROM sessions WHERE hash=? AND expires>?",
      )
      .get(hash, Date.now()) as unknown as
      { userId: string; csrf: string; expires: number } | undefined;
  }
  deleteSession(hash: string) {
    this.db.prepare("DELETE FROM sessions WHERE hash=?").run(hash);
  }
  confirmSession(hash: string, confirmedAt: number) {
    this.db.prepare("INSERT INTO session_confirmations VALUES(?,?) ON CONFLICT(session_hash) DO UPDATE SET confirmed_at=max(confirmed_at,excluded.confirmed_at)")
      .run(hash, confirmedAt);
  }
  sessionConfirmedAt(hash: string): number | undefined {
    return (this.db.prepare("SELECT confirmed_at FROM session_confirmations WHERE session_hash=?").get(hash) as { confirmed_at: number } | undefined)?.confirmed_at;
  }
  nativeSession(hash: string, userId: string, expires: number, signedInAt = Date.now()) {
    this.database.transaction(() => {
      this.db.prepare("INSERT INTO native_sessions VALUES(?,?,?)").run(hash, userId, expires);
      this.db.prepare("INSERT INTO native_session_starts VALUES(?,?)").run(hash, signedInAt);
    });
  }
  /**
   * Extends a live native session in place to `lifetime` from now, never past `limit` after its
   * Google sign-in. The token keeps its hash, so its push registrations stay attached.
   * Returns the expiry it now has, or undefined when the session is gone.
   */
  renewNativeSession(hash: string, lifetime: number, limit: number, now = Date.now()) {
    return this.database.transaction(() => {
      const session = this.db.prepare("SELECT s.expires,t.signed_in_at AS signedInAt FROM native_sessions s LEFT JOIN native_session_starts t ON t.hash=s.hash WHERE s.hash=?")
        .get(hash) as { expires: number; signedInAt: number | null } | undefined;
      if (!session || session.expires <= now) return undefined;
      const expires = Math.max(session.expires, Math.min(now + lifetime, (session.signedInAt ?? session.expires - lifetime) + limit));
      if (expires !== session.expires) this.db.prepare("UPDATE native_sessions SET expires=? WHERE hash=?").run(expires, hash);
      return expires;
    });
  }
  getNativeSession(hash: string) {
    const session = this.db.prepare("SELECT user_id AS userId,expires FROM native_sessions WHERE hash=?").get(hash) as
      { userId: string; expires: number } | undefined;
    if (session && session.expires <= Date.now()) { this.deleteNativeSession(hash); return undefined; }
    return session;
  }
  deleteNativeSession(hash: string) {
    this.db.prepare("DELETE FROM native_sessions WHERE hash=?").run(hash);
  }
  pruneNativeAuth() {
    for (const table of ["native_flows", "native_codes", "native_sessions"])
      this.db.prepare(`DELETE FROM ${table} WHERE expires<=?`).run(Date.now());
  }
  nativeFlow(hash: string, state: string, challenge: string, nonce: string, expires: number) {
    this.pruneNativeAuth();
    const count = this.db.prepare("SELECT count(*) AS count FROM native_flows").get() as { count: number };
    if (count.count >= 1000) throw httpError(429, "Too many sign-in attempts. Try again shortly.");
    this.db.prepare("INSERT INTO native_flows VALUES(?,?,?,?,?)").run(hash, state, challenge, nonce, expires);
  }
  getNativeFlow(hash: string) {
    return this.db.prepare("SELECT state,challenge,nonce FROM native_flows WHERE hash=? AND expires>?")
      .get(hash, Date.now()) as { state: string; challenge: string; nonce: string } | undefined;
  }
  finishNativeFlow(flowHash: string, codeHash: string, userId: string) {
    return this.database.transaction(() => {
      const flow = this.getNativeFlow(flowHash);
      if (!flow) return false;
      this.db.prepare("DELETE FROM native_flows WHERE hash=?").run(flowHash);
      this.db.prepare("INSERT INTO native_codes VALUES(?,?,?,?,?)")
        .run(codeHash, userId, flow.state, flow.challenge, Date.now() + 60000);
      return true;
    });
  }
  consumeNativeCode(codeHash: string, state: string, challenge: string) {
    return this.database.transaction(() => {
      const row = this.db.prepare("SELECT user_id AS userId FROM native_codes WHERE hash=? AND state=? AND challenge=? AND expires>?")
        .get(codeHash, state, challenge, Date.now()) as { userId: string } | undefined;
      if (row) this.db.prepare("DELETE FROM native_codes WHERE hash=?").run(codeHash);
      return row?.userId;
    });
  }
}
