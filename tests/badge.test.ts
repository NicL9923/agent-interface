import { expect, it, vi } from "vitest";
import { badgeFor } from "../src/server/badge.js";
import { loadConfig } from "../src/server/config.js";
import { BackgroundWorker } from "../src/server/notifications.js";
import { Store } from "../src/server/store.js";
import { badgeCount, isUnread } from "../src/shared/unread.js";
import { defaultPreferences, type Bot } from "../src/shared/types.js";
import { botFixture, capabilitiesFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime } from "./helpers/server.js";

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
    store.recordEvents([event("ask-barn", "barn", "approval", { approvalId: "a1" }), event("ask-gate", "gate", "approval", { approvalId: "a2" })], "1");
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
    // The gate finished, so its approval was resolved elsewhere; the read-elsewhere clear counts the same way.
    store.recordEvents([event("gate-done", "gate", "completed")], "4");
    store.chatPresence("one", "kitchen", "phone-other", "left");
    await worker.tick();
    expect(clears.at(-1)).toBe(1);
    store.attributeApproval("a3", "barn", "one", "denied");
    expect(badgeFor(bots, store, "one")).toBe(0);
  } finally { await worker.stop(); store.close(); }
});
