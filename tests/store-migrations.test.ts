import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, schemaVersion } from "../src/server/store.js";

const legacySchema = readFileSync(new URL("./fixtures/schema-v0.sql", import.meta.url), "utf8");
// Tables the previous release writes only with named columns, so new defaulted columns are safe.
const namedWritesOnly = new Set(["outbox"]);
const directories: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function legacyDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "agent-store-"));
  directories.push(directory);
  const path = join(directory, "app.sqlite");
  const db = new DatabaseSync(path);
  db.exec(legacySchema);
  // Rows written the way the unversioned release wrote them.
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run("one", "one@example.test", "One", null);
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run("session-hash", "one", "csrf", Date.now() + 60_000);
  const submission = (id: string, receipt: object) =>
    db.prepare("INSERT INTO submissions VALUES(?,?,?,?,?,?)")
      .run(id, "ranch", "one", JSON.stringify({ requestId: id, botId: "ranch", senderId: "one", text: id }), JSON.stringify({ requestId: id, ...receipt }), 1);
  submission("accepted-request", { status: "accepted", messageId: "message-1" });
  submission("uncertain-request", { status: "uncertain" });
  db.prepare("INSERT OR IGNORE INTO outbox(id,event_id,user_id,payload) VALUES(?,?,?,?)").run("outbox-1", "event-1", "one", "{}");
  db.close();
  return path;
}
const open = (path: string) => {
  const store = new Store(path);
  stores.push(store);
  return store;
};
const version = (db: DatabaseSync) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const columns = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name);
const plan = (db: DatabaseSync, sql: string, ...values: (string | number)[]) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as { detail: string }[]).map(row => row.detail).join("\n");

describe("store migrations", () => {
  it("upgrades an unversioned installation in place without losing rows", () => {
    const store = open(legacyDatabase());
    expect(version(store.db)).toBe(schemaVersion);
    expect(store.getSession("session-hash")).toMatchObject({ userId: "one", csrf: "csrf" });
    expect(store.submissionForMessage("ranch", "message-1")?.input.requestId).toBe("accepted-request");
    expect(store.pending().map(row => row.input.requestId)).toEqual(["uncertain-request"]);
    expect(columns(store.db, "outbox")).toEqual(expect.arrayContaining(["created_at", "last_error"]));
    expect(columns(store.db, "session_confirmations")).toEqual(["session_hash", "confirmed_at"]);
  });

  it("serves polling lookups from indexes", () => {
    const store = open(legacyDatabase());
    expect(plan(store.db, "SELECT request_id FROM submissions WHERE bot_id=? AND json_extract(receipt,'$.messageId')=?", "ranch", "message-1"))
      .toContain("submissions_message");
    expect(plan(store.db, "SELECT request_id FROM submissions WHERE json_extract(receipt,'$.status')='uncertain' ORDER BY created_at"))
      .toContain("submissions_status");
    expect(plan(store.db, "SELECT * FROM outbox WHERE state='pending' AND next_attempt<=? ORDER BY rowid", Date.now()))
      .toContain("outbox_ready");
  });

  it("reopens a migrated database without changes", () => {
    const path = legacyDatabase();
    open(path).close();
    stores.pop();
    const store = open(path);
    expect(version(store.db)).toBe(schemaVersion);
    expect(store.getSession("session-hash")).toBeDefined();
  });

  it("refuses a database written by a newer release", () => {
    const path = legacyDatabase();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version=${schemaVersion + 1}`);
    db.close();
    expect(() => new Store(path)).toThrow(/supports up to/);
  });

  it("keeps the previous release's positional writes working after migration", () => {
    const legacy = new DatabaseSync(":memory:");
    legacy.exec(legacySchema);
    const tables = (legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row => row.name);
    const store = open(legacyDatabase());
    for (const table of tables.filter(table => !namedWritesOnly.has(table)))
      expect({ table, columns: columns(store.db, table) }).toEqual({ table, columns: columns(legacy, table) });
    legacy.close();
    expect(() => store.db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run("rollback-session", "one", "csrf", Date.now())).not.toThrow();
    expect(() => store.db.prepare("INSERT OR IGNORE INTO outbox(id,event_id,user_id,payload) VALUES(?,?,?,?)").run("outbox-2", "event-2", "one", "{}")).not.toThrow();
  });
});
