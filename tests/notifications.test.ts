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
