import { DatabaseSync } from "node:sqlite";
import { notificationCopy } from "../shared/event-copy.js";
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
import type { ReplyCardState } from "../shared/reply-cards.js";
import { defaultPreferences } from "../shared/types.js";

import type { SavedItem } from "../shared/discovery.js";

// Each entry upgrades the database by one PRAGMA user_version. Keep them additive so the
// previous release still runs if a deploy rolls back without restoring the database:
// new tables, indexes, or defaulted columns on tables that are only written with named
// columns. Older releases insert positionally into every other table.
const migrations: ((db: DatabaseSync) => void)[] = [
  // 1: the unversioned schema that existing installations already have.
  db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,picture TEXT);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_flows(hash TEXT PRIMARY KEY,state TEXT NOT NULL,challenge TEXT NOT NULL,nonce TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_codes(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),state TEXT NOT NULL,challenge TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_devices(device_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),session_hash TEXT NOT NULL REFERENCES native_sessions(hash) ON DELETE CASCADE,token TEXT NOT NULL,environment TEXT NOT NULL,UNIQUE(token,environment));
      CREATE TABLE IF NOT EXISTS routine_trials(request_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),routine_id TEXT NOT NULL,bot_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'uncertain');
      CREATE TABLE IF NOT EXISTS today_seen(user_id TEXT PRIMARY KEY REFERENCES users(id),seen_at TEXT NOT NULL,event_frontier INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS card_state(user_id TEXT NOT NULL REFERENCES users(id),bot_id TEXT NOT NULL,message_id TEXT NOT NULL,card_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(user_id,bot_id,message_id,card_id));
      CREATE TABLE IF NOT EXISTS saved_items(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),pointer_key TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(user_id,pointer_key));
      CREATE TABLE IF NOT EXISTS notification_batches(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_batch_items(outbox_id TEXT PRIMARY KEY REFERENCES outbox(id),batch_id TEXT NOT NULL REFERENCES notification_batches(id));
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
      CREATE TABLE IF NOT EXISTS notification_ingestion(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
    addColumn(db, "routine_trials", "status", "TEXT NOT NULL DEFAULT 'uncertain'");
    addColumn(db, "today_seen", "event_frontier", "INTEGER NOT NULL DEFAULT 0");
  },
  // 2: recent sign-in confirmation, delivery diagnostics and indexes for polling paths.
  db => {
    db.exec(`
      CREATE TABLE session_confirmations(session_hash TEXT PRIMARY KEY REFERENCES sessions(hash) ON DELETE CASCADE,confirmed_at INTEGER NOT NULL);
      ALTER TABLE outbox ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE outbox ADD COLUMN last_error TEXT;
      UPDATE outbox SET created_at=COALESCE(CAST(json_extract(payload,'$.queuedAt') AS INTEGER),CAST(strftime('%s','now') AS INTEGER)*1000);
      CREATE INDEX submissions_message ON submissions(bot_id,json_extract(receipt,'$.messageId'));
      CREATE INDEX submissions_status ON submissions(json_extract(receipt,'$.status'));
      CREATE INDEX outbox_ready ON outbox(state,next_attempt);
      CREATE INDEX notification_events_created ON notification_events(created_at);
      CREATE INDEX notification_batch_items_batch ON notification_batch_items(batch_id);
    `);
  },
];
export const schemaVersion = migrations.length;
// Exponential backoff spends about an hour on these; later news is stale.
export const maxDeliveryAttempts = 12;
function addColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some(existing => existing.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function migrate(db: DatabaseSync) {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current > migrations.length)
    throw new Error(`The app database uses schema version ${current}, but this release supports up to ${migrations.length}. Run a matching release or restore a backup.`);
  for (let version = current; version < migrations.length; version++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      migrations[version](db);
      db.exec(`PRAGMA user_version=${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    migrate(this.db);
    this.db.exec("INSERT INTO notification_ingestion(event_id) SELECT id FROM notification_events e WHERE NOT EXISTS(SELECT 1 FROM notification_ingestion i WHERE i.event_id=e.id) ORDER BY e.rowid");
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
  confirmSession(hash: string, confirmedAt: number) {
    this.db.prepare("INSERT INTO session_confirmations VALUES(?,?) ON CONFLICT(session_hash) DO UPDATE SET confirmed_at=max(confirmed_at,excluded.confirmed_at)")
      .run(hash, confirmedAt);
  }
  sessionConfirmedAt(hash: string): number | undefined {
    return (this.db.prepare("SELECT confirmed_at FROM session_confirmations WHERE session_hash=?").get(hash) as { confirmed_at: number } | undefined)?.confirmed_at;
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
  routineTrial(requestId: string): { userId: string; routineId: string; botId: string } | undefined {
    return this.db.prepare("SELECT user_id AS userId,routine_id AS routineId,bot_id AS botId FROM routine_trials WHERE request_id=?").get(requestId) as { userId: string; routineId: string; botId: string } | undefined;
  }
  routineTrials(routineId: string): { requestId: string; userId: string; botId: string }[] {
    return this.db.prepare("SELECT request_id AS requestId,user_id AS userId,bot_id AS botId FROM routine_trials WHERE routine_id=? AND status IN ('accepted','uncertain')").all(routineId) as { requestId: string; userId: string; botId: string }[];
  }
  rememberRoutineTrial(requestId: string, userId: string, routineId: string, botId: string) {
    this.db.prepare("INSERT OR IGNORE INTO routine_trials(request_id,user_id,routine_id,bot_id) VALUES(?,?,?,?)").run(requestId, userId, routineId, botId);
  }
  recordRoutineTrialStatus(requestId: string, status: string) {
    this.db.prepare("UPDATE routine_trials SET status=? WHERE request_id=?").run(status, requestId);
  }
  todaySeen(userId: string): string | undefined {
    return (this.db.prepare("SELECT seen_at FROM today_seen WHERE user_id=?").get(userId) as { seen_at: string } | undefined)?.seen_at;
  }
  todayFrontier(userId: string): number {
    return (this.db.prepare("SELECT event_frontier FROM today_seen WHERE user_id=?").get(userId) as { event_frontier: number } | undefined)?.event_frontier ?? 0;
  }
  latestEventFrontier(): number {
    return (this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='notification_ingestion'").get() as { seq: number } | undefined)?.seq ?? 0;
  }
  markTodaySeen(userId: string, seenAt: string, frontier: number) {
    this.db.prepare("INSERT INTO today_seen VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET seen_at=max(today_seen.seen_at,excluded.seen_at),event_frontier=max(today_seen.event_frontier,excluded.event_frontier)").run(userId, seenAt, frontier);
  }
  eventPage(frontier: number, upperFrontier: number, botIds: string[], initialSince?: string) {
    const rows = botIds.length ? this.db.prepare(`SELECT i.id,e.value FROM notification_ingestion i JOIN notification_events e ON e.id=i.event_id WHERE i.id>? AND i.id<=? AND json_extract(e.value,'$.botId') IN (${botIds.map(() => '?').join(',')}) AND (? IS NULL OR e.created_at>=?) ORDER BY i.id LIMIT 101`).all(frontier, upperFrontier, ...botIds, initialSince ? Date.parse(initialSince) : null, initialSince ? Date.parse(initialSince) : null) as { id: number; value: string }[] : [];
    const page = rows.slice(0, 100);
    return { events: page.map(row => JSON.parse(row.value) as RuntimeEvent), frontier: String(rows.length > 100 ? page.at(-1)!.id : Math.max(frontier, upperFrontier)), hasMore: rows.length > 100 };
  }
  cardState(userId: string, botId: string, messageId: string, cardId: string): ReplyCardState {
    const row = this.db.prepare("SELECT value FROM card_state WHERE user_id=? AND bot_id=? AND message_id=? AND card_id=?").get(userId, botId, messageId, cardId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : { checkedIds: [], notes: {} };
  }
  saveCardState(userId: string, botId: string, messageId: string, cardId: string, value: ReplyCardState) {
    this.db.prepare("INSERT INTO card_state VALUES(?,?,?,?,?) ON CONFLICT(user_id,bot_id,message_id,card_id) DO UPDATE SET value=excluded.value").run(userId, botId, messageId, cardId, JSON.stringify(value));
  }
  savedItems(userId: string): SavedItem[] {
    return (this.db.prepare("SELECT value FROM saved_items WHERE user_id=? ORDER BY rowid DESC").all(userId) as {value: string}[]).map(row => JSON.parse(row.value));
  }
  saveItem(userId: string, pointer: Omit<SavedItem, 'id' | 'createdAt'>): SavedItem {
    const key = JSON.stringify([pointer.kind,pointer.botId,pointer.sessionId,pointer.messageId,pointer.routineId,pointer.resultId]);
    const previous = this.db.prepare("SELECT value FROM saved_items WHERE user_id=? AND pointer_key=?").get(userId,key) as {value: string} | undefined;
    if (previous) return JSON.parse(previous.value);
    const item = {...pointer,id:randomUUID(),createdAt:new Date().toISOString()};
    this.db.prepare("INSERT INTO saved_items VALUES(?,?,?,?)").run(item.id,userId,key,JSON.stringify(item));
    return item;
  }
  deleteSavedItem(userId: string,id: string) { this.db.prepare("DELETE FROM saved_items WHERE user_id=? AND id=?").run(userId,id); }
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
  presentation(botId: string | undefined) {
    // Alerts and test pushes have no assistant; node:sqlite on Node 24 refuses to bind undefined.
    if (!botId) return {};
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
    // Matches the submissions_status expression index; settled history is never scanned.
    return (
      this.db.prepare("SELECT request_id FROM submissions WHERE json_extract(receipt,'$.status')='uncertain' ORDER BY created_at").all() as {
        request_id: string;
      }[]
    ).map((r) => this.submission(r.request_id)!);
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
  queueNotification(eventId: string, userId: string, payload: object) {
    return this.db
      .prepare("INSERT OR IGNORE INTO outbox(id,event_id,user_id,payload,created_at) VALUES(?,?,?,?,?)")
      .run(randomUUID(), eventId, userId, JSON.stringify(payload), Date.now()).changes > 0;
  }
  /** Assistant display names for notification titles, refreshed by the background worker. */
  botNames = new Map<string, string>();
  enqueue(event: RuntimeEvent) {
    const copy = notificationCopy(event, this.botNames.get(event.botId));
    for (const userId of this.recipients(event))
      this.queueNotification(event.id, userId, {
        title: copy.title,
        body: copy.body,
        url: `/?bot=${encodeURIComponent(event.botId)}${event.routineId ? `&routine=${encodeURIComponent(event.routineId)}` : ''}`,
        tag: event.id,
        kind: event.kind,
        botId: event.botId,
        queuedAt: Date.now(),
      });
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
          this.db.prepare("INSERT INTO notification_ingestion(event_id) SELECT ? WHERE NOT EXISTS(SELECT 1 FROM notification_ingestion WHERE event_id=?)").run(event.id, event.id);
          this.enqueue(event);
        }
      this.db
        .prepare(
          "INSERT INTO metadata VALUES('event_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(cursor);
    });
  }
  enqueueKnownEvents(now = Date.now()) {
    this.transaction(() => {
      // Late participants still receive recent events; a new follower never gets a month of history.
      for (const row of this.db
        .prepare("SELECT value FROM notification_events WHERE created_at>=?")
        .all(now - 86400000) as { value: string }[])
        this.enqueue(JSON.parse(row.value));
      this.db
        .prepare("DELETE FROM notification_events WHERE created_at<?")
        .run(now - 30 * 86400000);
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
  deliveryGroups(now = Date.now()) {
    const ready = this.outbox();
    const groups: {id: string; user_id: string; payload: string; items: typeof ready}[] = [];
    const seen = new Set<string>();
    for (const item of ready) {
      if (seen.has(item.id)) continue;
      const existing = this.db.prepare("SELECT b.* FROM notification_batches b JOIN notification_batch_items i ON i.batch_id=b.id WHERE i.outbox_id=?").get(item.id) as {id: string;user_id: string;payload: string} | undefined;
      if (existing) {
        const members = this.db.prepare("SELECT o.id FROM outbox o JOIN notification_batch_items i ON i.outbox_id=o.id WHERE i.batch_id=? AND o.state='pending'").all(existing.id) as {id: string}[];
        const ids = new Set(members.map(row => row.id));
        // A failed constituent's retry deadline applies to the entire frozen digest.
        const items = ready.filter(row => ids.has(row.id));
        items.forEach(row => seen.add(row.id));
        if (items.length === ids.size) groups.push({...existing,items});
        continue;
      }
      const prefs = this.preferences(item.user_id).notifications;
      const payload = JSON.parse(item.payload);
      const created = this.db.prepare("SELECT created_at FROM notification_events WHERE id=(SELECT event_id FROM outbox WHERE id=?)").get(item.id) as {created_at:number} | undefined;
      const minutes = prefs?.batchMinutes ?? 0;
      if (!minutes || !payload.kind || this.db.prepare('SELECT 1 FROM delivered WHERE outbox_id=?').get(item.id) || payload.kind === 'approval' || payload.kind === 'failed' || payload.kind === 'security') { groups.push({...item,items:[item]}); seen.add(item.id); continue; }
      if (now < (payload.queuedAt ?? created?.created_at ?? 0) + minutes * 60000) continue;
      const items = ready.filter(row => row.user_id === item.user_id && !seen.has(row.id) && !this.db.prepare("SELECT 1 FROM notification_batch_items WHERE outbox_id=?").get(row.id) && !this.db.prepare('SELECT 1 FROM delivered WHERE outbox_id=?').get(row.id) && ['completed','activity','interrupted'].includes(JSON.parse(row.payload).kind));
      const batchId = randomUUID();
      const digest = JSON.stringify({title:`${items.length} assistant update${items.length === 1 ? '' : 's'}`,body:items.slice(0,3).map(row=>JSON.parse(row.payload).title).join(' · '),url:'/?view=today',tag:batchId});
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare("INSERT INTO notification_batches VALUES(?,?,?)").run(batchId,item.user_id,digest);
        for (const row of items) this.db.prepare("INSERT INTO notification_batch_items VALUES(?,?)").run(row.id,batchId);
        this.db.exec('COMMIT');
      } catch(error) { this.db.exec('ROLLBACK'); throw error; }
      items.forEach(row=>seen.add(row.id)); groups.push({id:batchId,user_id:item.user_id,payload:digest,items});
    }
    return groups;
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
  /** Returns true when the notification has used its last attempt and is now failed. */
  retryDelivery(id: string, attempts: number, error?: string) {
    const failed = attempts >= maxDeliveryAttempts;
    this.db
      .prepare("UPDATE outbox SET attempts=?,next_attempt=?,last_error=?,state=? WHERE id=?")
      .run(
        attempts,
        Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(attempts, 12)),
        error ?? null,
        failed ? "failed" : "pending",
        id,
      );
    return failed;
  }
  expireNotifications(now = Date.now()) {
    // Matches the Web Push TTL: push services drop older messages anyway. Rows queued by an
    // older release have created_at 0 and no reliable age.
    return Number(this.db
      .prepare("UPDATE outbox SET state='expired' WHERE state='pending' AND created_at>0 AND created_at<?")
      .run(now - 86400000).changes);
  }
  pruneRetention(now = Date.now()) {
    // Only rows whose event has aged out of notification_events, so enqueueKnownEvents cannot re-create them.
    const stale = "SELECT id FROM outbox WHERE state<>'pending' AND created_at<? AND NOT EXISTS(SELECT 1 FROM notification_events e WHERE e.id=outbox.event_id)";
    const cutoff = now - 30 * 86400000;
    return this.transaction(() => {
      const sessions = this.db.prepare("DELETE FROM sessions WHERE expires<=?").run(now).changes;
      this.db.prepare(`DELETE FROM delivered WHERE outbox_id IN (${stale})`).run(cutoff);
      this.db.prepare(`DELETE FROM notification_batch_items WHERE outbox_id IN (${stale})`).run(cutoff);
      const notifications = this.db.prepare(`DELETE FROM outbox WHERE id IN (${stale})`).run(cutoff).changes;
      this.db.prepare("DELETE FROM notification_batches WHERE NOT EXISTS(SELECT 1 FROM notification_batch_items i WHERE i.batch_id=notification_batches.id)").run();
      return { sessions: Number(sessions), notifications: Number(notifications) };
    });
  }
}
