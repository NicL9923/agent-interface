import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/server/store.js";
import { defaultPreferences, type RuntimeEvent } from "../src/shared/types.js";

// enqueueKnownEvents offers every event of the last day to the outbox again, every few seconds, so late
// participants and new followers still hear about recent news. These pin what that replay must keep doing.
const day = 86400000;
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks(); });
function seeded() {
  const store = new Store(":memory:");
  stores.push(store);
  for (const id of ["one", "two", "three"]) store.user({ id, name: id, email: `${id}@example.test` });
  return store;
}
const done = (id: string, extra: Partial<RuntimeEvent> = {}): RuntimeEvent =>
  ({ id, botId: "shared", runId: `run-${id}`, kind: "completed", title: "Work complete", body: "**All** done", occurredAt: new Date().toISOString(), ...extra });
const follow = (store: Store, userId: string, ...botIds: string[]) => store.savePreferences(userId, { ...defaultPreferences, followBots: botIds });
const outbox = (store: Store) =>
  store.db.prepare("SELECT event_id AS eventId,user_id AS userId,state FROM outbox ORDER BY event_id,user_id").all() as { eventId: string; userId: string; state: string }[];
const age = (store: Store, eventId: string, ms: number) =>
  store.db.prepare("UPDATE notification_events SET created_at=? WHERE id=?").run(Date.now() - ms, eventId);

it("queues a recent event for a participant who joins its run after it was discovered", () => {
  const store = seeded();
  store.recordEvents([done("e1")], "c");
  expect(outbox(store)).toEqual([]);
  store.participate("run-e1", "one");
  store.enqueueKnownEvents();
  expect(outbox(store)).toEqual([{ eventId: "e1", userId: "one", state: "pending" }]);
  // The row a replay writes is the notification the event would have made on first sight.
  const payload = JSON.parse((store.db.prepare("SELECT payload FROM outbox").get() as { payload: string }).payload);
  expect(payload).toMatchObject({ title: "Work complete", kind: "completed", botId: "shared", tag: "e1", url: "/?bot=shared" });
  expect(payload.body).toContain("All done");
  expect(payload.body).not.toContain("**");
});

it("queues the last day for a new follower, and nothing older", () => {
  const store = seeded();
  store.recordEvents([done("old"), done("recent"), done("edge")], "c");
  age(store, "old", day + 60_000);
  age(store, "edge", day - 60_000);
  follow(store, "two", "shared");
  store.enqueueKnownEvents();
  expect(outbox(store)).toEqual([{ eventId: "edge", userId: "two", state: "pending" }, { eventId: "recent", userId: "two", state: "pending" }]);
});

it("never queues a private assistant's event for anyone but its owner, whoever follows or joined in", () => {
  const store = seeded();
  store.savePresentation("secret", { shared: false, ownerId: "one" });
  store.recordEvents([done("e1", { botId: "secret" })], "c");
  follow(store, "one", "secret");
  follow(store, "two", "secret");
  store.participate("run-e1", "three");
  store.enqueueKnownEvents();
  expect(outbox(store)).toEqual([{ eventId: "e1", userId: "one", state: "pending" }]);
  // Replaying again must not change that, with the other two now holding the same claims.
  store.enqueueKnownEvents();
  expect(outbox(store)).toHaveLength(1);
});

it("keeps a quiet check-in run out of the outbox on every replay, and still notifies for a check-in that found something", () => {
  const store = seeded();
  store.checkIns.track({ botId: "main", jobId: "job", userId: "one" });
  follow(store, "one", "main");
  const checkIn = (id: string, body?: string) => done(id, { botId: "main", routineId: "job", body });
  store.recordEvents([checkIn("silent", "[SILENT]"), checkIn("empty", "  "), checkIn("found", "The roof leaks"), { ...checkIn("failed"), kind: "failed" }], "c");
  store.enqueueKnownEvents();
  store.enqueueKnownEvents();
  expect(outbox(store)).toEqual([{ eventId: "found", userId: "one", state: "pending" }]);
});

it("does not queue a delivered or failed event again, or change its state", () => {
  const store = seeded();
  follow(store, "one", "shared");
  store.recordEvents([done("e1"), done("e2")], "c");
  const [first, second] = (store.db.prepare("SELECT id FROM outbox ORDER BY event_id").all() as { id: string }[]).map(row => row.id);
  store.markDelivered(first, "apns:device");
  store.finishDelivery(first);
  store.retryDelivery(second, 12, "gone");
  store.enqueueKnownEvents();
  store.enqueueKnownEvents();
  expect(outbox(store)).toEqual([{ eventId: "e1", userId: "one", state: "delivered" }, { eventId: "e2", userId: "one", state: "failed" }]);
});

it("builds a notification's copy only when a replay will queue it for someone new", () => {
  const store = seeded();
  follow(store, "one", "shared");
  store.recordEvents([done("e1"), done("e2")], "c");
  // The copy starts with the assistant's name, so a read of it is a build.
  const names = vi.spyOn(store.notifications.botNames, "get");
  store.enqueueKnownEvents();
  expect(names).not.toHaveBeenCalled();
  follow(store, "two", "shared");
  store.enqueueKnownEvents();
  expect(names.mock.calls).toEqual([["shared"], ["shared"]]);
  expect(outbox(store).map(row => `${row.eventId}:${row.userId}`)).toEqual(["e1:one", "e1:two", "e2:one", "e2:two"]);
});

it("keeps a recipient who already has a row out of the copy when a new one joins the same event", () => {
  const store = seeded();
  follow(store, "one", "shared");
  store.recordEvents([done("e1")], "c");
  const original = (store.db.prepare("SELECT id,payload FROM outbox").get() as { id: string; payload: string });
  follow(store, "two", "shared");
  store.enqueueKnownEvents();
  expect(outbox(store).map(row => row.userId)).toEqual(["one", "two"]);
  expect(store.db.prepare("SELECT payload FROM outbox WHERE id=?").get(original.id)).toEqual({ payload: original.payload });
});
