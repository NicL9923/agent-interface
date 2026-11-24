import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, schemaVersion } from "../src/server/store.js";
import type { TranscriptMessageInput } from "../src/server/store-transcripts.js";
import {
  backfillBotTranscript,
  compareShadowPage,
  persistedHermesMessages,
} from "../src/server/transcript-sync.js";
import type { Conversation, Message, Runtime } from "../src/shared/types.js";
import { conversationFixture } from "./helpers/runtime-fixtures.js";

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

function pendingConversation() {
  let resolve!: (value: Conversation) => void;
  const promise = new Promise<Conversation>((done) => (resolve = done));
  return { promise, resolve };
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

describe("Hermes transcript shadow", () => {
  it("backfills a complete raw history, dropping the live request session's synthetic reply", async () => {
    const store = open();
    const history = [
      message("stored-inflight", { role: "user" }),
      message("progress", { interim: true }),
      message("saved"),
      message("live-inflight"),
    ];
    const conversation = vi.fn<Runtime["conversation"]>(async () =>
      conversationFixture({
        botId: bot,
        sessionId: "stored",
        requestSessionId: "live",
        messages: history,
      }),
    );
    expect(await backfillBotTranscript(store, { conversation }, bot)).toMatchObject({
      sourceRuntime: hermes,
      canonicalSource: "hermes",
      messageCount: 3,
      lastMessageId: "saved",
    });
    expect(conversation).toHaveBeenCalledExactlyOnceWith(bot);
    const rows = store.transcripts.listPage(bot, { limit: 10 }).messages;
    expect(ids(rows)).toEqual(["stored-inflight", "progress", "saved"]);
    expect(compareShadowPage(rows, persistedHermesMessages(await conversation(bot))).matches).toBe(
      true,
    );
    expect(ids(persistedHermesMessages({ sessionId: "live", messages: history }))).toEqual(
      ids(rows),
    );
    expect(ids(persistedHermesMessages({ messages: history }))).toEqual(ids(history));
  });

  it("rejects partial, disconnected, mismatched, and failed reads before replacing the shadow", async () => {
    const store = open();
    const previous = store.transcripts.appendMessages(bot, [message("keep")], hermes);
    const cases: [Partial<Conversation>, string][] = [
      [{ window: { earlier: 3, context: [] } }, "from a partial window"],
      [{ activity: { state: "disconnected" } }, "while Hermes is disconnected"],
      [{ botId: otherBot }, "from another bot"],
    ];
    for (const [changes, reason] of cases) {
      const conversation = async () => conversationFixture({ botId: bot, ...changes });
      await expect(backfillBotTranscript(store, { conversation }, bot)).rejects.toThrow(reason);
    }
    await expect(
      backfillBotTranscript(
        store,
        {
          conversation: async () => {
            throw new Error("Transport closed");
          },
        },
        bot,
      ),
    ).rejects.toThrow("Transport closed");
    expect(store.transcripts.syncState(bot)).toEqual(previous);
    expect(ids(store.transcripts.listPage(bot, { limit: 10 }).messages)).toEqual(["keep"]);
    await expect(
      backfillBotTranscript(
        store,
        {
          conversation: async () => conversationFixture({ botId: bot }),
        },
        bot,
      ),
    ).resolves.toMatchObject({ messageCount: 0, lastMessageId: null });
  });

  it("shares concurrent backfills and discards a snapshot overtaken by a write", async () => {
    const store = open();
    const response = pendingConversation();
    const conversation = vi.fn<Runtime["conversation"]>(() => response.promise);
    const first = backfillBotTranscript(store, { conversation }, bot);
    const second = backfillBotTranscript(store, { conversation }, bot);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(conversation).toHaveBeenCalledExactlyOnceWith(bot);
    const latest = store.transcripts.appendMessages(bot, [message("latest")], hermes);
    response.resolve(conversationFixture({ botId: bot, messages: [message("older")] }));
    await expect(first).resolves.toEqual(latest);
    expect(ids(store.transcripts.listPage(bot, { limit: 10 }).messages)).toEqual(["latest"]);
  });

  it("does not publish a pending Hermes read after bot deletion or local cutover", async () => {
    const store = open();
    const response = pendingConversation();
    const conversation = vi.fn<Runtime["conversation"]>((botId) =>
      response.promise.then((result) => ({ ...result, botId })),
    );
    const deleted = backfillBotTranscript(store, { conversation }, bot);
    const switched = backfillBotTranscript(store, { conversation }, otherBot);
    await Promise.resolve();
    store.forgetBot(bot);
    store.transcripts.markCanonicalLocal(otherBot);
    response.resolve(conversationFixture({ messages: [message("old")] }));
    await expect(deleted).resolves.toBeUndefined();
    await expect(switched).resolves.toMatchObject({ canonicalSource: "local", messageCount: 0 });
    await expect(
      backfillBotTranscript(
        store,
        {
          conversation: async () => {
            throw new Error("Local history must not call Hermes");
          },
        },
        otherBot,
      ),
    ).resolves.toMatchObject({ canonicalSource: "local" });
    expect(store.transcripts.listPage(bot, { limit: 10 }).messages).toEqual([]);
    expect(store.transcripts.listPage(otherBot, { limit: 10 }).messages).toEqual([]);
  });

  it("distinguishes omitted, extra, moved and changed rows without counting a shifted page twice", () => {
    const msg = message("one", {
      files: [{ id: "file", name: "notes", mime: "text/plain", size: undefined }],
      origin: { visibility: "conversation", kind: "human" },
    });
    const two = message("two"),
      three = message("three");
    const equivalent = message("one", {
      files: [{ mime: "text/plain", name: "notes", id: "file" }],
      origin: { kind: "human", visibility: "conversation" },
    });
    const local = [{ ...msg, seq: 42, sourceRuntime: hermes, updatedAt: 123 }, two, three];
    expect(compareShadowPage(local, [equivalent, two, three])).toMatchObject({
      matches: true,
      diffCount: 0,
    });
    expect(compareShadowPage([two, three], [msg, two, three])).toEqual({
      matches: false,
      diffCount: 1,
      missingFromLocal: ["one"],
      extraInLocal: [],
      mutated: [],
      reordered: [],
      duplicateIds: [],
    });
    expect(
      compareShadowPage(
        [three, msg, message("extra")],
        [msg, two, { ...three, reasoning: "different" }],
      ),
    ).toEqual({
      matches: false,
      diffCount: 4,
      missingFromLocal: ["two"],
      extraInLocal: ["extra"],
      mutated: ["three"],
      reordered: ["three", "one"],
      duplicateIds: [],
    });
    expect(compareShadowPage([msg, two], [msg, two, two])).toMatchObject({
      matches: false,
      diffCount: 1,
      duplicateIds: ["two"],
    });
  });
});
