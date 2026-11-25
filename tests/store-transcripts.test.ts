import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, schemaVersion } from "../src/server/store.js";
import type { TranscriptMessageInput } from "../src/server/store-transcripts.js";
import type { Message } from "../src/shared/types.js";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function open(path = ":memory:") {
  const store = new Store(path);
  stores.push(store);
  return store;
}

const bot = "ranch";
const otherBot = "other";
const hermes = "hermes";
const message = (
  id: string,
  changes: Partial<TranscriptMessageInput> = {},
): TranscriptMessageInput => ({
  id,
  role: "assistant",
  text: id,
  ...changes,
});
const ids = (messages: readonly Message[]) => messages.map(({ id }) => id);

function checkIndex(store: Store) {
  store.db.exec("INSERT INTO transcript_fts(transcript_fts,rank) VALUES('integrity-check',1)");
}

describe("transcript repository", () => {
  it("returns exclusive pages of the newest rows in conversation order, scoped to the bot", () => {
    const store = open();
    const { transcripts } = store;
    expect(transcripts.listPage(bot, { limit: 2 })).toEqual({
      messages: [],
      hasMore: false,
      oldestSeq: null,
      newestSeq: null,
    });
    transcripts.appendMessages(bot, [message("one"), message("two")], hermes);
    transcripts.appendMessages(otherBot, [message("other")], hermes);
    transcripts.appendMessages(bot, [message("three"), message("four")], hermes);
    const latest = transcripts.listPage(bot, { limit: 2 });
    expect(ids(latest.messages)).toEqual(["three", "four"]);
    expect(latest.messages.map(({ seq }) => seq)).toEqual([3, 4]);
    expect(transcripts.messageSeq(otherBot, "other")).toBe(1);
    expect(latest).toMatchObject({
      hasMore: true,
      oldestSeq: latest.messages[0].seq,
      newestSeq: latest.messages[1].seq,
    });
    expect(latest.oldestSeq).toBeLessThan(latest.newestSeq!);
    const previous = transcripts.listPage(bot, { limit: 2, beforeSeq: latest.oldestSeq! });
    expect(ids(previous.messages)).toEqual(["one", "two"]);
    expect(previous.hasMore).toBe(false);
    expect(previous.newestSeq).toBeLessThan(latest.oldestSeq!);
    expect(
      transcripts.listPage(bot, { limit: 2, beforeSeq: previous.oldestSeq! }).messages,
    ).toEqual([]);
    expect(transcripts.messageSeq(bot, "three")).toBe(latest.oldestSeq);
    expect(transcripts.messageSeq(otherBot, "three")).toBeUndefined();

    // SQLite must seek into the bot's range and read it in order without a sort.
    const plan = store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM transcript_messages WHERE bot_id=? AND seq<? ORDER BY seq DESC LIMIT ?",
      )
      .all(bot, latest.oldestSeq!, 3)
      .map(({ detail }) => detail)
      .join("\n");
    expect(plan).toMatch(
      /USING INDEX sqlite_autoindex_transcript_messages_\d+ \(bot_id=\? AND seq<\?\)/,
    );
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("keeps sequence and update time on retry, changes payload in place and counts each new ID once", () => {
    const { transcripts } = open();
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    const initial = message("same", { text: "original" });
    transcripts.appendMessages(bot, [initial, message("later")], hermes);
    const first = transcripts.listPage(bot, { limit: 3 }).messages[0];
    clock.mockReturnValue(110);
    transcripts.appendMessages(bot, [initial], hermes);
    expect(transcripts.listPage(bot, { limit: 3 }).messages[0]).toEqual(first);
    clock.mockReturnValue(120);
    expect(
      transcripts.appendMessages(
        bot,
        [
          message("new"),
          message("same", { text: "edited" }),
          message("new", { text: "last version" }),
        ],
        hermes,
      ),
    ).toMatchObject({ messageCount: 3, lastMessageId: "new", lastSyncedAt: 120 });
    const page = transcripts.listPage(bot, { limit: 3 });
    expect(ids(page.messages)).toEqual(["same", "later", "new"]);
    expect(page.messages[0]).toMatchObject({ seq: first.seq, text: "edited", updatedAt: 120 });
    expect(page.messages[2]).toMatchObject({ text: "last version" });
    expect(page.messages[2].seq).toBeGreaterThan(page.messages[1].seq);
  });

  it("round-trips message metadata and clears optional fields when an upsert omits them", () => {
    const { transcripts } = open();
    const detailed = message("tool", {
      sourceRowId: "provider-row",
      role: "tool",
      runId: "run",
      createdAt: "2026-11-23T12:00:00.000Z",
      text: "",
      reasoning: "compare the forecast",
      toolName: "weather",
      toolCall: { id: "call", name: "weather", status: "completed", result: "sunny" },
      files: [{ id: "file", name: "forecast.txt", mime: "text/plain", size: 0 }],
      sender: { id: "member", name: "Member" },
      origin: { kind: "process", visibility: "activity" },
      interim: false,
      steered: true,
    });
    transcripts.appendMessages(bot, [detailed], "codex");
    expect(transcripts.listPage(bot, { limit: 1 }).messages).toEqual([
      {
        ...detailed,
        sourceRuntime: "codex",
        seq: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    ]);
    transcripts.appendMessages(bot, [message("tool")], "pi");
    expect(transcripts.listPage(bot, { limit: 1 }).messages).toEqual([
      {
        ...message("tool"),
        sourceRuntime: "pi",
        seq: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("rewrites reordered histories, preserves the prefix cursor and keeps FTS in sync through compaction", () => {
    const store = open();
    const { transcripts } = store;
    transcripts.appendMessages(
      bot,
      [message("keep"), message("discard", { text: "obsolete" }), message("move"), message("last")],
      hermes,
    );
    transcripts.appendMessages(otherBot, [message("discard", { text: "obsolete" })], hermes);
    const before = transcripts.listPage(bot, { limit: 10 });
    const replacement = [
      message("keep", { text: "revised" }),
      message("last"),
      message("move"),
      message("captured"),
      message("captured", { text: "latest snapshot value" }),
    ];
    expect(transcripts.replaceFromSnapshot(bot, replacement, hermes)).toMatchObject({
      messageCount: 4,
      lastMessageId: "captured",
    });
    const after = transcripts.listPage(bot, { limit: 10 });
    expect(ids(after.messages)).toEqual(["keep", "last", "move", "captured"]);
    expect(after.oldestSeq).toBe(before.oldestSeq);
    expect(after.messages[1].seq).toBe(before.newestSeq);
    expect(after.messages[2].seq).toBeGreaterThan(before.newestSeq!);
    expect(after.messages[3].text).toBe("latest snapshot value");
    transcripts.replaceFromSnapshot(bot, replacement, hermes);
    expect(transcripts.listPage(bot, { limit: 10 })).toEqual(after);
    expect(transcripts.search([bot], "keep obsolete", { limit: 10 })).toEqual([]);
    expect(
      transcripts.search([bot, otherBot], "obsolete", { limit: 10 }).map((hit) => hit.botId),
    ).toEqual([otherBot]);
    expect(transcripts.search([bot], "revised", { limit: 10 })[0]?.messageId).toBe("keep");
    checkIndex(store);

    expect(transcripts.replaceFromSnapshot(bot, [], hermes)).toMatchObject({
      messageCount: 0,
      lastMessageId: null,
    });
    const restarted = transcripts.appendMessages(bot, [message("new")], hermes);
    expect(restarted).toMatchObject({ messageCount: 1, lastMessageId: "new" });
    expect(transcripts.messageSeq(bot, "new")).toBeGreaterThan(after.newestSeq!);
    expect(transcripts.search([bot], "revised", { limit: 10 })).toEqual([]);
    expect(ids(transcripts.listPage(otherBot, { limit: 10 }).messages)).toEqual(["discard"]);
    checkIndex(store);
  });

  it("rolls back messages, index and sync state when an append or replacement fails partway", () => {
    const store = open();
    const { transcripts } = store;
    const invalid = message("invalid", { role: "unrecognized" as Message["role"] });
    const original = transcripts.appendMessages(bot, [message("original")], hermes);
    expect(() => transcripts.appendMessages(bot, [message("partial"), invalid], hermes)).toThrow(
      /CHECK constraint failed/,
    );
    expect(() =>
      transcripts.replaceFromSnapshot(bot, [message("partial"), invalid], hermes),
    ).toThrow(/CHECK constraint failed/);
    expect(transcripts.syncState(bot)).toEqual(original);
    expect(ids(transcripts.listPage(bot, { limit: 10 }).messages)).toEqual(["original"]);
    expect(transcripts.search([bot], "original", { limit: 10 })[0]?.messageId).toBe("original");
    expect(transcripts.search([bot], "partial", { limit: 10 })).toEqual([]);
    checkIndex(store);
  });

  it("searches text, reasoning and tool names across allowed bots and scopes results before offset", () => {
    const store = open();
    const { transcripts } = store;
    const hiddenBot = "private";
    transcripts.appendMessages(bot, [message("same", { text: "Find the pasture." })], hermes);
    transcripts.appendMessages(
      otherBot,
      [
        message("reason", { text: "", reasoning: "Inspect the pasture first." }),
        message("tool", { text: "", toolName: "pasture_lookup", role: "tool" }),
      ],
      hermes,
    );
    transcripts.appendMessages(
      hiddenBot,
      [message("same", { text: "Private pasture coordinates" })],
      hermes,
    );

    const hits = transcripts.search([bot, otherBot, bot], "pasture", { limit: 10 });
    expect(hits.map(({ botId, messageId, snippet }) => ({ botId, messageId, snippet }))).toEqual([
      { botId: otherBot, messageId: "tool", snippet: "[pasture]_lookup" },
      { botId: otherBot, messageId: "reason", snippet: "Inspect the [pasture] first." },
      { botId: bot, messageId: "same", snippet: "Find the [pasture]." },
    ]);
    expect(transcripts.search([bot, otherBot], "pasture", { limit: 1, offset: 1 })).toEqual([
      hits[1],
    ]);
    expect(transcripts.search([bot], "pasture", { limit: 1 })).toEqual([hits[2]]);
    expect(transcripts.search([bot], "coordinates", { limit: 1 })).toEqual([]);
    expect(transcripts.search([], "pasture", { limit: 10 })).toEqual([]);
    expect(transcripts.search(["private') OR 1=1 --"], "pasture", { limit: 10 })).toEqual([]);

    transcripts.appendMessages(bot, [message("same", { text: "New hay delivery" })], hermes);
    expect(transcripts.search([bot], "pasture", { limit: 10 })).toEqual([]);
    expect(transcripts.search([bot], "delivery", { limit: 10 })[0]?.messageId).toBe("same");
    checkIndex(store);
  });

  it("treats FTS operators, punctuation, malformed quotes, and Unicode as search text", () => {
    const { transcripts } = open();
    transcripts.appendMessages(
      bot,
      [
        message("both", { text: "foo bar AND OR NOT NEAR baz Café 東京" }),
        message("left", { text: "foo alone" }),
      ],
      hermes,
    );
    for (const query of [
      '"foo:bar"',
      '"foo bar',
      "foo OR bar",
      "foo NOT bar",
      "NEAR(foo bar, *)",
      "foo + bar*",
      "AND",
      "cafe 東京",
      "cafe\u0301",
      "foo\0bar",
    ]) {
      expect(
        transcripts.search([bot], query, { limit: 10 }).map((hit) => hit.messageId),
        query,
      ).toEqual(["both"]);
    }
    expect(transcripts.search([bot], '* : "" { } 🚜', { limit: 10 })).toEqual([]);
    expect(transcripts.search([bot], "fo*", { limit: 10 })).toEqual([]);
  });

  it("rejects invalid limits and offsets that would make SQLite skip the caller's bounds", () => {
    const { transcripts } = open();
    expect(() => transcripts.listPage(bot, { limit: -1 })).toThrow("Invalid transcript limit");
    expect(() => transcripts.listPage(bot, { limit: 1, beforeSeq: 0.5 })).toThrow(
      "Invalid transcript cursor",
    );
    expect(() => transcripts.search([bot], "hay", { limit: -1 })).toThrow(
      "Invalid transcript limit",
    );
    expect(() => transcripts.search([bot], "hay", { limit: 1, offset: -1 })).toThrow(
      "Invalid search offset",
    );
    expect(() => transcripts.recordShadowDiff(bot, -1)).toThrow("Invalid shadow mismatch count");
  });

  it("previews the last visible finished message as plain text, skipping progress, tools and activity", () => {
    const { transcripts } = open();
    expect(transcripts.latestPreview(bot)).toBeUndefined();
    const at = "2026-11-23T12:00:00.000Z";
    transcripts.appendMessages(
      bot,
      [
        message("reply", { text: "**Fences** look good.", createdAt: at }),
        message("running", { interim: true }),
        message("tool", { role: "tool" }),
        message("process", { origin: { kind: "process", visibility: "activity" } }),
        message("empty", { text: " \n\t " }),
      ],
      hermes,
    );
    transcripts.appendMessages(otherBot, [message("private")], hermes);
    expect(transcripts.latestPreview(bot)).toEqual({
      messageId: "reply",
      text: "Fences look good.",
      at,
    });
  });

  it("tracks diffs and authority independently of the latest successful sync", () => {
    const { transcripts } = open();
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    expect(transcripts.syncState(bot)).toBeUndefined();
    transcripts.recordShadowDiff(bot, 0);
    expect(transcripts.syncState(bot)).toBeUndefined();
    transcripts.recordShadowDiff(bot, 2);
    clock.mockReturnValue(200);
    transcripts.appendMessages(bot, [message("first")], hermes);
    transcripts.recordShadowDiff(bot, 1);
    transcripts.markCanonicalLocal(bot);
    clock.mockReturnValue(300);
    transcripts.recordShadowDiff(bot, 0);
    expect(transcripts.appendMessages(bot, [message("next")], "codex")).toEqual({
      botId: bot,
      sourceRuntime: "codex",
      canonicalSource: "local",
      lastSyncedAt: 300,
      lastMessageId: "next",
      messageCount: 2,
      shadowMismatchCount: 3,
      lastMismatchAt: 200,
    });
    transcripts.markCanonicalLocal(otherBot);
    expect(transcripts.syncState(otherBot)).toMatchObject({
      canonicalSource: "local",
      messageCount: 0,
      lastSyncedAt: null,
    });
  });

  it("forgets a bot's rows, index and authority before reusing its ID", () => {
    const store = open();
    const { transcripts } = store;
    transcripts.appendMessages(bot, [message("same", { text: "forgotten" })], hermes);
    transcripts.appendMessages(otherBot, [message("same", { text: "retained" })], hermes);
    transcripts.markCanonicalLocal(bot);
    store.forgetBot(bot);
    expect(transcripts.syncState(bot)).toBeUndefined();
    expect(transcripts.listPage(bot, { limit: 10 }).messages).toEqual([]);
    expect(transcripts.search([bot, otherBot], "forgotten", { limit: 10 })).toEqual([]);
    expect(transcripts.search([bot, otherBot], "retained", { limit: 10 })[0]?.botId).toBe(otherBot);
    expect(transcripts.appendMessages(bot, [message("same")], hermes)).toMatchObject({
      canonicalSource: "hermes",
      messageCount: 1,
    });
    checkIndex(store);
  });

  it("keeps the previous schema version and reads both new and rollback writes after reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "wildbots-transcripts-"));
    directories.push(directory);
    const path = join(directory, "app.sqlite");
    const previous = JSON.parse(
      readFileSync(new URL("./fixtures/previous-release-schema.json", import.meta.url), "utf8"),
    ) as { schemaVersion: number; objects: { sql: string }[] };
    using legacy = new DatabaseSync(path);
    for (const { sql } of previous.objects.filter(({ sql }) => !sql.startsWith("CREATE INDEX")))
      legacy.exec(sql);
    for (const { sql } of previous.objects.filter(({ sql }) => sql.startsWith("CREATE INDEX")))
      legacy.exec(sql);
    legacy.exec(`PRAGMA user_version=${previous.schemaVersion}`);
    legacy
      .prepare("INSERT INTO users VALUES(?,?,?,?)")
      .run("member", "member@example.test", "Member", null);
    const upgraded = open(path);
    upgraded.transcripts.appendMessages(bot, [message("stored")], hermes);
    upgraded.close();
    stores.pop();
    expect(schemaVersion).toBe(previous.schemaVersion);
    expect(legacy.prepare("PRAGMA user_version").get()?.user_version).toBe(previous.schemaVersion);
    legacy
      .prepare("INSERT INTO drafts VALUES(?,?,?)")
      .run("member", bot, '{"text":"Rollback draft","attachments":[]}');
    const reopened = open(path);
    expect(reopened.draft("member", bot)?.text).toBe("Rollback draft");
    expect(reopened.transcripts.search([bot], "stored", { limit: 10 })[0]?.messageId).toBe(
      "stored",
    );
  });
});
