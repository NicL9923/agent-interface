import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  db.prepare("INSERT INTO drafts VALUES(?,?,?)").run("one", "ranch", JSON.stringify({ text: "Unsent before the upgrade", attachments: [] }));
  db.prepare("INSERT OR IGNORE INTO outbox(id,event_id,user_id,payload) VALUES(?,?,?,?)").run("outbox-1", "event-1", "one", JSON.stringify({ queuedAt: 1234 }));
  db.prepare("INSERT OR IGNORE INTO outbox(id,event_id,user_id,payload) VALUES(?,?,?,?)").run("outbox-untimed", "event-untimed", "one", "{}");
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
    // Existing rows keep their queue time; untimed rows count from the upgrade, never from 1970.
    const created = Object.fromEntries((store.db.prepare("SELECT id,created_at FROM outbox").all() as { id: string; created_at: number }[]).map(row => [row.id, row.created_at]));
    expect(created["outbox-1"]).toBe(1234);
    expect(created["outbox-untimed"]).toBeGreaterThan(Date.now() - 60_000);
    // Drafts saved before revisions start at revision 0, so a client's first base matches.
    expect(store.draft("one", "ranch")).toEqual({ text: "Unsent before the upgrade", attachments: [], revision: 0, reason: "edit", sentRevision: 0 });
    expect(store.saveDraft("one", "ranch", { text: "Edited after", attachments: [] }, 0)).toMatchObject({ saved: true, draft: { revision: 1 } });
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
    expect(() => store.db.prepare("INSERT INTO drafts VALUES(?,?,?) ON CONFLICT(user_id,bot_id) DO UPDATE SET value=excluded.value").run("one", "ranch", "{}")).not.toThrow();
    expect(() => store.db.prepare("INSERT OR IGNORE INTO outbox(id,event_id,user_id,payload) VALUES(?,?,?,?)").run("outbox-2", "event-2", "one", "{}")).not.toThrow();
  });
});

// The schema the previous release creates and accepts. Regenerate it only with a deliberate
// schema bump, which also ends rollback to that release.
const previousRelease = JSON.parse(readFileSync(new URL("./fixtures/previous-release-schema.json", import.meta.url), "utf8")) as
  { schemaVersion: number; objects: { type: string; name: string; tableName: string; sql: string }[] };
const objects = (db: DatabaseSync) =>
  db.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as typeof previousRelease.objects;

describe("rollback to the previous release", () => {
  it("never raises the schema version past what the previous release accepts", () => {
    expect(schemaVersion).toBeLessThanOrEqual(previousRelease.schemaVersion);
    expect(version(open(legacyDatabase()).db)).toBeLessThanOrEqual(previousRelease.schemaVersion);
  });

  it("keeps every object of the previous schema and only adds new tables beside them", () => {
    const current = objects(open(legacyDatabase()).db);
    for (const object of previousRelease.objects) expect(current).toContainEqual(object);
    const known = new Set(previousRelease.objects.map(object => object.name));
    const oldTables = new Set(previousRelease.objects.filter(object => object.type === "table").map(object => object.name));
    for (const added of current.filter(object => !known.has(object.name))) {
      expect(added.type, added.name).toBe("table");
      expect(added.sql, added.name).toMatch(/^CREATE TABLE/);
      expect(oldTables.has(added.tableName), added.name).toBe(false);
    }
  });

  it("opens a database the previous release wrote", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-store-"));
    directories.push(directory);
    const path = join(directory, "app.sqlite");
    const db = new DatabaseSync(path);
    for (const object of [...previousRelease.objects].sort((a, b) => +(a.type === "index") - +(b.type === "index"))) db.exec(object.sql);
    db.exec(`PRAGMA user_version=${previousRelease.schemaVersion}`);
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run("one", "one@example.test", "One", null);
    db.prepare("INSERT INTO drafts VALUES(?,?,?)").run("one", "ranch", JSON.stringify({ text: "Written before the upgrade", attachments: [] }));
    db.close();
    const store = open(path);
    expect(store.draft("one", "ranch")).toEqual({ text: "Written before the upgrade", attachments: [], revision: 0, reason: "edit", sentRevision: 0 });
    expect(store.saveDraft("one", "ranch", { text: "Edited", attachments: [] }, 0)).toMatchObject({ saved: true, draft: { revision: 1 } });
  });
});

// An extra local check with the real previous store, as on origin/main. A shallow checkout skips it.
const previousStore = (() => {
  try { return execFileSync("git", ["show", "origin/main:src/server/store.ts"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return undefined; }
})();
describe.skipIf(!previousStore)("rollback", () => {
  it("lets the previous release start on a database this release wrote", async () => {
    const path = legacyDatabase();
    const current = open(path);
    current.saveDraft("one", "ranch", { text: "Saved by this release", attachments: [] }, 0);
    current.close();
    stores.pop();
    // Placed beside the real module so its relative imports resolve.
    const file = fileURLToPath(new URL(`../src/server/.previous-store-${process.pid}.ts`, import.meta.url));
    writeFileSync(file, previousStore!);
    try {
      const { Store: Previous } = await import(/* @vite-ignore */ pathToFileURL(file).href) as typeof import("../src/server/store.js");
      const previous = new Previous(path);
      try {
        expect(previous.personal("drafts" as "read_positions", "one", "ranch")).toEqual({ text: "Saved by this release", attachments: [] });
        previous.savePersonal("drafts" as "read_positions", "one", "ranch", { text: "Written after rollback", attachments: [] });
      } finally { previous.close(); }
    } finally { rmSync(file, { force: true }); }
    expect(open(path).draft("one", "ranch")).toMatchObject({ text: "Written after rollback", revision: 1 });
  });
});
