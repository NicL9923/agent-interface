import { createApp } from "../src/server/app.js";
import { capabilitiesFixture } from "./helpers/runtime-fixtures.js";
import { expect, it, vi } from "vitest";
import { Store } from "../src/server/store.js";
import { BackgroundWorker } from "../src/server/notifications.js";
import { loadConfig } from "../src/server/config.js";
import * as apns from "../src/server/apns.js";
import type { RuntimeEvent } from "../src/shared/types.js";
import { fakeRuntime } from "./helpers/server.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
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
it("names the assistant and quotes the reply in queued notifications", () => {
  const store = storeWithUsers();
  store.participate("run", "one");
  store.botNames = new Map([["shared", "Nic's Chief"]]);
  store.recordEvents([{ ...event, title: "Hermes completed", body: "Tailscale is up on the NAS." }], "cursor-1");
  expect(JSON.parse(store.outbox()[0].payload)).toMatchObject({ title: "Nic's Chief", body: "Tailscale is up on the NAS." });
  store.close();
});
it("keeps completion pending without a subscription and retries failed delivery without resending successful endpoints", async () => {
  const store = storeWithUsers();
  store.participate("run", "one");
  store.recordEvents([event], "cursor-1");
  const seen: string[] = [];
  const runtime = fakeRuntime({
    capabilities: async () => capabilitiesFixture({
      idempotency: { supported: false },
      durableEvents: { supported: false },
    }),
  });
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
  const runtime = fakeRuntime({
    capabilities: async () => capabilitiesFixture({
      idempotency: { supported: true },
      durableEvents: { supported: true },
    }),
    lookupSubmission: async () => ({
      requestId: "request",
      status: "accepted",
      runId: "run",
    }),
    discoverEvents: async () => ({ cursor: "recovered", events: [event] }),
  });
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
  const runtime = fakeRuntime({
    capabilities: async () => {
      throw new Error("Hermes offline");
    },
  });
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
it("delivers durable alerts while receipt recovery waits, then delivers recovered completions to their sender", async () => {
  const store = storeWithUsers();
  store.participate("previous-run", "two");
  store.recordEvents([{ ...event, id: "previous", runId: "previous-run" }], "previous-cursor");
  store.intent({ requestId: "request", botId: "shared", senderId: "one", text: "Hello", attachments: [] });
  for (const user of ["one", "two"]) store.subscribe(user, {
    endpoint: `https://push.example.test/${user}`, keys: { p256dh: "key", auth: "auth" },
  });
  const entered = deferred(), release = deferred();
  const discoverEvents = vi.fn(async () => ({ cursor: "recovered", events: [event] }));
  const submit = vi.fn();
  const runtime = fakeRuntime({
    capabilities: async () => capabilitiesFixture({ idempotency: { supported: true }, durableEvents: { supported: true } }),
    lookupSubmission: async () => {
      entered.resolve();
      await release.promise;
      return { requestId: "request", status: "accepted" as const, runId: "run" };
    },
    discoverEvents, submit,
  });
  const sent: string[] = [];
  const worker = new BackgroundWorker(store, runtime, household(), async subscription => { sent.push(subscription.endpoint); });
  const tick = worker.tick();
  try {
    await entered.promise;
    expect([...sent]).toEqual(["https://push.example.test/two"]);
    expect(discoverEvents).not.toHaveBeenCalled();
    expect(store.cursor()).toBe("previous-cursor");
  } finally {
    release.resolve();
    await tick;
    await worker.stop();
  }
  expect(sent).toEqual(["https://push.example.test/two", "https://push.example.test/one"]);
  expect(store.submission("request")!.receipt.status).toBe("accepted");
  expect(store.cursor()).toBe("recovered");
  expect(store.outbox()).toHaveLength(0);
  expect(submit).not.toHaveBeenCalled();
  store.close();
});
it("keeps each job nonoverlapping across repeated ticks while other jobs are stalled", async () => {
  const store = storeWithUsers();
  store.intent({ requestId: "request", botId: "shared", senderId: "one", text: "Hello", attachments: [] });
  store.subscribe("one", { endpoint: "https://push.example.test/one", keys: { p256dh: "key", auth: "auth" } });
  queue(store, "first", Date.now());
  const receipt = deferred(), discovery = deferred();
  const delivery = deferred(), live = deferred();
  const capabilities = vi.fn(async () => capabilitiesFixture({ idempotency: { supported: true }, durableEvents: { supported: true } }));
  const lookupSubmission = vi.fn(async () => {
    await receipt.promise;
    return { requestId: "request", status: "accepted" as const, runId: "run" };
  });
  const discoverEvents = vi.fn(async () => { await discovery.promise; return { events: [], cursor: "advanced" }; });
  const send = vi.fn(async () => { await delivery.promise; });
  const worker = new BackgroundWorker(store, fakeRuntime({ capabilities, lookupSubmission, discoverEvents }), household(), send);
  const liveTick = vi.spyOn(worker.live, "tick").mockImplementation(async () => { await live.promise; });
  const ticks = [worker.tick(), worker.tick(), worker.tick()];
  try {
    await vi.waitFor(() => expect(lookupSubmission).toHaveBeenCalledTimes(1));
    expect(capabilities).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(liveTick).toHaveBeenCalledTimes(1);
    expect(discoverEvents).not.toHaveBeenCalled();
    receipt.resolve();
    await vi.waitFor(() => expect(discoverEvents).toHaveBeenCalledTimes(1));
    delivery.resolve();
    await vi.waitFor(() => expect(store.outbox()).toHaveLength(0));
    queue(store, "second", Date.now());
    ticks.push(worker.tick());
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(capabilities).toHaveBeenCalledTimes(1);
    expect(discoverEvents).toHaveBeenCalledTimes(1);
    expect(liveTick).toHaveBeenCalledTimes(1);
  } finally {
    receipt.resolve(); discovery.resolve(); delivery.resolve(); live.resolve();
    await Promise.all(ticks);
    await worker.stop();
    liveTick.mockRestore();
  }
  expect(send).toHaveBeenCalledTimes(2);
  expect(store.outbox()).toHaveLength(0);
  expect(store.cursor()).toBe("advanced");
  store.close();
});
it("continues scheduled delivery during slow recovery without overlapping recovery passes", async () => {
  vi.useFakeTimers();
  const store = storeWithUsers();
  store.intent({ requestId: "request", botId: "shared", senderId: "one", text: "Hello", attachments: [] });
  store.subscribe("one", { endpoint: "https://push.example.test/one", keys: { p256dh: "key", auth: "auth" } });
  queue(store, "first", Date.now());
  const release = deferred();
  const lookupSubmission = vi.fn(async () => { await release.promise; return null; });
  const send = vi.fn(async () => {});
  const worker = new BackgroundWorker(store, fakeRuntime({
    capabilities: async () => capabilitiesFixture({ idempotency: { supported: true }, durableEvents: { supported: false } }),
    lookupSubmission,
  }), household(), send);
  try {
    worker.start();
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    queue(store, "second", Date.now());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(lookupSubmission).toHaveBeenCalledTimes(1);
    const stopping = worker.stop();
    release.resolve();
    await stopping;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lookupSubmission).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve();
    await worker.stop();
    store.close();
    vi.useRealTimers();
  }
});
it.each(["runtime", "outbox", "live"] as const)("drains every job before closing APNs when %s settles last", async last => {
  const store = storeWithUsers();
  store.intent({ requestId: "request", botId: "shared", senderId: "one", text: "Hello", attachments: [] });
  queue(store, "existing", Date.now());
  store.nativeSession("session", "one", Date.now() + 60_000);
  store.registerNativeDevice("one", "session", "phone", "ab".repeat(32), "sandbox");
  const gates = { runtime: deferred(), outbox: deferred(), live: deferred() };
  const finished = { runtime: deferred(), outbox: deferred(), live: deferred() };
  const close = vi.fn();
  const sender = Object.assign(vi.fn(async () => { await gates.outbox.promise; finished.outbox.resolve(); }), {
    close, liveActivity: vi.fn(async () => {}), clear: vi.fn(async () => {}),
  });
  const factory = vi.spyOn(apns, "createApnsSender").mockReturnValue(sender);
  const config = household();
  config.apns = { teamId: "team", keyId: "key", topic: "test", privateKeyFile: "unused", environment: "sandbox" };
  const discoverEvents = vi.fn(async () => {
    await gates.runtime.promise;
    finished.runtime.resolve();
    return { events: [event], cursor: "recovered" };
  });
  const worker = new BackgroundWorker(store, fakeRuntime({
    capabilities: async () => capabilitiesFixture({ idempotency: { supported: true }, durableEvents: { supported: true } }),
    lookupSubmission: async () => ({ requestId: "request", status: "accepted", runId: "run" }),
    discoverEvents,
  }), config);
  const liveTick = vi.spyOn(worker.live, "tick").mockImplementation(async () => { await gates.live.promise; finished.live.resolve(); });
  const tick = worker.tick();
  let stopped = false;
  try {
    await vi.waitFor(() => expect(discoverEvents).toHaveBeenCalledTimes(1));
    expect(sender).toHaveBeenCalledTimes(1);
    expect(liveTick).toHaveBeenCalledTimes(1);
    const stopping = worker.stop().then(() => { stopped = true; });
    for (const name of ["runtime", "outbox", "live"] as const) if (name !== last) {
      gates[name].resolve();
      await finished[name].promise;
    }
    await worker.tick();
    expect(stopped).toBe(false);
    expect(close).not.toHaveBeenCalled();
    gates[last].resolve();
    await stopping;
    await tick;
    expect(sender).toHaveBeenCalledTimes(2);
    expect(store.outbox()).toHaveLength(0);
    expect(store.cursor()).toBe("recovered");
    expect(close).toHaveBeenCalledTimes(1);
    await worker.stop();
    await worker.tick();
    expect(close).toHaveBeenCalledTimes(1);
    expect(discoverEvents).toHaveBeenCalledTimes(1);
    expect(liveTick).toHaveBeenCalledTimes(1);
  } finally {
    Object.values(gates).forEach(gate => gate.resolve());
    await tick;
    await worker.stop();
    liveTick.mockRestore();
    factory.mockRestore();
    store.close();
  }
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
const offline = fakeRuntime({ capabilities: async () => { throw new Error("Hermes offline"); } });
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
it("expires day-old pending notifications even when partly delivered or never deliverable", async () => {
  const store = storeWithUsers();
  const old = Date.now() - day - 3600000;
  queue(store, "partly-delivered", old);
  store.markDelivered("partly-delivered", "https://push.example.test/first");
  queue(store, "no-subscription", old, "pending", "two");
  queue(store, "recent", Date.now() - day + 3600000);
  queue(store, "unknown-age", 0);
  queue(store, "already-delivered", old, "delivered");
  await new BackgroundWorker(store, offline, household(), async () => { throw new Error("not reached"); }).tick();
  expect(Object.fromEntries(["partly-delivered", "no-subscription", "recent", "unknown-age", "already-delivered"]
    .map(id => [id, outboxRow(store, id)!.state]))).toEqual({
    "partly-delivered": "expired", "no-subscription": "expired", recent: "pending", "unknown-age": "pending", "already-delivered": "delivered",
  });
  store.close();
});
it("delivers notifications without an assistant, and one failing notification never blocks the rest", async () => {
  const store = storeWithUsers();
  store.subscribe("one", { endpoint: "https://push.example.test/one", keys: { p256dh: "key", auth: "auth" } });
  const push = (id: string, botId?: string) => store.queueNotification(id, "one", { title: id, body: "", url: "/", tag: id, ...(botId ? { botId, kind: "approval" } : {}) });
  push("test-push");
  push("poisoned", "poison");
  push("after-poison", "shared");
  const presentation = store.presentation.bind(store);
  vi.spyOn(store, "presentation").mockImplementation(botId => { if (botId === "poison") throw new Error("boom"); return presentation(botId); });
  const sent: string[] = [];
  await new BackgroundWorker(store, offline, household(), async (_subscription, payload) => { sent.push(JSON.parse(payload).title); }).tick();
  expect(sent).toEqual(["test-push", "after-poison"]);
  const poisoned = store.db.prepare("SELECT state,attempts,last_error FROM outbox WHERE event_id='poisoned'").get();
  expect(poisoned).toEqual({ state: "pending", attempts: 1, last_error: "Delivery error: boom" });
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
it("delivers security alerts at once, through quiet hours and digest batching, and coalesces repeats", async () => {
  const store = storeWithUsers();
  const hour = new Date().getUTCHours(), at = (offset: number) => `${String((hour + offset + 24) % 24).padStart(2, "0")}:00`;
  store.savePreferences("one", { ...store.preferences("one"), notifications: { timezone: "UTC", quietStart: at(-1), quietEnd: at(1), batchMinutes: 10 } });
  store.subscribe("one", { endpoint: "https://push.example.test/one", keys: { p256dh: "key", auth: "auth" } });
  store.queueNotification("evt-quiet", "one", { title: "Work complete", body: "", url: "/?bot=shared", tag: "evt-quiet", kind: "completed", botId: "shared", queuedAt: Date.now() });
  const alert = { title: "System terminal opened", body: "one opened the system terminal.", url: "/?computer=1", tag: "terminal-open:abc:1", kind: "security", queuedAt: Date.now() };
  expect(store.queueNotification("terminal-open:abc:1", "one", alert)).toBe(true);
  expect(store.queueNotification("terminal-open:abc:1", "one", alert)).toBe(false);
  const sent: string[] = [];
  const runtime = fakeRuntime({ capabilities: async () => capabilitiesFixture({ idempotency: { supported: false }, durableEvents: { supported: false } }) });
  const worker = new BackgroundWorker(store, runtime, loadConfig({ HOUSEHOLD_EMAILS: "one@example.test,two@example.test" }),
    async (_subscription, payload) => { sent.push(JSON.parse(payload).title); });
  await worker.tick();
  expect(sent).toEqual(["System terminal opened"]);
  expect(store.outbox().map(row => JSON.parse(row.payload).kind)).toEqual(["completed"]);
  store.close();
});

it("drains the worker before closing its runtime and database", async () => {
  const store = storeWithUsers();
  store.intent({ requestId: "shutdown", botId: "shared", senderId: "one", text: "Hello", attachments: [] });
  const entered = deferred(), release = deferred();
  const close = vi.fn(async () => {});
  const runtime = fakeRuntime({
    capabilities: async () => capabilitiesFixture({ idempotency: { supported: true }, durableEvents: { supported: false } }),
    lookupSubmission: async () => { entered.resolve(); await release.promise; return null; },
    listBots: async () => [], close,
  });
  const { app, worker } = await createApp(household(), runtime, { store, background: false });
  await app.ready();
  const tick = worker.tick();
  await entered.promise;
  const stop = vi.spyOn(worker, "stop");
  const closing = app.close();
  try {
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(close).not.toHaveBeenCalled();
    expect(store.users()).toHaveLength(2);
  } finally {
    release.resolve();
    await Promise.all([tick, closing]);
  }
  expect(close).toHaveBeenCalledTimes(1);
  expect(() => store.users()).toThrow();
});
