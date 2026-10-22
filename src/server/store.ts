import { DatabaseSync } from "node:sqlite";
import { notificationCopy } from "../shared/event-copy.js";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Avatar,
  Preferences,
  RuntimeEvent,
  SavedDraft,
  Submission,
  SubmissionReceipt,
  User,
} from "../shared/types.js";
import type { ReplyCardState } from "../shared/reply-cards.js";
import { defaultPreferences } from "../shared/types.js";

import type { SavedItem } from "../shared/discovery.js";
import { visible } from "./bot-access.js";
import type { LiveState } from "./live-activity.js";

export interface LiveActivityRegistration {
  deviceId: string;
  userId: string;
  token: string;
  environment: "sandbox" | "production";
  /** Assistants the app just sent to, shown as starting until Hermes reports them. */
  armed: string[];
  armedAt: number;
  /** What the worker last saw, which carries each row's start time. */
  lastState?: LiveState;
  /** What the device last received. */
  sentState?: LiveState;
  sentAt: number;
  failures: number;
}

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
// Tables the previous release ignores. They are created on every start without raising
// user_version, because the previous release refuses a newer schema and must still open this
// database after a rollback. Rows it never writes here read as defaults.
const additions = `
  -- Who could see each assistant over time, so news stays with whoever could see it then.
  -- owner_id is null while it was visible to everyone. Periods are recorded on the first change.
  CREATE TABLE IF NOT EXISTS bot_visibility_periods(bot_id TEXT NOT NULL,started_at INTEGER NOT NULL,owner_id TEXT,PRIMARY KEY(bot_id,started_at));
  -- Every name each assistant has had, so a renamed private one stays hidden in old agent messages.
  CREATE TABLE IF NOT EXISTS bot_names(bot_id TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(bot_id,name));
  -- Draft revisions: a draft without a row here is at revision 0.
  -- One aggregate Live Activity push token per native installation, removed with its session.
  CREATE TABLE IF NOT EXISTS live_activities(device_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),session_hash TEXT NOT NULL REFERENCES native_sessions(hash) ON DELETE CASCADE,token TEXT NOT NULL,environment TEXT NOT NULL,armed TEXT NOT NULL,armed_at INTEGER NOT NULL,last_state TEXT,sent_state TEXT,sent_at INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,UNIQUE(token,environment));
  -- Which chat each signed-in client is reading now, refreshed by heartbeats, and when each
  -- person last read each chat. Notifications skip what was already seen.
  CREATE TABLE IF NOT EXISTS chat_presence(user_id TEXT NOT NULL REFERENCES users(id),client_id TEXT NOT NULL,bot_id TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,client_id));
  CREATE TABLE IF NOT EXISTS chat_reads(user_id TEXT NOT NULL REFERENCES users(id),bot_id TEXT NOT NULL,read_at INTEGER NOT NULL,client_id TEXT NOT NULL,PRIMARY KEY(user_id,bot_id));
  CREATE TABLE IF NOT EXISTS draft_revisions(user_id TEXT NOT NULL REFERENCES users(id),bot_id TEXT NOT NULL,revision INTEGER NOT NULL,reason TEXT NOT NULL,sent_revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,bot_id));
`;
export const schemaVersion = migrations.length;
// Exponential backoff spends about an hour on these; later news is stale.
export const maxDeliveryAttempts = 12;
// Clients report an open chat every 15 seconds, so a missed beat or two never counts as leaving.
export const presenceTtl = 45000;
/** What a client reports about a chat: reading it, gone after reading it, or still open but unattended. */
export type ChatPresence = "active" | "left" | "idle";
// Discovery lags Hermes by a poll, or longer after an outage, so Hermes's own timestamp says
// when the reply could first be read. One from a clock running ahead falls back to discovery.
function eventTime(occurredAt: string | undefined, discovered: number) {
  const occurred = Date.parse(occurredAt ?? "");
  return Number.isFinite(occurred) && occurred <= discovered ? occurred : discovered;
}
// A cleared notification is recorded as a delivery to a derived endpoint, so every path that
// forgets a notification's deliveries forgets its clears too.
const clearedEndpoint = (endpoint: string) => `cleared:${endpoint}`;
function addColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some(existing => existing.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
// A release briefly versioned bot_visibility_periods and bot_names as migration 3. Those tables
// are now additions, so such a database returns to version 2, which the previous release opens.
function unversionAdditions(db: DatabaseSync) {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
  if (version === 3 && migrations.length === 2 && tables.has("bot_visibility_periods") && tables.has("bot_names"))
    db.exec("PRAGMA user_version=2");
}
function migrate(db: DatabaseSync) {
  unversionAdditions(db);
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
    this.db.exec(additions);
    this.db.exec("INSERT INTO notification_ingestion(event_id) SELECT id FROM notification_events e WHERE NOT EXISTS(SELECT 1 FROM notification_ingestion i WHERE i.event_id=e.id) ORDER BY e.rowid");
    // Today pages filter in SQL with the same rule notifications use.
    this.db.function("may_receive", (value, userId) => this.mayReceive(JSON.parse(String(value)), String(userId)) ? 1 : 0);
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
  registerLiveActivity(userId: string, sessionHash: string, deviceId: string, token: string, environment: "sandbox" | "production", armed: string[], armedAt: number) {
    this.pruneNativeAuth();
    const conflicts = this.db.prepare("SELECT user_id FROM live_activities WHERE device_id=? OR (token=? AND environment=?)")
      .all(deviceId, token, environment) as { user_id: string }[];
    if (conflicts.some(row => row.user_id !== userId))
      throw Object.assign(new Error("This device's Live Activity belongs to another household member. Sign out there first."), { statusCode: 409 });
    // A new token replaces the device's previous activity and replays the current state.
    this.transaction(() => {
      const previous = this.liveActivityContext(userId, sessionHash, deviceId);
      const pending = previous && armedAt - previous.armedAt < 120_000 ? previous.armed : [];
      const merged = [...new Set([...pending, ...armed])];
      const since = armed.length || !previous ? armedAt : previous.armedAt;
      this.db.prepare("DELETE FROM live_activities WHERE token=? AND environment=? AND device_id<>?").run(token, environment, deviceId);
      this.db.prepare(`INSERT INTO live_activities(device_id,user_id,session_hash,token,environment,armed,armed_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(device_id) DO UPDATE SET
        last_state=CASE WHEN session_hash=excluded.session_hash THEN last_state ELSE NULL END,
        sent_state=CASE WHEN session_hash=excluded.session_hash AND token=excluded.token THEN sent_state ELSE NULL END,
        sent_at=CASE WHEN session_hash=excluded.session_hash AND token=excluded.token THEN sent_at ELSE 0 END,
        session_hash=excluded.session_hash,token=excluded.token,environment=excluded.environment,
        armed=excluded.armed,armed_at=excluded.armed_at,failures=0,retry_at=0`)
        .run(deviceId, userId, sessionHash, token, environment, JSON.stringify(merged), since);
    });
  }
  /** Only the native session that owns this activity can reuse its device's grace and history. */
  liveActivityContext(userId: string, sessionHash: string, deviceId: string) {
    const row = this.db.prepare("SELECT armed,armed_at,last_state FROM live_activities WHERE user_id=? AND session_hash=? AND device_id=?")
      .get(userId, sessionHash, deviceId) as { armed: string; armed_at: number; last_state: string | null } | undefined;
    return row ? { armed: JSON.parse(row.armed) as string[], armedAt: row.armed_at, lastState: row.last_state ? JSON.parse(row.last_state) as LiveState : undefined } : undefined;
  }
  removeLiveActivity(userId: string, deviceId: string, token: string) {
    this.db.prepare("DELETE FROM live_activities WHERE user_id=? AND device_id=? AND token=?").run(userId, deviceId, token);
  }
  liveActivities(environment: "sandbox" | "production", now = Date.now()): LiveActivityRegistration[] {
    this.pruneNativeAuth();
    return (this.db.prepare("SELECT * FROM live_activities WHERE environment=? AND retry_at<=?").all(environment, now) as {
      device_id: string; user_id: string; token: string; environment: "sandbox" | "production"; armed: string; armed_at: number;
      last_state: string | null; sent_state: string | null; sent_at: number; failures: number;
    }[]).map(row => ({ deviceId: row.device_id, userId: row.user_id, token: row.token, environment: row.environment, armed: JSON.parse(row.armed),
      armedAt: row.armed_at, lastState: row.last_state ? JSON.parse(row.last_state) : undefined,
      sentState: row.sent_state ? JSON.parse(row.sent_state) : undefined, sentAt: row.sent_at, failures: row.failures }));
  }
  /** Records what the worker last saw. Bots seen past starting leave the armed list. A token replaced meanwhile is untouched. */
  liveActivityObserved(deviceId: string, token: string, state: LiveState, progressed: string[]) {
    const row = this.db.prepare("SELECT armed FROM live_activities WHERE device_id=? AND token=?").get(deviceId, token) as { armed: string } | undefined;
    if (!row) return;
    const armed = (JSON.parse(row.armed) as string[]).filter(id => !progressed.includes(id));
    this.db.prepare("UPDATE live_activities SET last_state=?,armed=? WHERE device_id=? AND token=?").run(JSON.stringify(state), JSON.stringify(armed), deviceId, token);
  }
  liveActivitySent(deviceId: string, token: string, state: LiveState, sentAt: number) {
    this.db.prepare("UPDATE live_activities SET sent_state=?,sent_at=?,failures=0,retry_at=0 WHERE device_id=? AND token=?")
      .run(JSON.stringify(state), sentAt, deviceId, token);
  }
  /** Backs off a failing token: 15 seconds, doubling to five minutes. */
  liveActivityFailed(deviceId: string, token: string, now: number) {
    this.db.prepare("UPDATE live_activities SET failures=failures+1,retry_at=?+min(300000,15000*(1<<min(failures,5))) WHERE device_id=? AND token=?")
      .run(now, deviceId, token);
  }
  participants(runId: string) {
    return (this.db.prepare("SELECT user_id FROM participants WHERE run_id=?").all(runId) as { user_id: string }[]).map(row => row.user_id);
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
  /**
   * One page of this person's events. Events they may not receive, by mayReceive, are
   * skipped and never move the returned frontier, so it reveals nothing about hidden activity.
   */
  eventPage(userId: string, frontier: number, upperFrontier: number, botIds: string[], initialSince?: string) {
    if (!botIds.length) return { events: [], frontier: String(frontier), hasMore: false };
    const since = initialSince ? Date.parse(initialSince) : null;
    const mine = `FROM notification_ingestion i JOIN notification_events e ON e.id=i.event_id WHERE i.id>? AND i.id<=? AND json_extract(e.value,'$.botId') IN (${botIds.map(() => '?').join(',')}) AND may_receive(e.value,?)=1`;
    const rows = this.db.prepare(`SELECT i.id,e.value ${mine} AND (? IS NULL OR e.created_at>=?) ORDER BY i.id LIMIT 101`).all(frontier, upperFrontier, ...botIds, userId, since, since) as { id: number; value: string }[];
    const page = rows.slice(0, 100);
    // Older visible events before the recap start are passed over; hidden ones never count.
    const last = (this.db.prepare(`SELECT max(i.id) AS id ${mine}`).get(frontier, upperFrontier, ...botIds, userId) as { id: number | null }).id ?? frontier;
    return { events: page.map(row => JSON.parse(row.value) as RuntimeEvent), frontier: String(rows.length > 100 ? page.at(-1)!.id : Math.max(frontier, last)), hasMore: rows.length > 100 };
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
  // Drafts go through draft() and saveDraft() so every change advances the revision.
  personal(table: "read_positions", userId: string, botId: string) {
    const row = this.db
      .prepare(`SELECT value FROM ${table} WHERE user_id=? AND bot_id=?`)
      .get(userId, botId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  savePersonal(
    table: "read_positions",
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
  /** The person's saved draft, or null if they never saved one for this assistant. */
  draft(userId: string, botId: string): SavedDraft | null {
    const row = this.db
      .prepare("SELECT d.value,r.revision,r.reason,r.sent_revision AS sentRevision FROM drafts d LEFT JOIN draft_revisions r ON r.user_id=d.user_id AND r.bot_id=d.bot_id WHERE d.user_id=? AND d.bot_id=?")
      .get(userId, botId) as { value: string; revision: number | null; reason: SavedDraft["reason"] | null; sentRevision: number | null } | undefined;
    if (!row) return null;
    const { text, attachments } = JSON.parse(row.value) as Pick<SavedDraft, "text" | "attachments">;
    return { text, attachments, revision: row.revision ?? 0, reason: row.reason ?? "edit", sentRevision: row.sentRevision ?? 0 };
  }
  /**
   * Saves a draft edit. With `baseRevision`, the edit applies only to that revision; otherwise the
   * current draft comes back unsaved. Without it, as from older clients, the edit always applies.
   * Content the server already has is never a conflict and does not advance the revision.
   */
  saveDraft(userId: string, botId: string, value: Pick<SavedDraft, "text" | "attachments">, baseRevision?: number) {
    return this.transaction((): { saved: boolean; draft: SavedDraft } => {
      const current = this.draft(userId, botId);
      const content = JSON.stringify({ text: value.text, attachments: value.attachments });
      if (current && JSON.stringify({ text: current.text, attachments: current.attachments }) === content)
        return { saved: true, draft: current };
      if (baseRevision !== undefined && baseRevision !== (current?.revision ?? 0))
        return { saved: false, draft: current ?? { text: "", attachments: [], revision: 0, reason: "edit", sentRevision: 0 } };
      this.db
        .prepare("INSERT INTO drafts(user_id,bot_id,value) VALUES(?,?,?) ON CONFLICT(user_id,bot_id) DO UPDATE SET value=excluded.value")
        .run(userId, botId, content);
      this.advanceDraft(userId, botId, "edit");
      return { saved: true, draft: this.draft(userId, botId)! };
    });
  }
  /**
   * Clears the sender's draft once their message is accepted, if it still holds the sent text, or
   * if nothing changed it after the revision the message was written on. The second catches a
   * send made before the last edits were saved. Runs inside the receipt transaction.
   */
  clearSubmittedDraft(userId: string, botId: string, expected: Pick<SavedDraft, "text" | "attachments">, baseRevision?: number) {
    const current = this.draft(userId, botId);
    const empty = JSON.stringify({ text: "", attachments: [] });
    const content = current ? JSON.stringify({ text: current.text, attachments: current.attachments }) : empty;
    // An empty draft still records the send, so a save dispatched before it cannot restore the text.
    if (content !== empty && content !== JSON.stringify(expected) && (baseRevision === undefined || current!.revision > baseRevision))
      return false;
    this.db
      .prepare("INSERT INTO drafts(user_id,bot_id,value) VALUES(?,?,?) ON CONFLICT(user_id,bot_id) DO UPDATE SET value=excluded.value")
      .run(userId, botId, empty);
    this.advanceDraft(userId, botId, "sent");
    return true;
  }
  private advanceDraft(userId: string, botId: string, reason: SavedDraft["reason"]) {
    const previous = this.db.prepare("SELECT revision,sent_revision AS sentRevision FROM draft_revisions WHERE user_id=? AND bot_id=?")
      .get(userId, botId) as { revision: number; sentRevision: number } | undefined;
    const revision = (previous?.revision ?? 0) + 1;
    this.db
      .prepare("INSERT INTO draft_revisions(user_id,bot_id,revision,reason,sent_revision) VALUES(?,?,?,?,?) ON CONFLICT(user_id,bot_id) DO UPDATE SET revision=excluded.revision,reason=excluded.reason,sent_revision=excluded.sent_revision")
      .run(userId, botId, revision, reason, reason === "sent" ? revision : previous?.sentRevision ?? 0);
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
  /** Advances whenever an assistant's sharing or owner changes, so a request can tell it changed meanwhile. */
  privacyVersion = 0;
  private privacyChanges: { version: number; botId: string }[] = [];
  /** Assistants whose sharing or owner changed after this version. */
  changedSince(version: number) {
    return this.privacyChanges.filter(change => change.version > version).map(change => change.botId);
  }
  /** Private assistants and their owners. */
  privateBots(): { botId: string; ownerId: string }[] {
    return this.db.prepare("SELECT bot_id AS botId,owner_id AS ownerId FROM bot_presentation WHERE shared=0 AND owner_id IS NOT NULL").all() as { botId: string; ownerId: string }[];
  }
  rememberNames(bots: { id: string; name: string }[]) {
    const insert = this.db.prepare("INSERT OR IGNORE INTO bot_names VALUES(?,?)");
    for (const bot of bots) if (typeof bot.id === "string" && typeof bot.name === "string") insert.run(bot.id, bot.name);
  }
  /** Each assistant's current and earlier names. */
  nameHistory() {
    const names = new Map<string, Set<string>>();
    for (const row of this.db.prepare("SELECT bot_id AS botId,name FROM bot_names").all() as { botId: string; name: string }[])
      names.set(row.botId, (names.get(row.botId) ?? new Set()).add(row.name));
    return names;
  }
  /** Who could see the assistant from each moment on: an owner, or null for everyone. */
  visibilityPeriods(botId: string): { startedAt: number; ownerId: string | null }[] {
    return this.db.prepare("SELECT started_at AS startedAt,owner_id AS ownerId FROM bot_visibility_periods WHERE bot_id=? ORDER BY started_at").all(botId) as { startedAt: number; ownerId: string | null }[];
  }
  /**
   * Whether this person may hear about an event: they can see the assistant now, and could
   * when the event happened. An event without a readable time counts as private whenever
   * the assistant has ever been, so it reaches only someone who owned it.
   */
  mayReceive(event: Pick<RuntimeEvent, "botId" | "occurredAt">, userId: string) {
    if (!visible(this.presentation(event.botId), userId)) return false;
    const periods = this.visibilityPeriods(event.botId);
    if (!periods.length) return true;
    const at = Date.parse(event.occurredAt);
    if (Number.isNaN(at)) return periods.every(period => period.ownerId === null || period.ownerId === userId);
    const period = periods.findLast(period => period.startedAt <= at) ?? periods[0];
    return period.ownerId === null || period.ownerId === userId;
  }
  /** The latest write of each assistant's sharing, so a rollback can tell its own write from a later one. */
  private versions = new Map<string, number>();
  private writePresentation(botId: string, next: { ownerId?: string; shared: boolean }, avatar: string | null) {
    const previous = this.presentation(botId);
    this.db.prepare("INSERT INTO bot_presentation VALUES(?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET owner_id=excluded.owner_id,shared=excluded.shared,avatar=excluded.avatar")
      .run(botId, next.ownerId ?? null, +next.shared, avatar);
    const before = previous.shared === false && previous.ownerId ? previous.ownerId : null;
    const after = !next.shared && next.ownerId ? next.ownerId : null;
    if (before !== after) {
      const now = Date.now();
      // The first change also records how it was before, back to the beginning.
      if (!this.visibilityPeriods(botId).length) this.db.prepare("INSERT INTO bot_visibility_periods VALUES(?,0,?)").run(botId, before);
      this.db.prepare("INSERT INTO bot_visibility_periods VALUES(?,?,?) ON CONFLICT(bot_id,started_at) DO UPDATE SET owner_id=excluded.owner_id").run(botId, now, after);
    }
    const version = ++this.privacyVersion;
    this.versions.set(botId, version);
    if ((previous.shared !== false) !== next.shared || (previous.ownerId ?? null) !== (next.ownerId ?? null)) {
      this.privacyChanges.push({ version, botId });
      if (this.privacyChanges.length > 1000) this.privacyChanges.splice(0, 500);
    }
    return version;
  }
  /** ownerId is written as given, so a shared assistant keeps no stale owner. */
  savePresentation(botId: string, input: { ownerId?: string; shared: boolean; avatar?: Avatar }) {
    this.transaction(() => {
      const avatar = input.avatar ?? this.presentation(botId).avatar;
      this.writePresentation(botId, input, avatar ? JSON.stringify(avatar) : null);
    });
  }
  /**
   * Changes sharing and owner only if they are still what the caller authorized against.
   * A save that raced another member's change returns false and writes nothing.
   */
  swapPresentation(botId: string, expected: { ownerId?: string; shared?: boolean }, next: { ownerId?: string; shared: boolean }): number | false {
    return this.transaction(() => {
      const current = this.presentation(botId);
      if ((current.shared !== false) !== (expected.shared !== false) || (current.ownerId ?? null) !== (expected.ownerId ?? null)) return false;
      return this.writePresentation(botId, next, current.avatar ? JSON.stringify(current.avatar) : null);
    });
  }
  /** Puts sharing back, only if the write that version made is still the latest one. */
  restorePresentation(botId: string, version: number, previous: { ownerId?: string; shared?: boolean }) {
    return this.transaction(() => {
      if (this.versions.get(botId) !== version) return false;
      // An assistant that had no record before goes back to having none.
      if (previous.shared === undefined) {
        this.db.prepare("DELETE FROM bot_presentation WHERE bot_id=?").run(botId);
        this.db.prepare("DELETE FROM bot_visibility_periods WHERE bot_id=?").run(botId);
        this.versions.set(botId, ++this.privacyVersion);
        return true;
      }
      const current = this.presentation(botId);
      this.writePresentation(botId, { shared: previous.shared !== false, ownerId: previous.ownerId }, current.avatar ? JSON.stringify(current.avatar) : null);
      return true;
    });
  }
  /** Changes only the avatar, never who may see the assistant. */
  saveAvatar(botId: string, avatar: Avatar, shared: boolean) {
    this.db.prepare("INSERT INTO bot_presentation(bot_id,owner_id,shared,avatar) VALUES(?,NULL,?,?) ON CONFLICT(bot_id) DO UPDATE SET avatar=excluded.avatar")
      .run(botId, +shared, JSON.stringify(avatar));
  }
  /** Removes what this app keeps about a deleted assistant, so a new one reusing its ID starts clean. */
  // Its news, runs and receipts go too: with no owner left on record, anything kept would
  // reach former participants and followers, or attribute a reused ID's messages.
  forgetBot(botId: string) {
    this.transaction(() => {
      const ids = (sql: string) => (this.db.prepare(sql).all(botId, botId) as { id: string | null }[]).flatMap(row => row.id ? [row.id] : []);
      const runs = ids("SELECT json_extract(value,'$.runId') AS id FROM notification_events WHERE json_extract(value,'$.botId')=? UNION SELECT json_extract(receipt,'$.runId') FROM submissions WHERE bot_id=?");
      const routines = ids("SELECT json_extract(value,'$.routineId') AS id FROM notification_events WHERE json_extract(value,'$.botId')=? UNION SELECT routine_id FROM routine_trials WHERE bot_id=?");
      const outbox = "SELECT id FROM outbox WHERE json_extract(payload,'$.botId')=?";
      this.db.prepare(`DELETE FROM delivered WHERE outbox_id IN (${outbox})`).run(botId);
      this.db.prepare(`DELETE FROM notification_batch_items WHERE outbox_id IN (${outbox})`).run(botId);
      this.db.prepare("DELETE FROM outbox WHERE json_extract(payload,'$.botId')=?").run(botId);
      this.db.prepare("DELETE FROM notification_batches WHERE NOT EXISTS(SELECT 1 FROM notification_batch_items i WHERE i.batch_id=notification_batches.id)").run();
      this.db.prepare("DELETE FROM notification_events WHERE json_extract(value,'$.botId')=?").run(botId);
      for (const run of runs) this.db.prepare("DELETE FROM participants WHERE run_id=?").run(run);
      for (const routine of routines) this.db.prepare("DELETE FROM routine_recipients WHERE routine_id=?").run(routine);
      for (const table of ["bot_presentation", "bot_visibility_periods", "bot_names", "drafts", "draft_revisions", "read_positions", "chat_presence", "chat_reads", "card_state", "submissions", "approval_attribution", "routine_trials"])
        this.db.prepare(`DELETE FROM ${table} WHERE bot_id=?`).run(botId);
      this.db.prepare("DELETE FROM saved_items WHERE json_extract(value,'$.botId')=?").run(botId);
      for (const user of this.users()) {
        const value = this.preferences(user.id);
        const kept = (id: string) => id !== botId;
        const next = { ...value, favorites: value.favorites.filter(kept), followBots: value.followBots.filter(kept),
          sections: value.sections.map(section => ({ ...section, botIds: section.botIds.filter(kept) })),
          defaultBotId: value.defaultBotId === botId ? undefined : value.defaultBotId };
        if (JSON.stringify(next) !== JSON.stringify(value)) this.savePreferences(user.id, next);
      }
    });
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
        }, row.input.draftBaseRevision);
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
    // A private assistant's news goes only to its owner, whoever else followed or joined in.
    return [...ids].filter(userId => this.mayReceive(event, userId));
  }
  /** Records what one client reports about one chat. Reading and leaving after reading both mark it read until now. */
  chatPresence(userId: string, botId: string, clientId: string, state: ChatPresence, now = Date.now()) {
    this.transaction(() => {
      if (state === "active")
        this.db.prepare("INSERT INTO chat_presence VALUES(?,?,?,?) ON CONFLICT(user_id,client_id) DO UPDATE SET bot_id=excluded.bot_id,updated_at=excluded.updated_at")
          .run(userId, clientId, botId, now);
      else this.db.prepare("DELETE FROM chat_presence WHERE user_id=? AND client_id=? AND bot_id=?").run(userId, clientId, botId);
      if (state !== "idle")
        this.db.prepare("INSERT INTO chat_reads VALUES(?,?,?,?) ON CONFLICT(user_id,bot_id) DO UPDATE SET read_at=max(chat_reads.read_at,excluded.read_at),client_id=excluded.client_id")
          .run(userId, botId, now, clientId);
    });
  }
  /**
   * Whether the recipient has a notification's chat open now, or read it after the event.
   * Security alerts and routine results are not part of a chat, so they never count as seen.
   */
  seenInChat(outboxId: string, now = Date.now()) {
    const row = this.db.prepare("SELECT o.user_id,o.payload,o.created_at,e.value,e.created_at AS discovered FROM outbox o LEFT JOIN notification_events e ON e.id=o.event_id WHERE o.id=?")
      .get(outboxId) as { user_id: string; payload: string; created_at: number; value: string | null; discovered: number | null } | undefined;
    if (!row) return false;
    const payload = JSON.parse(row.payload) as { botId?: string; kind?: string; url?: string };
    if (!payload.botId || payload.kind === "security" || new URL(payload.url ?? "/", "http://app").searchParams.has("routine")) return false;
    if (this.db.prepare("SELECT 1 FROM chat_presence WHERE user_id=? AND bot_id=? AND updated_at>?").get(row.user_id, payload.botId, now - presenceTtl)) return true;
    const read = this.db.prepare("SELECT read_at FROM chat_reads WHERE user_id=? AND bot_id=?").get(row.user_id, payload.botId) as { read_at: number } | undefined;
    const event = row.value ? JSON.parse(row.value) as RuntimeEvent : undefined;
    return !!read && read.read_at >= eventTime(event?.occurredAt, row.discovered ?? row.created_at);
  }
  /** iOS deliveries of notifications their recipient has since read, with who read them, that no clear was sent for. */
  readOnDevices(now = Date.now()) {
    // A week covers what a lock screen plausibly still shows.
    return (this.db.prepare(`SELECT d.outbox_id,d.endpoint,o.user_id,json_extract(o.payload,'$.tag') AS tag,r.client_id AS reader FROM delivered d
      JOIN outbox o ON o.id=d.outbox_id JOIN chat_reads r ON r.user_id=o.user_id AND r.bot_id=json_extract(o.payload,'$.botId')
      WHERE d.endpoint LIKE 'apns:%' AND o.created_at>? AND NOT EXISTS(SELECT 1 FROM delivered c WHERE c.outbox_id=d.outbox_id AND c.endpoint='cleared:'||d.endpoint) ORDER BY o.created_at`)
      .all(now - 7 * 86400000) as { outbox_id: string; endpoint: string; user_id: string; tag: string; reader: string }[])
      .filter(row => this.seenInChat(row.outbox_id, now));
  }
  markCleared(id: string, endpoint: string) {
    this.markDelivered(id, clearedEndpoint(endpoint));
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
        // Lets an iOS notification decide this approval. Without it the notification only opens the chat.
        ...(event.kind === "approval" && typeof event.approvalId === "string" && event.approvalId ? { approvalId: event.approvalId } : {}),
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
      this.db.prepare("DELETE FROM chat_presence WHERE updated_at<?").run(now - presenceTtl);
      this.db.prepare(`DELETE FROM delivered WHERE outbox_id IN (${stale})`).run(cutoff);
      this.db.prepare(`DELETE FROM notification_batch_items WHERE outbox_id IN (${stale})`).run(cutoff);
      const notifications = this.db.prepare(`DELETE FROM outbox WHERE id IN (${stale})`).run(cutoff).changes;
      this.db.prepare("DELETE FROM notification_batches WHERE NOT EXISTS(SELECT 1 FROM notification_batch_items i WHERE i.batch_id=notification_batches.id)").run();
      return { sessions: Number(sessions), notifications: Number(notifications) };
    });
  }
}
