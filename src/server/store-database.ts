import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
  -- One push-to-start token per native installation and account, removed with its session.
  -- started holds the assistants an activity on that device already covered, so a dismissed
  -- activity does not come back for the same work; dismissed means the app dismissed one before the
  -- worker recorded what it covered; local_at is the app's own start after a send.
  CREATE TABLE IF NOT EXISTS live_activity_starts(device_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),session_hash TEXT NOT NULL REFERENCES native_sessions(hash) ON DELETE CASCADE,token TEXT NOT NULL,environment TEXT NOT NULL,scope TEXT NOT NULL,started TEXT NOT NULL DEFAULT '[]',dismissed INTEGER NOT NULL DEFAULT 0,local_at INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,UNIQUE(token,environment));
  -- Which chat each signed-in client is reading now, refreshed by heartbeats, and when each
  -- person last read each chat. Notifications skip what was already seen.
  CREATE TABLE IF NOT EXISTS chat_presence(user_id TEXT NOT NULL REFERENCES users(id),client_id TEXT NOT NULL,bot_id TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,client_id));
  CREATE TABLE IF NOT EXISTS chat_reads(user_id TEXT NOT NULL REFERENCES users(id),bot_id TEXT NOT NULL,read_at INTEGER NOT NULL,client_id TEXT NOT NULL,PRIMARY KEY(user_id,bot_id));
  -- When each native session's person last signed in with Google, which caps its renewals. A
  -- session without a row here, from before renewal, started a session lifetime before it expires.
  CREATE TABLE IF NOT EXISTS native_session_starts(hash TEXT PRIMARY KEY REFERENCES native_sessions(hash) ON DELETE CASCADE,signed_in_at INTEGER NOT NULL);
  -- Which household member sent each group chat message through this app, by Hermes event ID.
  CREATE TABLE IF NOT EXISTS group_senders(room_id TEXT NOT NULL,event_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,PRIMARY KEY(room_id,event_id));
  -- Single-use web push notification actions, by token hash, each bound to one person, approval and decision.
  CREATE TABLE IF NOT EXISTS push_action_tokens(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),bot_id TEXT NOT NULL,approval_id TEXT NOT NULL,decision TEXT NOT NULL,expires INTEGER NOT NULL);
  -- Approvals Hermes's open requests no longer held when this server read them, resolved outside the app.
  CREATE TABLE IF NOT EXISTS approval_resolutions(approval_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,resolved_at INTEGER NOT NULL);
  -- Each run's finishes, failures and interruptions by ingestion order, which settle that run's approvals.
  CREATE TABLE IF NOT EXISTS run_settlements(bot_id TEXT NOT NULL,run_id TEXT NOT NULL,ingestion_id INTEGER NOT NULL REFERENCES notification_ingestion(id) ON DELETE CASCADE,PRIMARY KEY(bot_id,run_id,ingestion_id));
  -- The first request that retried each failed turn, by assistant, retried message and failed run
  -- ('' without one). Every later retry of that turn follows this request instead of running again.
  CREATE TABLE IF NOT EXISTS retry_claims(bot_id TEXT NOT NULL,retry_of TEXT NOT NULL,run_id TEXT NOT NULL,request_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(bot_id,retry_of,run_id));
  CREATE TABLE IF NOT EXISTS draft_revisions(user_id TEXT NOT NULL REFERENCES users(id),bot_id TEXT NOT NULL,revision INTEGER NOT NULL,reason TEXT NOT NULL,sent_revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,bot_id));
`;
export const schemaVersion = migrations.length;
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

/**
 * The one SQLite connection every store repository shares, with its one transaction helper.
 * Transactions do not nest: a repository method that runs inside another's transaction
 * must not open its own.
 */
export class StoreDatabase {
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
    this.backfillSettlements();
  }
  /**
   * Records run outcomes that a previous release, after a rollback, recorded without settlements.
   * Only events ingested since the last backfill are read: ingestion IDs only grow, so anything
   * recorded since, by this release or another, is past the watermark.
   */
  private backfillSettlements() {
    this.transaction(() => {
      const watermark = Number((this.db.prepare("SELECT value FROM metadata WHERE key='settlement_backfill'").get() as { value: string } | undefined)?.value ?? 0);
      this.db.prepare(`INSERT OR IGNORE INTO run_settlements(bot_id,run_id,ingestion_id) SELECT json_extract(e.value,'$.botId'),json_extract(e.value,'$.runId'),i.id
        FROM notification_ingestion i JOIN notification_events e ON e.id=i.event_id
        WHERE i.id>? AND json_extract(e.value,'$.kind') IN ('completed','failed','interrupted') AND json_extract(e.value,'$.runId') IS NOT NULL AND json_extract(e.value,'$.botId') IS NOT NULL`)
        .run(watermark);
      const latest = (this.db.prepare("SELECT max(id) AS id FROM notification_ingestion").get() as { id: number | null }).id;
      if (latest !== null && latest > watermark)
        this.db.prepare("INSERT INTO metadata VALUES('settlement_backfill',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(latest));
    });
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
}
