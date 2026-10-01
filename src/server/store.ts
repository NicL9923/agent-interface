import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Avatar,
  Preferences,
  RuntimeEvent,
  Submission,
  SubmissionReceipt,
  User,
} from "../shared/types.js";
import { defaultPreferences } from "../shared/types.js";

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,picture TEXT);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_flows(hash TEXT PRIMARY KEY,state TEXT NOT NULL,challenge TEXT NOT NULL,nonce TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_codes(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),state TEXT NOT NULL,challenge TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_devices(device_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),session_hash TEXT NOT NULL REFERENCES native_sessions(hash) ON DELETE CASCADE,token TEXT NOT NULL,environment TEXT NOT NULL,UNIQUE(token,environment));
      CREATE TABLE IF NOT EXISTS preferences(user_id TEXT PRIMARY KEY REFERENCES users(id),value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts(user_id TEXT NOT NULL REFERENCES users(id),bot_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(user_id,bot_id));
      CREATE TABLE IF NOT EXISTS read_positions(user_id TEXT NOT NULL REFERENCES users(id),bot_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(user_id,bot_id));
      CREATE TABLE IF NOT EXISTS bot_presentation(bot_id TEXT PRIMARY KEY,owner_id TEXT,shared INTEGER NOT NULL DEFAULT 1,avatar TEXT);
      CREATE TABLE IF NOT EXISTS submissions(request_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,sender_id TEXT NOT NULL REFERENCES users(id),payload TEXT NOT NULL,receipt TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS participants(run_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(run_id,user_id));
      CREATE TABLE IF NOT EXISTS approval_attribution(approval_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),decision TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS routine_recipients(routine_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(routine_id,user_id));
      CREATE TABLE IF NOT EXISTS subscriptions(endpoint TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,UNIQUE(event_id,user_id));
      CREATE TABLE IF NOT EXISTS delivered(outbox_id TEXT NOT NULL REFERENCES outbox(id),endpoint TEXT NOT NULL,PRIMARY KEY(outbox_id,endpoint));
      CREATE TABLE IF NOT EXISTS notification_events(id TEXT PRIMARY KEY,value TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
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
  nativeSession(hash: string, userId: string, expires: number) {
    this.db.prepare("INSERT INTO native_sessions VALUES(?,?,?)").run(hash, userId, expires);
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
    if (count.count >= 1000) throw Object.assign(new Error("Too many sign-in attempts. Try again shortly."), { statusCode: 429 });
    this.db.prepare("INSERT INTO native_flows VALUES(?,?,?,?,?)").run(hash, state, challenge, nonce, expires);
  }
  getNativeFlow(hash: string) {
    return this.db.prepare("SELECT state,challenge,nonce FROM native_flows WHERE hash=? AND expires>?")
      .get(hash, Date.now()) as { state: string; challenge: string; nonce: string } | undefined;
  }
  finishNativeFlow(flowHash: string, codeHash: string, userId: string) {
    return this.transaction(() => {
      const flow = this.getNativeFlow(flowHash);
      if (!flow) return false;
      this.db.prepare("DELETE FROM native_flows WHERE hash=?").run(flowHash);
      this.db.prepare("INSERT INTO native_codes VALUES(?,?,?,?,?)")
        .run(codeHash, userId, flow.state, flow.challenge, Date.now() + 60000);
      return true;
    });
  }
  consumeNativeCode(codeHash: string, state: string, challenge: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT user_id AS userId FROM native_codes WHERE hash=? AND state=? AND challenge=? AND expires>?")
        .get(codeHash, state, challenge, Date.now()) as { userId: string } | undefined;
      if (row) this.db.prepare("DELETE FROM native_codes WHERE hash=?").run(codeHash);
      return row?.userId;
    });
  }
  registerNativeDevice(userId: string, sessionHash: string, deviceId: string, token: string, environment: "sandbox" | "production") {
    this.pruneNativeAuth();
    const conflicts = this.db.prepare("SELECT user_id FROM native_devices WHERE device_id=? OR (token=? AND environment=?)")
      .all(deviceId, token, environment) as { user_id: string }[];
    if (conflicts.some(row => row.user_id !== userId))
      throw Object.assign(new Error("This notification device belongs to another household member. Sign out there first."), { statusCode: 409 });
    // Token rotation can retain an older installation ID. Keep exactly one current registration.
    this.transaction(() => {
      this.db.prepare("DELETE FROM native_devices WHERE user_id=? AND token=? AND environment=? AND device_id<>?").run(userId, token, environment, deviceId);
      this.db.prepare("INSERT INTO native_devices VALUES(?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET session_hash=excluded.session_hash,token=excluded.token,environment=excluded.environment")
        .run(deviceId, userId, sessionHash, token, environment);
    });
  }
  removeNativeDevice(userId: string, deviceId: string) {
    this.db.prepare("DELETE FROM native_devices WHERE user_id=? AND device_id=?").run(userId, deviceId);
  }
  nativeDevices(userId: string, environment: "sandbox" | "production") {
    this.pruneNativeAuth();
    return this.db.prepare("SELECT device_id AS deviceId,token,environment FROM native_devices WHERE user_id=? AND environment=?")
      .all(userId, environment) as { deviceId: string; token: string; environment: "sandbox" | "production" }[];
  }
  preferences(id: string): Preferences {
    const row = this.db
      .prepare("SELECT value FROM preferences WHERE user_id=?")
      .get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : structuredClone(defaultPreferences);
  }
  savePreferences(id: string, value: Preferences) {
    this.db
      .prepare(
        "INSERT INTO preferences VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value",
      )
      .run(id, JSON.stringify(value));
  }
  personal(table: "drafts" | "read_positions", userId: string, botId: string) {
    const row = this.db
      .prepare(`SELECT value FROM ${table} WHERE user_id=? AND bot_id=?`)
      .get(userId, botId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  savePersonal(
    table: "drafts" | "read_positions",
    userId: string,
    botId: string,
    value: unknown,
  ) {
    this.db
      .prepare(
        `INSERT INTO ${table} VALUES(?,?,?) ON CONFLICT(user_id,bot_id) DO UPDATE SET value=excluded.value`,
      )
      .run(userId, botId, JSON.stringify(value));
  }
  clearSubmittedDraft(userId: string, botId: string, expected: unknown) {
    return this.db.prepare("UPDATE drafts SET value=? WHERE user_id=? AND bot_id=? AND value=?")
      .run(JSON.stringify({text: "", attachments: []}), userId, botId, JSON.stringify(expected)).changes > 0;
  }
  presentation(botId: string) {
    const row = this.db
      .prepare(
        "SELECT owner_id AS ownerId,shared,avatar FROM bot_presentation WHERE bot_id=?",
      )
      .get(botId) as
      | { ownerId: string | null; shared: number; avatar: string | null }
      | undefined;
    return row
      ? {
          ownerId: row.ownerId ?? undefined,
          shared: !!row.shared,
          avatar: row.avatar ? (JSON.parse(row.avatar) as Avatar) : undefined,
        }
      : {};
  }
  savePresentation(
    botId: string,
    input: { ownerId?: string; shared: boolean; avatar?: Avatar },
  ) {
    const previous = this.presentation(botId);
    this.db
      .prepare(
        "INSERT INTO bot_presentation VALUES(?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET owner_id=excluded.owner_id,shared=excluded.shared,avatar=excluded.avatar",
      )
      .run(
        botId,
        input.ownerId ?? previous.ownerId ?? null,
        +input.shared,
        input.avatar
          ? JSON.stringify(input.avatar)
          : previous.avatar
            ? JSON.stringify(previous.avatar)
            : null,
      );
  }
  intent(input: Submission): {
    created: boolean;
    receipt: SubmissionReceipt;
    input: Submission;
  } {
    return this.transaction(() => {
      const previous = this.submission(input.requestId);
      if (previous) {
        if (JSON.stringify(previous.input) !== JSON.stringify(input))
          throw Object.assign(
            new Error(
              "This submission ID was already used for different content",
            ),
            { statusCode: 409 },
          );
        return { created: false, ...previous };
      }
      const receipt: SubmissionReceipt = {
        requestId: input.requestId,
        status: "uncertain",
        message:
          "Waiting for confirmed Hermes admission. This message will never be automatically resent.",
      };
      this.db
        .prepare("INSERT INTO submissions VALUES(?,?,?,?,?,?)")
        .run(
          input.requestId,
          input.botId,
          input.senderId,
          JSON.stringify(input),
          JSON.stringify(receipt),
          Date.now(),
        );
      return { created: true, receipt, input };
    });
  }
  submission(id: string) {
    const row = this.db
      .prepare("SELECT payload,receipt FROM submissions WHERE request_id=?")
      .get(id) as { payload: string; receipt: string } | undefined;
    return row
      ? {
          input: JSON.parse(row.payload) as Submission,
          receipt: JSON.parse(row.receipt) as SubmissionReceipt,
        }
      : undefined;
  }
  submissionForMessage(botId: string, messageId: string) {
    const row = this.db
      .prepare(
        "SELECT request_id FROM submissions WHERE bot_id=? AND json_extract(receipt,'$.messageId')=?",
      )
      .get(botId, messageId) as { request_id: string } | undefined;
    return row ? this.submission(row.request_id) : undefined;
  }
  pending() {
    return (
      this.db.prepare("SELECT request_id FROM submissions").all() as {
        request_id: string;
      }[]
    )
      .map((r) => this.submission(r.request_id)!)
      .filter((x) => x.receipt.status === "uncertain");
  }
  receipt(receipt: SubmissionReceipt) {
    this.transaction(() => {
      const previous = this.submission(receipt.requestId);
      this.db
        .prepare("UPDATE submissions SET receipt=? WHERE request_id=?")
        .run(JSON.stringify(receipt), receipt.requestId);
      const row = this.submission(receipt.requestId);
      if (row && receipt.status === "accepted" && previous?.receipt.status !== "accepted")
        this.clearSubmittedDraft(row.input.senderId, row.input.botId, {
          text: row.input.text, attachments: row.input.attachments ?? [],
        });
      if (row && receipt.runId)
        this.participate(receipt.runId, row.input.senderId);
    });
  }
  participate(runId: string, userId: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO participants VALUES(?,?)")
      .run(runId, userId);
  }
  attributeApproval(
    id: string,
    botId: string,
    userId: string,
    decision: string,
  ) {
    this.db
      .prepare("INSERT INTO approval_attribution VALUES(?,?,?,?,?)")
      .run(id, botId, userId, decision, Date.now());
  }
  approval(id: string) {
    return this.db
      .prepare(
        "SELECT user_id AS userId,decision FROM approval_attribution WHERE approval_id=?",
      )
      .get(id);
  }
  routineRecipients(id: string, users: string[]) {
    this.transaction(() => {
      this.db
        .prepare("DELETE FROM routine_recipients WHERE routine_id=?")
        .run(id);
      for (const user of users)
        this.db
          .prepare("INSERT INTO routine_recipients VALUES(?,?)")
          .run(id, user);
    });
  }
  getRoutineRecipients(id: string): string[] {
    return (
      this.db
        .prepare("SELECT user_id FROM routine_recipients WHERE routine_id=?")
        .all(id) as { user_id: string }[]
    ).map((x) => x.user_id);
  }
  recipients(event: RuntimeEvent): string[] {
    const ids = new Set<string>();
    if (event.routineId)
      for (const r of this.db
        .prepare("SELECT user_id FROM routine_recipients WHERE routine_id=?")
        .all(event.routineId) as { user_id: string }[])
        ids.add(r.user_id);
    else if (event.runId)
      for (const r of this.db
        .prepare("SELECT user_id FROM participants WHERE run_id=?")
        .all(event.runId) as { user_id: string }[])
        ids.add(r.user_id);
    for (const user of this.users())
      if (this.preferences(user.id).followBots.includes(event.botId))
        ids.add(user.id);
    return [...ids];
  }
  enqueue(event: RuntimeEvent) {
    for (const userId of this.recipients(event))
      this.db
        .prepare(
          "INSERT OR IGNORE INTO outbox(id,event_id,user_id,payload) VALUES(?,?,?,?)",
        )
        .run(
          randomUUID(),
          event.id,
          userId,
          JSON.stringify({
            title: event.title,
            body: event.body ?? "",
            url: `/?bot=${encodeURIComponent(event.botId)}`,
            tag: event.id,
          }),
        );
  }
  cursor(): string {
    return (
      (
        this.db
          .prepare("SELECT value FROM metadata WHERE key='event_cursor'")
          .get() as { value: string } | undefined
      )?.value ?? ""
    );
  }
  recordEvents(events: RuntimeEvent[], cursor: string) {
    this.transaction(() => {
      for (const event of events)
        if (event.kind !== "activity") {
          this.db
            .prepare("INSERT OR IGNORE INTO notification_events VALUES(?,?,?)")
            .run(event.id, JSON.stringify(event), Date.now());
          this.enqueue(event);
        }
      this.db
        .prepare(
          "INSERT INTO metadata VALUES('event_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(cursor);
    });
  }
  enqueueKnownEvents() {
    this.transaction(() => {
      for (const row of this.db
        .prepare("SELECT value FROM notification_events")
        .all() as { value: string }[])
        this.enqueue(JSON.parse(row.value));
      this.db
        .prepare("DELETE FROM notification_events WHERE created_at<?")
        .run(Date.now() - 30 * 86400000);
    });
  }
  subscribe(
    userId: string,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  ) {
    const existing = this.db
      .prepare("SELECT user_id FROM subscriptions WHERE endpoint=?")
      .get(subscription.endpoint) as { user_id: string } | undefined;
    if (existing && existing.user_id !== userId)
      throw Object.assign(
        new Error(
          "This browser push subscription belongs to another household member. Remove it from that session before subscribing.",
        ),
        { statusCode: 409 },
      );
    this.db
      .prepare(
        "INSERT INTO subscriptions VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET value=excluded.value",
      )
      .run(subscription.endpoint, userId, JSON.stringify(subscription));
  }
  unsubscribe(userId: string, endpoint: string) {
    this.db
      .prepare("DELETE FROM subscriptions WHERE user_id=? AND endpoint=?")
      .run(userId, endpoint);
  }
  hasSubscription(userId: string, endpoint: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM subscriptions WHERE user_id=? AND endpoint=?").get(userId, endpoint);
  }
  outbox() {
    return this.db
      .prepare(
        "SELECT * FROM outbox WHERE state='pending' AND next_attempt<=? ORDER BY rowid",
      )
      .all(Date.now()) as unknown as {
      id: string;
      user_id: string;
      payload: string;
      attempts: number;
    }[];
  }
  subscriptions(userId: string) {
    return (
      this.db
        .prepare("SELECT value FROM subscriptions WHERE user_id=?")
        .all(userId) as { value: string }[]
    ).map((r) => JSON.parse(r.value));
  }
  delivered(id: string, endpoint: string) {
    return !!this.db
      .prepare("SELECT 1 FROM delivered WHERE outbox_id=? AND endpoint=?")
      .get(id, endpoint);
  }
  markDelivered(id: string, endpoint: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO delivered VALUES(?,?)")
      .run(id, endpoint);
  }
  finishDelivery(id: string) {
    this.db.prepare("UPDATE outbox SET state='delivered' WHERE id=?").run(id);
  }
  retryDelivery(id: string, attempts: number) {
    this.db
      .prepare("UPDATE outbox SET attempts=?,next_attempt=? WHERE id=?")
      .run(
        attempts,
        Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(attempts, 12)),
        id,
      );
  }
}
