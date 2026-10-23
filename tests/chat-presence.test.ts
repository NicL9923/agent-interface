import { expect, it } from "vitest";
import { loadConfig, type Config } from "../src/server/config.js";
import { BackgroundWorker } from "../src/server/notifications.js";
import { presenceTtl, Store } from "../src/server/store.js";
import type { RuntimeEvent } from "../src/shared/types.js";
import { fakeRuntime } from "./helpers/server.js";

const runtime = fakeRuntime({ capabilities: async () => ({ idempotency: { supported: false }, durableEvents: { supported: false } }) });
const apns = (): NonNullable<Config["apns"]> => ({ teamId: "TEAM123456", keyId: "KEY1234567", topic: "test.agentinterface", privateKeyFile: "unused", environment: "sandbox" });
const reply = (id: string, extra: Partial<RuntimeEvent> = {}): RuntimeEvent =>
  ({ id, botId: "shared", runId: "run", kind: "completed", title: "Done", occurredAt: new Date().toISOString(), ...extra });

/** Person "one" follows a run with a browser subscription and an iPhone; "two" is in the household too. */
function household() {
  const store = new Store(":memory:");
  const config = loadConfig({ HOUSEHOLD_EMAILS: "one@example.test,two@example.test" });
  config.apns = apns();
  for (const id of ["one", "two"]) store.user({ id, name: id, email: `${id}@example.test` });
  store.participate("run", "one");
  store.subscribe("one", { endpoint: "https://push.test/one", keys: { p256dh: "key", auth: "auth" } });
  store.nativeSession("phone-session", "one", Date.now() + 100000);
  store.registerNativeDevice("one", "phone-session", "phone", "ab".repeat(32), "sandbox");
  const web: string[] = [], native: string[] = [], clears: { device: string; tags: string[] }[] = [];
  const failing = new Set<string>();
  const worker = new BackgroundWorker(store, runtime, config,
    async subscription => { web.push(subscription.endpoint); if (failing.has(subscription.endpoint)) throw new Error("Temporary outage"); },
    async device => { native.push(device.deviceId); },
    undefined, undefined,
    async (device, tags) => { clears.push({ device: device.deviceId, tags }); });
  return { store, worker, web, native, clears, failing };
}

it("sends nothing anywhere while the person is reading that chat on any device", async () => {
  const { store, worker, web, native } = household();
  try {
    store.chatPresence("one", "shared", "desk-tab", "active");
    store.recordEvents([reply("seen")], "cursor");
    await worker.tick();
    expect([web, native]).toEqual([[], []]);
    expect(store.outbox()).toHaveLength(0);
    // Another chat and a routine result still notify while this one is open.
    store.routineRecipients("routine", ["one"]);
    store.recordEvents([reply("other-chat", { botId: "elsewhere" }), reply("routine", { routineId: "routine" })], "cursor");
    await worker.tick();
    expect(web).toHaveLength(2);
    // So does a reply after the heartbeats stop.
    store.db.exec(`UPDATE chat_presence SET updated_at=${Date.now() - presenceTtl - 1}; UPDATE chat_reads SET read_at=0`);
    store.recordEvents([reply("after-leaving")], "cursor");
    await worker.tick();
    expect(web).toHaveLength(3);
    expect(native).toHaveLength(3);
  } finally { await worker.stop(); store.close(); }
});

it("counts leaving after reading as read, but not walking away from an open chat or reading before the reply", async () => {
  const { store, worker, web } = household();
  try {
    store.chatPresence("one", "shared", "desk-tab", "left", Date.now() - 1000);
    store.recordEvents([reply("after-reading")], "cursor");
    await worker.tick();
    expect(web).toHaveLength(1);
    store.chatPresence("one", "shared", "desk-tab", "active", Date.now() - 60000);
    store.chatPresence("one", "shared", "desk-tab", "idle");
    // Idle at this moment would have marked the chat read had it counted.
    store.recordEvents([reply("while-idle", { occurredAt: new Date(Date.now() - 500).toISOString() })], "cursor");
    await worker.tick();
    expect(web).toHaveLength(2);
    // Hermes stamped this reply before the person left, though discovery found it only after an outage.
    store.chatPresence("one", "shared", "phone", "left", Date.now() - 60000);
    store.recordEvents([reply("before-leaving", { occurredAt: new Date(Date.now() - 120000).toISOString() })], "cursor");
    await worker.tick();
    expect(web).toHaveLength(2);
    // A Hermes clock running ahead cannot make a later reply look read.
    store.recordEvents([reply("from-the-future", { occurredAt: new Date(Date.now() + 120000).toISOString() })], "cursor");
    await worker.tick();
    expect(web).toHaveLength(3);
  } finally { await worker.stop(); store.close(); }
});

it("stops retrying other devices once the chat is read on one", async () => {
  const { store, worker, web, native, failing } = household();
  try {
    failing.add("https://push.test/one");
    store.recordEvents([reply("retry")], "cursor");
    await worker.tick();
    expect([web.length, native.length]).toEqual([1, 1]);
    store.chatPresence("one", "shared", "phone", "left");
    store.db.prepare("UPDATE outbox SET next_attempt=0").run();
    await worker.tick();
    expect(web).toHaveLength(1);
    expect(store.outbox()).toHaveLength(0);
  } finally { await worker.stop(); store.close(); }
});

it("clears iPhone notifications once read elsewhere, once, and never back to the device that read them", async () => {
  const { store, worker, clears } = household();
  try {
    store.nativeSession("pad-session", "one", Date.now() + 100000);
    store.registerNativeDevice("one", "pad-session", "pad", "cd".repeat(32), "sandbox");
    store.recordEvents([reply("first")], "cursor");
    await worker.tick();
    expect(clears).toEqual([]);
    store.chatPresence("one", "shared", "desk-tab", "left");
    await worker.tick();
    expect(clears).toEqual([{ device: "phone", tags: ["first"] }, { device: "pad", tags: ["first"] }]);
    store.chatPresence("one", "shared", "desk-tab", "active");
    await worker.tick();
    expect(clears).toHaveLength(2);
    // Read on the phone itself: only the iPad needs telling.
    store.db.exec("DELETE FROM chat_presence; UPDATE chat_reads SET read_at=0");
    store.recordEvents([reply("second")], "cursor");
    await worker.tick();
    store.chatPresence("one", "shared", "phone", "left");
    await worker.tick();
    // A clear names notifications, so one arriving late never removes a newer unread one.
    expect(clears.slice(2)).toEqual([{ device: "pad", tags: ["second"] }]);
  } finally { await worker.stop(); store.close(); }
});

it("forgets presence and reads with a deleted assistant", () => {
  const store = new Store(":memory:");
  store.user({ id: "one", name: "one", email: "one@example.test" });
  store.chatPresence("one", "shared", "tab", "active");
  store.forgetBot("shared");
  expect(store.db.prepare("SELECT count(*) AS n FROM chat_presence UNION ALL SELECT count(*) FROM chat_reads").all()).toEqual([{ n: 0 }, { n: 0 }]);
  store.close();
});
