import cookie from "@fastify/cookie";
import Fastify, { type InjectOptions } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hash, installAuth } from "../src/server/auth.js";
import { installBotAccess } from "../src/server/bot-access.js";
import { loadConfig } from "../src/server/config.js";
import { errorHandler, httpError } from "../src/server/http-error.js";
import { installQueueRoutes } from "../src/server/queue-routes.js";
import type { EnqueueInput, QueueRepository } from "../src/server/store-queue.js";
import { Store } from "../src/server/store.js";
import { MAX_MESSAGE_TEXT, routeUrl } from "../src/shared/api.js";
import type { QueueListResponse } from "../src/shared/queue.js";
import type { Bot, Runtime } from "../src/shared/types.js";
import { capabilitiesFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime, signIn } from "./helpers/server.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function open(path = ":memory:") {
  const store = new Store(path);
  cleanup.push(() => store.close());
  return store;
}

const enqueue = (queue: QueueRepository, text: string, input: Partial<EnqueueInput> = {}) =>
  queue.enqueue({
    botId: "family",
    requestId: randomUUID(),
    senderId: "local-one",
    senderName: "First member",
    text,
    ...input,
  });

const itemConflict = { statusCode: 409, code: "queue_item_not_queued" };
const itemMissing = { statusCode: 404, code: "queue_item_not_found" };

describe("durable queue", () => {
  it("claims FIFO across two store connections and advances only the named assistant", () => {
    const directory = mkdtempSync(join(tmpdir(), "wildbots-queue-"));
    cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
    const path = join(directory, "store.sqlite");
    const { queue } = open(path);
    const second = open(path).queue;
    const a = enqueue(queue, "First", { expectedVersion: 0 });
    const b = enqueue(second, "Second", { expectedVersion: 1 });
    const other = enqueue(queue, "Independent", { botId: "other" });
    expect(queue.list("family")).toEqual([a, b]);
    expect(b.position).toBeGreaterThan(a.position);
    expect([a.conversationVersion, b.conversationVersion, other.conversationVersion]).toEqual([
      1, 2, 1,
    ]);

    expect(second.claimNext("family", "run-a")).toMatchObject({
      id: a.id,
      status: "running",
      claimedAt: expect.any(Number),
    });
    expect(queue.claimNext("family", "run-b")).toBeUndefined();
    expect(queue.claimNext("other", "run-other")).toMatchObject({
      id: other.id,
      status: "running",
    });
    expect(queue.version("family")).toBe(3);
    const completed = queue.complete("family", a.id);
    expect(completed).toMatchObject({
      status: "completed",
      settledAt: expect.any(Number),
      conversationVersion: 1,
    });
    expect(second.complete("family", a.id)).toEqual(completed);
    expect(queue.version("family")).toBe(4);
    expect(queue.list("family")).toEqual([b]);
    expect(queue.list("family", { includeSettled: true })).toEqual([completed, b]);
    expect(second.claimNext("family", "run-b")).toMatchObject({ id: b.id, status: "running" });
  });

  it("returns an existing request through edits and settlement without applying a stale fence twice", () => {
    const { queue } = open();
    const requestId = randomUUID();
    const files = [{ id: "file", mime: "text/plain", name: "original.txt", size: 6 }];
    const input = { requestId, expectedVersion: 0, files };
    const queued = enqueue(queue, "Original", input);
    expect(enqueue(queue, "Original", input)).toEqual(queued);
    expect(queue.version("family")).toBe(1);
    const edited = queue.edit("family", queued.id, "local-one", "Edited");
    expect(enqueue(queue, "Original", input)).toEqual(edited);
    expect(edited.files).toEqual(files);
    const running = queue.claimNext("family", "run");
    expect(enqueue(queue, "Original", input)).toEqual(running);
    const done = queue.complete("family", queued.id);
    expect(enqueue(queue, "Original", input)).toEqual(done);
    expect(queue.version("family")).toBe(4);

    for (const scope of [{ botId: "other" }, { senderId: "local-two" }]) {
      expect(() => enqueue(queue, "Original", { requestId, ...scope })).toThrow(
        expect.objectContaining({
          statusCode: 409,
          code: "submission_conflict",
        }),
      );
    }
    expect(queue.version("other")).toBe(0);
    expect(queue.list("family", { includeSettled: true })).toEqual([done]);
  });

  it("rejects stale admissions without reserving the request or advancing queue state", () => {
    const { queue } = open();
    const first = enqueue(queue, "First");
    expect(queue.bumpVersion("family")).toBe(2);
    const requestId = randomUUID();
    expect(() =>
      enqueue(queue, "Stale", { requestId, expectedVersion: first.conversationVersion }),
    ).toThrow(
      expect.objectContaining({
        statusCode: 409,
        code: "conversation_changed",
        message: "The conversation changed before your action was sent.",
      }),
    );
    expect(queue.snapshot("family", {})).toEqual({ items: [first], conversationVersion: 2 });
    expect(enqueue(queue, "Fresh", { requestId, expectedVersion: 2 })).toMatchObject({
      requestId,
      text: "Fresh",
      position: first.position + 1,
      conversationVersion: 3,
    });
  });

  it("reorders queued items across priority groups and keeps subsequent admissions at the tail", () => {
    const { queue } = open();
    const first = enqueue(queue, "First");
    const second = enqueue(queue, "Second");
    const promoted = enqueue(queue, "Already prioritized", { priority: "send_now" });
    const ids = () => queue.list("family").map(({ id }) => id);
    expect(ids()).toEqual([promoted.id, first.id, second.id]);
    expect(queue.promoteToSendNow("family", second.id).priority).toBe("send_now");
    expect(ids()).toEqual([second.id, promoted.id, first.id]);
    expect(queue.reorder("family", first.id, promoted.id).priority).toBe("send_now");
    expect(ids()).toEqual([second.id, first.id, promoted.id]);
    expect(queue.reorder("family", second.id, null).priority).toBe("normal");
    expect(ids()).toEqual([first.id, promoted.id, second.id]);
    const version = queue.version("family");
    queue.reorder("family", first.id, first.id);
    expect(queue.version("family")).toBe(version);
    const latest = enqueue(queue, "Appended");
    expect(latest.position).toBeGreaterThan(promoted.position);
    expect(ids()).toEqual([first.id, promoted.id, second.id, latest.id]);
    expect(queue.claimNext("family", "run")?.id).toBe(first.id);
  });

  it("enforces sender access, queued state, and assistant scope for every mutation", () => {
    const { queue } = open();
    const running = enqueue(queue, "Running");
    const completed = enqueue(queue, "Completed", { priority: "send_now" });
    const interrupted = enqueue(queue, "Interrupted", { priority: "send_now" });
    const cancelled = enqueue(queue, "Cancelled");
    const queued = enqueue(queue, "Queued");
    const other = enqueue(queue, "Other", { botId: "other" });
    expect(queue.claimNext("family", "done")?.id).toBe(completed.id);
    queue.complete("family", completed.id);
    expect(queue.claimNext("family", "failed")?.id).toBe(interrupted.id);
    const failure = queue.fail("family", interrupted.id, "Harness disconnected");
    expect(failure).toMatchObject({
      status: "interrupted",
      error: "Harness disconnected",
      settledAt: expect.any(Number),
    });
    expect(queue.fail("family", interrupted.id, "Duplicate callback")).toEqual(failure);
    expect(queue.claimNext("family", "active")?.id).toBe(running.id);
    expect(queue.cancel("family", cancelled.id)).toMatchObject({
      status: "cancelled",
      settledAt: expect.any(Number),
    });

    const unchanged = queue.snapshot("family", { includeSettled: true });
    const actions = (botId: string, itemId: string) => [
      () => queue.edit(botId, itemId, "local-one", "Edit"),
      () => queue.reorder(botId, itemId, null),
      () => queue.promoteToSendNow(botId, itemId),
      () => queue.cancel(botId, itemId),
    ];
    for (const item of [running, completed, interrupted, cancelled]) {
      for (const action of actions("family", item.id))
        expect(action).toThrow(expect.objectContaining(itemConflict));
      expect(() => queue.reorder("family", queued.id, item.id)).toThrow(
        expect.objectContaining(itemConflict),
      );
    }
    for (const itemId of [queued.id, "missing"]) {
      for (const action of actions("other", itemId))
        expect(action).toThrow(expect.objectContaining(itemMissing));
    }
    expect(() => queue.reorder("family", queued.id, other.id)).toThrow(
      expect.objectContaining(itemMissing),
    );
    expect(() => queue.edit("family", queued.id, "local-two", "Edit")).toThrow(
      expect.objectContaining(itemMissing),
    );
    expect(() => queue.complete("family", queued.id)).toThrow(
      expect.objectContaining({
        statusCode: 409,
        code: "queue_item_not_running",
      }),
    );
    expect(queue.snapshot("family", { includeSettled: true })).toEqual(unchanged);
    expect(queue.edit("family", queued.id, "local-one", "Edit").text).toBe("Edit");
  });

  it("recovers persisted running items after reopening and leaves later queued work claimable", () => {
    const directory = mkdtempSync(join(tmpdir(), "wildbots-queue-recovery-"));
    cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
    const path = join(directory, "store.sqlite");
    const first = new Store(path);
    try {
      enqueue(first.queue, "In progress");
      enqueue(first.queue, "Waiting");
      enqueue(first.queue, "Other bot", { botId: "other" });
      first.queue.claimNext("family", "run-family");
      first.queue.claimNext("other", "run-other");
    } finally {
      first.close();
    }

    const { queue, db } = open(path);
    expect(queue.claimNext("family", "too-early")).toBeUndefined();
    expect(queue.markRunningInterrupted("family")).toBe(1);
    expect(queue.markRunningInterrupted("family")).toBe(0);
    expect(queue.version("family")).toBe(4);
    expect(queue.list("other")[0].status).toBe("running");
    const [interrupted] = queue.list("family", { includeSettled: true });
    expect(interrupted).toMatchObject({
      text: "In progress",
      status: "interrupted",
      settledAt: expect.any(Number),
    });
    expect({
      ...db.prepare("SELECT run_id FROM bot_queue WHERE id=?").get(interrupted.id),
    }).toEqual({ run_id: "run-family" });
    expect(queue.list("family").map(({ text }) => text)).toEqual(["Waiting"]);
    expect(queue.markRunningInterrupted()).toBe(1);
    expect(queue.version("other")).toBe(3);
    expect(queue.claimNext("other", "do-not-replay")).toBeUndefined();
    expect(queue.claimNext("family", "waiting")).toMatchObject({
      text: "Waiting",
      status: "running",
    });
    expect(() => queue.complete("family", interrupted.id)).toThrow(
      expect.objectContaining({
        statusCode: 409,
        code: "queue_item_not_running",
      }),
    );
  });

  it("deletion removes a reused assistant ID's messages and fences actions from its old conversation", () => {
    const store = open();
    const { queue } = store;
    const old = enqueue(queue, "Old private work");
    const other = enqueue(queue, "Other bot", { botId: "other" });
    store.forgetBot("family");
    expect(queue.list("family", { includeSettled: true })).toEqual([]);
    expect(queue.list("other")).toEqual([other]);
    expect(() => enqueue(queue, "Stale", { expectedVersion: old.conversationVersion })).toThrow(
      expect.objectContaining({ code: "conversation_changed" }),
    );
    expect(enqueue(queue, "New conversation", { expectedVersion: 2 }).conversationVersion).toBe(3);
  });
  it("serves latest-settlement lookups from bot_queue_settled without a temp sort", () => {
    const store = open();
    const first = enqueue(store.queue, "First");
    store.queue.claimNext("family", "run-1");
    store.queue.complete("family", first.id);
    const plan = store.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT run_id AS runId, status, settled_at AS at FROM bot_queue
         WHERE bot_id=? AND status IN ('completed','interrupted')
         ORDER BY settled_at DESC, rowid DESC LIMIT 1`,
      )
      .all("family")
      .map((row) => (row as { detail: string }).detail)
      .join("\n");
    expect(plan).toContain("bot_queue_settled");
  });
});

const origin = "http://127.0.0.1:3000";
const queuePath = (bot = "family") => `/api/bots/${bot}/queue`;

async function setup(capabilities?: Runtime["capabilities"]) {
  const store = open();
  const app = Fastify();
  cleanup.push(() => app.close());
  const bots: Bot[] = [
    { id: "family", name: "Family", model: "test", shared: true, activity: "idle" },
    { id: "private", name: "Private", model: "test", shared: false, activity: "idle" },
    { id: "legacy", name: "Legacy", model: "test", shared: false, activity: "idle" },
  ];
  const runtime = fakeRuntime({
    listBots: async () => bots,
    capabilities: capabilities ?? (async () => capabilitiesFixture({ chat: { supported: true } })),
  });
  await app.register(cookie);
  await installAuth(app, store, loadConfig({ APP_ORIGIN: origin, LOCAL_DEV_AUTH: "true" }));
  app.setErrorHandler(errorHandler({ production: true }));
  const roster = installBotAccess(app, store, runtime);
  installQueueRoutes(app, {
    store,
    roster,
    runtime,
    requireCapability: async (key, botId) => {
      const capability = (await runtime.capabilities(botId))[key];
      if (!capability.supported) throw httpError(409, capability.reason ?? `${key} is unavailable`);
    },
  });
  store.savePresentation("private", { shared: false, ownerId: "local-one" });
  store.savePresentation("legacy", { shared: false });
  return {
    app,
    store,
    queue: store.queue,
    owner: signIn(store, origin, "local-one"),
    member: signIn(store, origin, "local-two"),
  };
}

function requests(bot: string, item: string): InjectOptions[] {
  const url = `${queuePath(bot)}/${item}`;
  return [
    { method: "GET", url: queuePath(bot) },
    { method: "PATCH", url, payload: { text: "Edit" } },
    { method: "POST", url: `${url}/reorder`, payload: { toEnd: true } },
    { method: "POST", url: `${url}/send-now` },
    { method: "DELETE", url },
  ];
}

describe("queue routes", () => {
  it("lists, edits, reorders, promotes, and cancels through Fastify", async () => {
    const { app, store, queue, member } = await setup();
    const a = enqueue(queue, "First");
    const b = enqueue(queue, "Second");
    const c = enqueue(queue, "Third");
    const wire = (entry: typeof a) => ({
      ...entry,
      attachments: entry.files,
      createdAt: new Date(entry.createdAt).toISOString(),
    });
    const listed = await app.inject({ url: queuePath(), headers: member });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ items: [wire(a), wire(b), wire(c)], conversationVersion: 3 });

    const result = await app.inject({
      method: "PATCH",
      url: `${queuePath()}/${a.id}`,
      headers: member,
      payload: { text: "Edited by another member" },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      id: a.id,
      text: "Edited by another member",
      senderId: a.senderId,
    });
    const moved = await app.inject({
      method: "POST",
      url: `${queuePath()}/${c.id}/reorder`,
      headers: member,
      payload: { beforeItemId: a.id },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ id: c.id, position: a.position });

    const token = randomBytes(32).toString("base64url");
    store.nativeSession(hash(token), "local-two", Date.now() + 60_000);
    const promoted = await app.inject({
      method: "POST",
      url: `${queuePath()}/${b.id}/send-now`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ id: b.id, priority: "send_now" });
    const cancelled = await app.inject({
      method: "DELETE",
      url: `${queuePath()}/${c.id}`,
      headers: member,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ id: c.id, status: "cancelled" });

    const get = (includeSettled: boolean) =>
      app.inject({
        headers: member,
        url: `/api${routeUrl("GET /bots/:id/queue", { id: "family" }, { includeSettled })}`,
      });
    const active = await get(false);
    expect(active.statusCode).toBe(200);
    expect(active.json<QueueListResponse>().items.map(({ id }) => id)).toEqual([b.id, a.id]);
    const settled = await get(true);
    expect(settled.statusCode).toBe(200);
    const history = settled.json<QueueListResponse>();
    expect(history.items.map(({ id, status }) => [id, status])).toEqual([
      [b.id, "queued"],
      [c.id, "cancelled"],
      [a.id, "queued"],
    ]);
    expect(history.conversationVersion).toBe(7);
  });

  it("requires a session on all five routes and hides private and missing assistants identically", async () => {
    const { app, queue, member, owner } = await setup();
    const item = enqueue(queue, "Private text", { botId: "private" });
    for (const req of requests("private", item.id)) {
      const response = await app.inject(req);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Sign in required", code: "session_expired" });
    }
    for (const bot of ["private", "missing"]) {
      for (const req of requests(bot, item.id)) {
        const response = await app.inject({ ...req, headers: member });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
          error: "Assistant not found",
          code: "assistant_not_found",
        });
      }
    }
    const allowed = await app.inject({ url: queuePath("private"), headers: owner });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json<QueueListResponse>().items).toEqual([
      { ...item, attachments: item.files, createdAt: new Date(item.createdAt).toISOString() },
    ]);
  });

  it("omits running messages from the default queue route and serializes client attachments and ISO timestamps", async () => {
    const { app, queue, member } = await setup();
    const files = [{ id: "f1", name: "photo.png", mime: "image/png", size: 42 }];
    const first = enqueue(queue, "Already running");
    const waiting = enqueue(queue, "Waiting next", { files });
    queue.claimNext("family", "run-1");

    const response = await app.inject({ url: queuePath(), headers: member });
    expect(response.statusCode).toBe(200);
    const body = response.json<QueueListResponse>();
    expect(body.items.map((entry) => entry.id)).toEqual([waiting.id]);
    expect(body.items[0]?.attachments).toEqual(files);
    expect(body.items[0]?.createdAt).toBe(new Date(waiting.createdAt).toISOString());

    const withSettled = await app.inject({
      url: `${queuePath()}?includeSettled=true`,
      headers: member,
    });
    expect(withSettled.statusCode).toBe(200);
    expect(withSettled.json<QueueListResponse>().items.map((entry) => entry.id)).toEqual([
      first.id,
      waiting.id,
    ]);
  });

  it("returns item-specific 404 and 409 responses and checks ownership on legacy personal assistants", async () => {
    const { app, queue, member } = await setup();
    const item = enqueue(queue, "About to run");
    const legacy = enqueue(queue, "Legacy", { botId: "legacy" });
    const wrong = await app.inject({
      method: "PATCH",
      url: `${queuePath("legacy")}/${item.id}`,
      headers: member,
      payload: { text: "Edit" },
    });
    const unowned = await app.inject({
      method: "PATCH",
      url: `${queuePath("legacy")}/${legacy.id}`,
      headers: member,
      payload: { text: "Edit" },
    });
    for (const response of [wrong, unowned]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: "Queued message not found",
        code: "queue_item_not_found",
      });
    }
    queue.claimNext("family", "run");
    for (const req of requests("family", item.id).slice(1)) {
      const response = await app.inject({ ...req, headers: member });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: "This message is no longer queued.",
        code: "queue_item_not_queued",
      });
    }
  });

  it("validates query and mutation inputs and keeps browser writes behind CSRF", async () => {
    const { app, queue, member } = await setup();
    const item = enqueue(queue, "Original");
    const url = `${queuePath()}/${item.id}`;
    const invalid = await app.inject({
      url: `${queuePath()}?includeSettled=anything`,
      headers: member,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: "Invalid request",
      details: [{ path: ["includeSettled"] }],
    });
    for (const payload of [{}, { text: 1 }, { text: "x".repeat(MAX_MESSAGE_TEXT + 1) }]) {
      const response = await app.inject({ method: "PATCH", url, headers: member, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: "Invalid request",
        details: [{ path: ["text"] }],
      });
    }
    const empty = await app.inject({
      method: "PATCH",
      url,
      headers: member,
      payload: { text: "  " },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: "Message cannot be empty" });
    for (const payload of [
      {},
      { beforeItemId: "" },
      { toEnd: false },
      { toEnd: true, beforeItemId: item.id },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `${url}/reorder`,
        headers: member,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "Invalid request" });
    }
    const invalidCsrf = await app.inject({
      method: "DELETE",
      url,
      headers: { ...member, "x-csrf-token": "wrong" },
    });
    expect(invalidCsrf.statusCode).toBe(403);
    expect(invalidCsrf.json()).toEqual({ error: "Invalid CSRF token" });
    expect(queue.snapshot("family", {})).toEqual({ items: [item], conversationVersion: 1 });

    const attached = enqueue(queue, "Caption", {
      files: [{ id: "file", mime: "image/png", name: "photo.png" }],
    });
    const clearCaption = await app.inject({
      method: "PATCH",
      url: `${queuePath()}/${attached.id}`,
      headers: member,
      payload: { text: "" },
    });
    expect(clearCaption.statusCode).toBe(200);
    expect(clearCaption.json()).toMatchObject({ text: "", files: attached.files });
  });

  it("checks the named runtime for send-now and won't promote after access changes during that check", async () => {
    let allowed = false;
    const bots: (string | undefined)[] = [];
    const { app, store, queue, member } = await setup(async (botId) => {
      bots.push(botId);
      if (allowed) sharePrivately();
      return capabilitiesFixture({ chat: { supported: allowed, reason: "Chat is unavailable" } });
    });
    const sharePrivately = () =>
      store.savePresentation("family", { shared: false, ownerId: "local-one" });
    const item = enqueue(queue, "First");
    const url = `${queuePath()}/${item.id}/send-now`;
    const blocked = await app.inject({ method: "POST", url, headers: member });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: "Chat is unavailable" });
    allowed = true;
    const privateNow = await app.inject({ method: "POST", url, headers: member });
    expect(privateNow.statusCode).toBe(404);
    expect(privateNow.json()).toEqual({
      error: "Assistant not found",
      code: "assistant_not_found",
    });
    expect(bots).toEqual(["family", "family"]);
    expect(queue.snapshot("family", {})).toEqual({ items: [item], conversationVersion: 1 });
  });
});
