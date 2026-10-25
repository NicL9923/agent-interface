import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { badgeFor } from "../src/server/badge.js";
import { loadConfig } from "../src/server/config.js";
import { approvalPassBudget, BackgroundWorker } from "../src/server/notifications.js";
import { Store } from "../src/server/store.js";
import { unresolvedApprovals } from "../src/server/store-notifications.js";
import { badgeCount, isUnread } from "../src/shared/unread.js";
import { defaultPreferences, type Bot } from "../src/shared/types.js";
import { approvalFixture, botFixture, capabilitiesFixture, conversationFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime, localLogin } from "./helpers/server.js";

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60000).toISOString();
function people() {
  const store = new Store(":memory:");
  for (const id of ["one", "two"]) store.user({ id, name: id, email: `${id}@example.test` });
  return store;
}

it("counts unread chats and decisions once each, only among assistants the person sees", () => {
  const store = people();
  store.savePresentation("secret", { shared: false, ownerId: "two" });
  const bots: Bot[] = [
    botFixture({ id: "fresh", lastMessage: { text: "New", at: at(1) } }),
    botFixture({ id: "both", activity: "waiting", lastMessage: { text: "Approve?", at: at(1) } }),
    botFixture({ id: "question", activity: "blocked" }),
    botFixture({ id: "read", lastMessage: { text: "Old", at: at(30) } }),
    botFixture({ id: "never", lastMessage: { text: "Hello", at: at(1) } }),
    botFixture({ id: "secret", activity: "waiting", lastMessage: { text: "Private", at: at(1) } }),
  ];
  for (const botId of ["fresh", "both", "read", "secret"]) store.chatPresence("one", botId, "tab", "left", Date.now() - 10 * 60000);
  expect(badgeFor(bots, store, "one")).toBe(3);
  // Someone else's private assistant counts for its owner.
  expect(badgeFor(bots, store, "two")).toBe(3);
  // News arriving now: an approval waits on a decision; a reply counts in a chat opened before.
  expect(badgeFor(bots, store, "one", [{ botId: "read", kind: "completed" }, { botId: "never", kind: "completed" }])).toBe(4);
  expect(badgeFor(bots, store, "one", [{ botId: "never", kind: "approval" }])).toBe(4);
  expect(badgeFor(bots, store, "one", [{ botId: "secret", kind: "approval" }])).toBe(3);
  // Without a connected roster the badge is unknown, not zero.
  expect(badgeFor(undefined, store, "one")).toBeUndefined();
  expect(badgeFor(bots.map(bot => ({ ...bot, activity: "disconnected" as const })), store, "one")).toBeUndefined();
  store.close();
});

it("lets clients count with the same rule they mark home with", () => {
  const bots = [botFixture({ id: "a", unread: true, lastMessage: { text: "x", at: at(1) } }), botFixture({ id: "b", activity: "waiting" }), botFixture({ id: "c", unread: true, lastMessage: { text: "x", at: at(1) } })];
  // The chat on screen is read; a waiting assistant still counts.
  expect(badgeCount(bots, botId => isUnread(bots.find(bot => bot.id === botId)!, "a", {}))).toBe(2);
  expect(badgeCount(bots, botId => isUnread(bots.find(bot => bot.id === botId)!, "b", {}))).toBe(3);
});

it("sends the badge with every push and with the read-elsewhere clear", async () => {
  const store = people();
  const config = loadConfig({ HOUSEHOLD_EMAILS: "one@example.test,two@example.test" });
  config.apns = { teamId: "TEAM123456", keyId: "KEY1234567", topic: "test.agentinterface", privateKeyFile: "unused", environment: "sandbox" };
  store.participate("run", "one");
  store.subscribe("one", { endpoint: "https://push.test/one", keys: { p256dh: "key", auth: "auth" } });
  store.nativeSession("phone-session", "one", Date.now() + 100000);
  store.registerNativeDevice("one", "phone-session", "phone", "ab".repeat(32), "sandbox");
  // Opened before; Hermes's roster has not caught up with the new reply yet.
  store.chatPresence("one", "shared", "desk", "left", Date.now() - 10 * 60000);
  const bots = [botFixture({ lastMessage: { text: "Old", at: at(20) } }), botFixture({ id: "barn", activity: "waiting" })];
  const web: string[] = [], native: string[] = [], clears: (number | undefined)[] = [];
  const runtime = fakeRuntime({ listBots: async () => bots, capabilities: async () => capabilitiesFixture() });
  const worker = new BackgroundWorker(store, runtime, config, async (_, payload) => { web.push(payload); }, async (_, payload) => { native.push(payload); },
    undefined, undefined, async (_, __, badge) => { clears.push(badge); });
  try {
    store.recordEvents([{ id: "reply", botId: "shared", runId: "run", kind: "completed", title: "Done", occurredAt: new Date().toISOString() }], "cursor");
    await worker.tick();
    expect(JSON.parse(web[0])).toMatchObject({ tag: "reply", badge: 2 });
    expect(JSON.parse(native[0])).toMatchObject({ tag: "reply", badge: 2 });
    store.chatPresence("one", "shared", "desk", "left");
    await worker.tick();
    expect(clears).toEqual([1]);
  } finally { await worker.stop(); store.close(); }
});

it("counts every known unresolved approval in alerts and clears, until it is decided or the assistant moves on", async () => {
  const store = people();
  const config = loadConfig({ HOUSEHOLD_EMAILS: "one@example.test,two@example.test" });
  config.apns = { teamId: "TEAM123456", keyId: "KEY1234567", topic: "test.agentinterface", privateKeyFile: "unused", environment: "sandbox" };
  store.subscribe("one", { endpoint: "https://push.test/one", keys: { p256dh: "key", auth: "auth" } });
  store.nativeSession("phone-session", "one", Date.now() + 100000);
  store.registerNativeDevice("one", "phone-session", "phone", "ab".repeat(32), "sandbox");
  store.savePreferences("one", { ...defaultPreferences, followBots: ["barn", "gate", "kitchen"] });
  // Unopened sessions: Hermes's roster shows every assistant idle.
  const bots = [botFixture({ id: "barn" }), botFixture({ id: "gate" }), botFixture({ id: "kitchen", lastMessage: { text: "Old", at: at(20) } })];
  const web: string[] = [], clears: (number | undefined)[] = [];
  const listBots = vi.fn(async () => bots);
  const runtime = fakeRuntime({ listBots, capabilities: async () => capabilitiesFixture() });
  const worker = new BackgroundWorker(store, runtime, config, async (_, payload) => { web.push(payload); }, async () => {},
    undefined, undefined, async (_, __, badge) => { clears.push(badge); });
  const event = (id: string, botId: string, kind: "approval" | "completed", extra: object = {}) =>
    ({ id, botId, kind, title: kind, occurredAt: new Date().toISOString(), ...extra });
  const badges = () => web.map(payload => JSON.parse(payload)).map(payload => [payload.tag, payload.badge]);
  try {
    store.recordEvents([event("ask-barn", "barn", "approval", { approvalId: "a1" }), event("ask-gate", "gate", "approval", { approvalId: "a2", runId: "gate-run" })], "1");
    await worker.tick();
    // Each lone approval knows about the other, and a second approval from the same assistant counts it once.
    expect(badges()).toEqual([["ask-barn", 2], ["ask-gate", 2]]);
    // One roster read serves the whole delivery pass.
    expect(listBots).toHaveBeenCalledTimes(1);
    store.recordEvents([event("ask-barn-2", "barn", "approval", { approvalId: "a3" })], "2");
    await worker.tick();
    expect(badges().at(-1)).toEqual(["ask-barn-2", 2]);
    // Decided through the app, one of barn's approvals no longer counts, but its other one does.
    store.attributeApproval("a1", "barn", "two", "approved");
    store.chatPresence("one", "kitchen", "desk", "left", Date.now() - 10 * 60000);
    store.recordEvents([event("reply", "kitchen", "completed")], "3");
    await worker.tick();
    expect(badges().at(-1)).toEqual(["reply", 3]);
    // The gate's run finished, so its approval was resolved elsewhere; the read-elsewhere clear counts the same way.
    store.recordEvents([event("gate-done", "gate", "completed", { runId: "gate-run" })], "4");
    store.chatPresence("one", "kitchen", "phone-other", "left");
    await worker.tick();
    expect(clears.at(-1)).toBe(1);
    store.attributeApproval("a3", "barn", "one", "denied");
    expect(badgeFor(bots, store, "one")).toBe(0);
  } finally { await worker.stop(); store.close(); }
});

// Raised in the assistant's live chat session unless another is named.
const approvalEvent = (id: string, botId: string, approvalId: string, runId?: string, sessionId = "live") =>
  ({ id, botId, sessionId, kind: "approval" as const, approvalId, ...(runId ? { runId } : {}), title: "Approval requested", occurredAt: new Date().toISOString() });
// Records events as discovered this many minutes ago.
function recordedAgo(store: Store, minutes: number, events: Parameters<Store["recordEvents"]>[0]) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - minutes * 60000);
  try { store.recordEvents(events, randomUUID()); } finally { clock.mockRestore(); }
}
const storeDb = (store: Store) => (store as unknown as { database: { db: import("node:sqlite").DatabaseSync } }).database.db;

it("settles an approval only by its own run, never by another run on the same assistant", () => {
  const store = people();
  store.participate("interactive", "one");
  store.savePreferences("one", { ...defaultPreferences, followBots: ["barn"] });
  const bots = [botFixture({ id: "barn" })];
  const event = (id: string, kind: "completed" | "failed", runId: string, extra: object = {}) =>
    ({ id, botId: "barn", runId, kind, title: kind, occurredAt: new Date().toISOString(), ...extra });
  try {
    store.recordEvents([approvalEvent("ask", "barn", "a1", "interactive")], "1");
    expect(badgeFor(bots, store, "one")).toBe(1);
    // A routine on the same assistant finishing says nothing about this approval.
    store.recordEvents([event("routine-done", "completed", "routine:weekly", { routineId: "weekly" })], "2");
    expect(badgeFor(bots, store, "one")).toBe(1);
    store.recordEvents([event("ask-done", "failed", "interactive")], "3");
    expect(badgeFor(bots, store, "one")).toBe(0);
    // An approval with no recorded run waits for a decision, whatever else finishes.
    store.recordEvents([approvalEvent("unknown-run", "barn", "a2")], "4");
    store.recordEvents([event("later", "completed", "other")], "5");
    expect(badgeFor(bots, store, "one")).toBe(1);
    store.attributeApproval("a2", "barn", "one", "denied");
    expect(badgeFor(bots, store, "one")).toBe(0);
  } finally { store.close(); }
});

it("settles approvals by run outcomes a rolled-back release recorded", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-store-"));
  const path = join(directory, "app.db");
  let store = new Store(path);
  try {
    store.user({ id: "one", name: "one", email: "one@example.test" });
    store.savePreferences("one", { ...defaultPreferences, followBots: ["barn"] });
    store.recordEvents([approvalEvent("ask", "barn", "a1", "run"), { id: "done", botId: "barn", runId: "run", kind: "completed", title: "Done", occurredAt: new Date().toISOString() }], "1");
    // The previous release records events but not the settlements beside them.
    storeDb(store).exec("DELETE FROM run_settlements");
    expect(store.pendingDecisions("one").size).toBe(1);
    store.close();
    store = new Store(path);
    expect(store.pendingDecisions("one").size).toBe(0);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("drops approvals Hermes no longer holds open when the app reads the conversation, crediting nobody", async () => {
  const approvals = [approvalFixture({ id: "open" })];
  const conversation = vi.fn(async (botId: string) => conversationFixture({ botId, approvals, requestSessionId: "live" }));
  const runtime = fakeRuntime({ listBots: async () => [botFixture({ id: "barn" })], capabilities: async () => capabilitiesFixture(), conversation, close: async () => {} });
  const { app, store } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), runtime, { background: false });
  try {
    const headers = await localLogin(app, "http://127.0.0.1:3000");
    store.savePreferences("local-one", { ...defaultPreferences, followBots: ["barn"] });
    // Answered in Hermes's own UI, still open, and one asked for just as the read began.
    recordedAgo(store, 5, [approvalEvent("ask-1", "barn", "answered-elsewhere", "run-1"), approvalEvent("ask-2", "barn", "open", "run-2")]);
    recordedAgo(store, 0, [approvalEvent("ask-3", "barn", "just-asked", "run-3")]);
    const resolved = () => (storeDb(store).prepare("SELECT approval_id FROM approval_resolutions ORDER BY approval_id").all() as { approval_id: string }[]).map(row => row.approval_id);
    expect((await app.inject({ url: "/api/bots/barn/conversation?turns=20", headers })).statusCode).toBe(200);
    expect(resolved()).toEqual(["answered-elsewhere"]);
    expect(store.pendingDecisions("local-one")).toEqual(new Set(["barn"]));
    // Answered now too; "just-asked" may postdate a shared read, so it counts until a later read.
    approvals.length = 0;
    await app.inject({ url: "/api/bots/barn/conversation?turns=20", headers });
    expect(resolved()).toEqual(["answered-elsewhere", "open"]);
    expect(store.pendingDecisions("local-one")).toEqual(new Set(["barn"]));
    for (const id of ["answered-elsewhere", "open", "just-asked"]) expect(store.approval(id)).toBeUndefined();
  } finally { await app.close(); }
});

it("settles an approval from another session only by that session's own requests, a decision or its own run, never by the chat's", async () => {
  let read = conversationFixture({ botId: "barn", requestSessionId: "live", approvals: [] });
  const runtime = fakeRuntime({ listBots: async () => [botFixture({ id: "barn" })], capabilities: async () => capabilitiesFixture({ approvals: { supported: true } }),
    conversation: async () => read, approve: async () => {}, close: async () => {} });
  const { app, store } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), runtime, { background: false });
  try {
    const headers = await localLogin(app, "http://127.0.0.1:3000");
    store.savePreferences("local-one", { ...defaultPreferences, followBots: ["barn"] });
    // A routine's session asked twice, and the chat's own session once; Hermes's chat holds none open.
    recordedAgo(store, 5, [approvalEvent("ask-1", "barn", "routine-1", "routine-run", "routine"),
      approvalEvent("ask-2", "barn", "routine-2", "routine-run-2", "routine"), approvalEvent("ask-3", "barn", "chat", "chat-run")]);
    const resolved = () => (storeDb(store).prepare("SELECT approval_id FROM approval_resolutions ORDER BY approval_id").all() as { approval_id: string }[]).map(row => row.approval_id);
    const page = (await app.inject({ url: "/api/bots/barn/conversation?turns=20", headers })).json();
    expect(page).not.toHaveProperty("requestSessionId");
    expect(resolved()).toEqual(["chat"]);
    expect(store.pendingDecisions("local-one")).toEqual(new Set(["barn"]));
    // Deciding through the app reads the chat's requests too, which still say nothing about the routine's.
    expect((await app.inject({ method: "POST", url: "/api/bots/barn/approvals/routine-1", headers, payload: { decision: "approved" } })).statusCode).toBe(409);
    expect(resolved()).toEqual(["chat"]);
    // A read of the routine's own session that lacks one settles it.
    read = conversationFixture({ botId: "barn", requestSessionId: "routine", approvals: [approvalFixture({ id: "routine-2" })] });
    await app.inject({ url: "/api/bots/barn/conversation?turns=20", headers });
    expect(resolved()).toEqual(["chat", "routine-1"]);
    // The other ends with its own run.
    store.recordEvents([{ id: "done", botId: "barn", runId: "routine-run-2", kind: "completed", title: "Done", occurredAt: new Date().toISOString() }], "9");
    expect(store.pendingDecisions("local-one").size).toBe(0);
  } finally { await app.close(); }
});

it("checks a few assistants' counted approvals against Hermes in the background, with fresh reads", async () => {
  const store = people();
  const config = loadConfig({ HOUSEHOLD_EMAILS: "one@example.test,two@example.test" });
  const botIds = Array.from({ length: 7 }, (_, index) => `bot-${index}`);
  store.savePreferences("one", { ...defaultPreferences, followBots: botIds });
  const conversation = vi.fn(async (botId: string, _options?: object) => conversationFixture({ botId, requestSessionId: "live", approvals: botId === "bot-0" ? [approvalFixture({ id: "bot-0" })] : [] }));
  const runtime = fakeRuntime({ listBots: async () => botIds.map(id => botFixture({ id })), conversation,
    capabilities: async () => capabilitiesFixture({ durableEvents: { supported: false } }) });
  const worker = new BackgroundWorker(store, runtime, config);
  recordedAgo(store, 1, botIds.map(botId => approvalEvent(`ask-${botId}`, botId, botId, `run-${botId}`)));
  try {
    await worker.tick();
    expect(conversation).toHaveBeenCalledTimes(5);
    expect(conversation.mock.calls.every(([, options]) => JSON.stringify(options) === JSON.stringify({ history: false }))).toBe(true);
    // The other two wait for a later pass; the one still open keeps counting.
    expect(store.pendingDecisions("one").size).toBe(3);
    await worker.tick();
    expect(conversation).toHaveBeenCalledTimes(5);
  } finally { await worker.stop(); store.close(); }
});

it("keeps discovering events and recovering receipts while an approval read hangs, and gives that pass up after its budget", async () => {
  vi.useFakeTimers();
  const store = people();
  store.savePreferences("one", { ...defaultPreferences, followBots: ["barn"] });
  recordedAgo(store, 2, [approvalEvent("ask", "barn", "a1", "run")]);
  // An admission whose receipt the worker recovers by lookup.
  store.intent({ requestId: "pending", botId: "barn", senderId: "one", text: "Feed", attachments: [] });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const conversation = vi.fn(async (botId: string, _options?: object) => { await held; return conversationFixture({ botId, approvals: [] }); });
  const discoverEvents = vi.fn(async () => ({ events: [], cursor: "1" }));
  const lookupSubmission = vi.fn(async (requestId: string) => ({ requestId, status: "accepted" as const }));
  const runtime = fakeRuntime({ conversation, discoverEvents, lookupSubmission,
    capabilities: async () => capabilitiesFixture({ durableEvents: { supported: true }, idempotency: { supported: true } }) });
  const worker = new BackgroundWorker(store, runtime, loadConfig({}));
  try {
    worker.start();
    await vi.advanceTimersByTimeAsync(15000);
    expect(conversation).toHaveBeenCalledTimes(1);
    expect(discoverEvents.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(lookupSubmission).toHaveBeenCalledWith("pending");
    // The hung read is abandoned once the pass runs out of time, and the next pass reads again.
    await vi.advanceTimersByTimeAsync(approvalPassBudget + 60000);
    expect(conversation).toHaveBeenCalledTimes(2);
    expect(store.pendingDecisions("one")).toEqual(new Set(["barn"]));
  } finally { release(); await worker.stop(); store.close(); vi.useRealTimers(); }
});

it("finds pending decisions through indexes on a realistically sized history", () => {
  const store = people();
  const db = storeDb(store);
  const now = Date.now();
  const event = db.prepare("INSERT INTO notification_events VALUES(?,?,?)");
  const ingest = db.prepare("INSERT INTO notification_ingestion(event_id) VALUES(?)");
  const settle = db.prepare("INSERT INTO run_settlements(bot_id,run_id,ingestion_id) VALUES(?,?,last_insert_rowid())");
  const outbox = db.prepare("INSERT INTO outbox(id,event_id,user_id,payload,created_at,state) VALUES(?,?,?,?,?,'delivered')");
  db.exec("BEGIN");
  // A month of a busy household: 30,000 events, each sent to two people.
  for (let index = 0; index < 30000; index++) {
    const kind = index % 10 === 0 ? "approval" : index % 3 ? "completed" : "activity";
    const id = `event-${index}`, botId = `bot-${index % 12}`, runId = `run-${Math.floor(index / 4)}`, at = now - (30000 - index) * 86400;
    event.run(id, JSON.stringify({ id, botId, runId, kind, title: kind, ...(kind === "approval" ? { approvalId: id } : {}) }), at);
    ingest.run(id);
    if (kind === "completed") settle.run(botId, runId);
    for (const userId of ["one", "two"])
      outbox.run(`${id}:${userId}`, id, userId, JSON.stringify({ kind, botId, ...(kind === "approval" ? { approvalId: id } : {}) }), at);
  }
  db.exec("COMMIT");
  db.exec("ANALYZE");
  try {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT DISTINCT json_extract(asked.value,'$.botId') ${unresolvedApprovals}
      AND EXISTS(SELECT 1 FROM outbox o WHERE o.event_id=asked.id AND o.user_id=?)`).all(now - 86400000, "one") as { detail: string }[]).map(row => row.detail);
    // Only the last day of events is read, and every other step is a keyed lookup: no step reads a whole table.
    expect(plan).toContainEqual(expect.stringMatching(/^SEARCH asked USING INDEX notification_events_created \(created_at>\?\)/));
    expect(plan.filter(detail => /^SCAN /.test(detail))).toEqual([]);
    const started = performance.now();
    expect(store.pendingDecisions("one").size).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(250);
  } finally { store.close(); }
});
