import { expect, it } from "vitest";
import { Store } from "../src/server/store.js";
import { BackgroundWorker } from "../src/server/notifications.js";
import { loadConfig } from "../src/server/config.js";
import type { Runtime, RuntimeEvent } from "../src/shared/types.js";
const event: RuntimeEvent = {
  id: "evt-1",
  botId: "shared",
  runId: "run",
  kind: "completed",
  title: "Work complete",
  occurredAt: "2026-09-29T12:00:00Z",
};
function storeWithUsers() {
  const store = new Store(":memory:");
  for (const id of ["one", "two"])
    store.user({ id, name: id, email: `${id}@example.test` });
  return store;
}
it("persists durable event discovery with participant/routine recipient semantics and deduplicates replay", () => {
  const store = storeWithUsers();
  store.participate("run", "one");
  store.recordEvents([event], "cursor-1");
  store.recordEvents([event], "cursor-1");
  expect(store.cursor()).toBe("cursor-1");
  expect(store.outbox()).toHaveLength(1);
  store.routineRecipients("routine", ["two"]);
  store.recordEvents(
    [{ ...event, id: "routine-event", routineId: "routine" }],
    "cursor-2",
  );
  expect(store.outbox().map((x) => x.user_id)).toEqual(["one", "two"]);
  expect(JSON.parse(store.outbox().find(x => x.user_id === 'two')!.payload).url).toBe('/?bot=shared&routine=routine');
  store.close();
});
it("keeps completion pending without a subscription and retries failed delivery without resending successful endpoints", async () => {
  const store = storeWithUsers();
  store.participate("run", "one");
  store.recordEvents([event], "cursor-1");
  const seen: string[] = [];
  const runtime = {
    capabilities: async () => ({
      idempotency: { supported: false },
      durableEvents: { supported: false },
    }),
  } as unknown as Runtime;
  const worker = new BackgroundWorker(
    store,
    runtime,
    loadConfig({ HOUSEHOLD_EMAILS: "one@example.test,two@example.test" }),
    async (subscription) => {
      seen.push(subscription.endpoint);
      if (
        subscription.endpoint.includes("retry") &&
        seen.filter((x) => x.includes("retry")).length === 1
      )
        throw new Error("Temporary network failure");
    },
  );
  await worker.tick();
  expect(store.outbox()).toHaveLength(1);
  for (const endpoint of [
    "https://push.example.test/ok",
    "https://push.example.test/retry",
  ])
    store.subscribe("one", { endpoint, keys: { p256dh: "key", auth: "auth" } });
  await worker.tick();
  expect(seen).toHaveLength(2);
  store.db.prepare("UPDATE outbox SET next_attempt=0").run();
  await worker.tick();
  expect(seen.filter((x) => x.endsWith("/ok"))).toHaveLength(1);
  expect(seen.filter((x) => x.endsWith("/retry"))).toHaveLength(2);
  expect(store.outbox()).toHaveLength(0);
  store.close();
});
it("recovers admission receipts before event discovery so recovered completions notify their sender", async () => {
  const store = storeWithUsers();
  store.intent({
    requestId: "request",
    botId: "shared",
    senderId: "one",
    text: "Hello",
    attachments: [],
  });
  const runtime = {
    capabilities: async () => ({
      idempotency: { supported: true },
      durableEvents: { supported: true },
    }),
    lookupSubmission: async () => ({
      requestId: "request",
      status: "accepted",
      runId: "run",
    }),
    discoverEvents: async () => ({ cursor: "recovered", events: [event] }),
  } as unknown as Runtime;
  const worker = new BackgroundWorker(
    store,
    runtime,
    loadConfig({ HOUSEHOLD_EMAILS: "one@example.test,two@example.test" }),
  );
  await worker.tick();
  expect(store.submission("request")!.receipt.status).toBe("accepted");
  expect(store.outbox()[0].user_id).toBe("one");
  expect(store.cursor()).toBe("recovered");
  store.close();
});
it("retains a discovered completion until admission attribution arrives, even after its cursor advances", () => {
  const store = storeWithUsers();
  store.recordEvents([event], "advanced");
  expect(store.outbox()).toHaveLength(0);
  store.participate("run", "one");
  store.enqueueKnownEvents();
  expect(store.outbox()[0].user_id).toBe("one");
  expect(store.cursor()).toBe("advanced");
  store.close();
});
it("delivers an existing outbox while Hermes is offline", async () => {
  const store = storeWithUsers();
  store.participate("run", "one");
  store.recordEvents([event], "cursor");
  store.subscribe("one", {
    endpoint: "https://push.example.test/device",
    keys: { p256dh: "key", auth: "auth" },
  });
  const runtime = {
    capabilities: async () => {
      throw new Error("Hermes offline");
    },
  } as unknown as Runtime;
  let deliveries = 0;
  const worker = new BackgroundWorker(
    store,
    runtime,
    loadConfig({ HOUSEHOLD_EMAILS: "one@example.test,two@example.test" }),
    async () => {
      deliveries++;
    },
  );
  await worker.tick();
  expect(deliveries).toBe(1);
  expect(store.outbox()).toHaveLength(0);
  store.close();
});
it("lists explicit routine recipients without adding bot followers", () => {
  const store = storeWithUsers();
  store.routineRecipients("routine", ["one"]);
  store.savePreferences("two", {
    presentation: "simple",
    theme: "system",
    favorites: [],
    sections: [],
    followBots: ["shared"],
  });
  expect(store.getRoutineRecipients("routine")).toEqual(["one"]);
  expect(store.recipients({ ...event, routineId: "routine" })).toEqual([
    "one",
    "two",
  ]);
  store.close();
});
const day = 86400000;
const offline = { capabilities: async () => { throw new Error("Hermes offline"); } } as unknown as Runtime;
const household = () => loadConfig({ HOUSEHOLD_EMAILS: "one@example.test,two@example.test" });
const outboxRow = (store: Store, id: string) =>
  store.db.prepare("SELECT state,attempts,last_error FROM outbox WHERE id=?").get(id) as { state: string; attempts: number; last_error: string | null } | undefined;
function queue(store: Store, id: string, createdAt: number, state = "pending", userId = "one") {
  store.db.prepare("INSERT INTO outbox(id,event_id,user_id,payload,state,created_at) VALUES(?,?,?,?,?,?)")
    .run(id, `event-${id}`, userId, JSON.stringify({ title: id, body: "", url: "/", tag: id }), state, createdAt);
}
it("gives up after 12 attempts and keeps the last delivery error", async () => {
  const store = storeWithUsers();
  store.subscribe("one", { endpoint: "https://push.example.test/down", keys: { p256dh: "key", auth: "auth" } });
  queue(store, "stuck", Date.now());
  const warnings: string[] = [];
  const log = { info() {}, warn: (...args: unknown[]) => { warnings.push(String(args[1])); }, error() {} };
  const worker = new BackgroundWorker(store, offline, household(), async () => {
    throw Object.assign(new Error("Push service unavailable"), { statusCode: 503 });
  }, undefined, log);
  for (let attempt = 1; attempt <= 12; attempt++) {
    store.db.prepare("UPDATE outbox SET next_attempt=0").run();
    await worker.tick();
    expect(outboxRow(store, "stuck")).toMatchObject({ attempts: attempt, state: attempt < 12 ? "pending" : "failed" });
  }
  expect(outboxRow(store, "stuck")!.last_error).toBe("Web Push 503: Push service unavailable");
  expect(warnings.filter(message => message.startsWith("Gave up"))).toHaveLength(1);
  expect(worker.push.lastError).toBe("Web Push 503: Push service unavailable");
  expect(worker.loop.consecutiveFailures).toBe(0);
  store.close();
});
it("expires week-old pending notifications even when partly delivered or never deliverable", async () => {
  const store = storeWithUsers();
  const old = Date.now() - 8 * day;
  queue(store, "partly-delivered", old);
  store.markDelivered("partly-delivered", "https://push.example.test/first");
  queue(store, "no-subscription", old, "pending", "two");
  queue(store, "recent", Date.now() - 6 * day);
  queue(store, "unknown-age", 0);
  queue(store, "already-delivered", old, "delivered");
  await new BackgroundWorker(store, offline, household(), async () => { throw new Error("not reached"); }).tick();
  expect(Object.fromEntries(["partly-delivered", "no-subscription", "recent", "unknown-age", "already-delivered"]
    .map(id => [id, outboxRow(store, id)!.state]))).toEqual({
    "partly-delivered": "expired", "no-subscription": "expired", recent: "pending", "unknown-age": "pending", "already-delivered": "delivered",
  });
  store.close();
});
it("re-sweeps only events from the last day for new recipients", () => {
  const store = storeWithUsers();
  store.recordEvents([{ ...event, id: "old" }, { ...event, id: "recent" }], "cursor");
  store.db.prepare("UPDATE notification_events SET created_at=? WHERE id='old'").run(Date.now() - 2 * day);
  store.savePreferences("two", { presentation: "simple", theme: "system", favorites: [], sections: [], followBots: ["shared"] });
  store.enqueueKnownEvents();
  expect(store.db.prepare("SELECT event_id FROM outbox WHERE user_id='two'").all()).toEqual([{ event_id: "recent" }]);
  store.close();
});
it("prunes expired sessions and month-old settled notifications without breaking a pending batch", () => {
  const store = storeWithUsers();
  const old = Date.now() - 31 * day;
  store.session("expired", "one", "csrf", Date.now() - 1);
  store.db.prepare("INSERT INTO session_confirmations VALUES('expired',?)").run(Date.now() - day);
  store.session("current", "one", "csrf", Date.now() + day);
  queue(store, "old-in-shared-batch", old, "delivered");
  queue(store, "waiting-in-shared-batch", Date.now());
  queue(store, "old-alone", old, "expired");
  queue(store, "old-event-still-known", old, "delivered");
  queue(store, "old-pending", old);
  store.db.prepare("INSERT INTO notification_events VALUES('event-old-event-still-known','{}',?)").run(Date.now());
  for (const id of ["old-in-shared-batch", "old-alone", "old-event-still-known"]) store.markDelivered(id, "https://push.example.test/device");
  const batch = (id: string, ...items: string[]) => {
    store.db.prepare("INSERT INTO notification_batches VALUES(?,?,?)").run(id, "one", JSON.stringify({ title: id, body: "", url: "/?view=today", tag: id }));
    for (const item of items) store.db.prepare("INSERT INTO notification_batch_items VALUES(?,?)").run(item, id);
  };
  batch("shared", "old-in-shared-batch", "waiting-in-shared-batch");
  batch("emptied", "old-alone");
  expect(store.pruneRetention()).toEqual({ sessions: 1, notifications: 2 });
  const ids = (sql: string) => (store.db.prepare(sql).all() as { id: string }[]).map(row => row.id).sort();
  expect(ids("SELECT id FROM outbox")).toEqual(["old-event-still-known", "old-pending", "waiting-in-shared-batch"]);
  expect(ids("SELECT outbox_id AS id FROM delivered")).toEqual(["old-event-still-known"]);
  expect(ids("SELECT id FROM notification_batches")).toEqual(["shared"]);
  expect(ids("SELECT hash AS id FROM sessions")).toEqual(["current"]);
  expect(store.db.prepare("SELECT count(*) AS count FROM session_confirmations").get()).toEqual({ count: 0 });
  const groups = store.deliveryGroups();
  expect(groups.find(group => group.id === "shared")!.items.map(row => row.id)).toEqual(["waiting-in-shared-batch"]);
  store.close();
});
