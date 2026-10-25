import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { retryRequestId } from "../src/shared/retry-id.js";
import type { Conversation, Message, Runtime, Submission } from "../src/shared/types.js";
import { botFixture, capabilitiesFixture, conversationFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime, localLogin } from "./helpers/server.js";

const origin = "http://127.0.0.1:3000";
const capabilities = capabilitiesFixture({ chat: { supported: true }, steering: { supported: true }, idempotency: { supported: true } });
const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

const history: Message[] = [
  { id: "u1", role: "user", text: "Check the fence" },
  { id: "a1", role: "assistant", text: "The fence is fine." },
  { id: "u2", role: "user", text: "Order more feed" },
  { id: "cron", role: "user", text: "[Cron delivery: feed report]\nFeed is low." },
  { id: "agent", role: "user", text: "Message from Penny (@penny): Feed is low." },
];
async function installation(conversation: Partial<Conversation> = {}, overrides: Partial<Runtime> = {}) {
  const submit = vi.fn(async (input: Submission) => ({ requestId: input.requestId, status: "accepted" as const, runId: "run" }));
  const read = vi.fn(async (botId: string) => conversationFixture({ botId, messages: botId === "shared" ? history : [{ id: "other-u", role: "user", text: "Elsewhere" }], activity: { state: "failed" }, ...conversation }));
  const runtime = fakeRuntime({
    listBots: async () => [botFixture(), botFixture({ id: "other", name: "Other" })],
    capabilities: async () => capabilities, conversation: read, submit,
    lookupSubmission: async () => null, close: async () => {}, ...overrides,
  });
  const result = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), runtime, { background: false });
  apps.push(result.app);
  const headers = await localLogin(result.app, origin);
  const put = (text: string) => result.app.inject({ method: "PUT", url: "/api/bots/shared/draft", headers, payload: { text, attachments: [] } });
  const draft = async () => (await result.app.inject({ url: "/api/bots/shared/draft", headers })).json();
  // A retry carries its failed turn's own ID unless the test names another.
  const idFor = (payload: Record<string, unknown>) => typeof payload.retryOf === "string"
    ? retryRequestId("shared", payload.retryOf, conversation.activity?.runId ?? "") : Promise.resolve(randomUUID());
  const send = async (payload: Record<string, unknown>, path = "messages", as = headers) =>
    result.app.inject({ method: "POST", url: `/api/bots/shared/${path}`, headers: as, payload: { requestId: await idFor(payload), attachments: [], ...payload } });
  return { ...result, submit, read, headers, put, draft, send };
}

describe("retrying a failed turn", () => {
  it("sends the retried message without reading, merging or clearing the draft, even one holding the same text", async () => {
    const { submit, read, put, draft, send } = await installation();
    await put("Order more feed");
    const before = await draft();
    const sent = await send({ text: "Order more feed", retryOf: "u2" });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().status).toBe("accepted");
    expect(read).toHaveBeenCalledWith("shared", { window: { start: "u2" } });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ text: "Order more feed", retryOf: "u2", senderId: "local-one" }));
    expect(submit.mock.calls[0][0]).not.toHaveProperty("draftBaseRevision");
    expect(await draft()).toEqual(before);
    // An ordinary send of the same text still clears it.
    expect((await send({ text: "Order more feed" })).json().status).toBe("accepted");
    expect(await draft()).toMatchObject({ text: "", reason: "sent" });
  });

  it("leaves the draft alone when an uncertain retry is later confirmed", async () => {
    const lookupSubmission = vi.fn(async (requestId: string) => ({ requestId, status: "accepted" as const }));
    const { app, headers, put, draft, send } = await installation({}, {
      submit: async input => ({ requestId: input.requestId, status: "uncertain" }), lookupSubmission,
    });
    await put("Order more feed");
    const sent = await send({ text: "Order more feed", retryOf: "u2" });
    expect(sent.json().status).toBe("uncertain");
    const checked = await app.inject({ url: `/api/submissions/${sent.json().requestId}`, headers });
    expect(checked.json().status).toBe("accepted");
    expect(await draft()).toMatchObject({ text: "Order more feed", reason: "edit" });
  });

  it("replays the same retry request idempotently and refuses its id for different content", async () => {
    const { submit, send } = await installation();
    const requestId = await retryRequestId("shared", "u2");
    expect((await send({ requestId, text: "Order more feed", retryOf: "u2" })).json().status).toBe("accepted");
    expect((await send({ requestId, text: "Order more feed", retryOf: "u2" })).json().status).toBe("accepted");
    expect(submit).toHaveBeenCalledTimes(1);
    expect((await send({ requestId, text: "Order more feed", retryOf: "u1" })).statusCode).toBe(409);
  });

  it.each([
    ["an unknown message", "missing"],
    ["an assistant reply", "a1"],
    ["a scheduled delivery", "cron"],
    ["a message from another assistant", "agent"],
    ["another assistant's message", "other-u"],
  ])("refuses to retry %s", async (_, retryOf) => {
    const { submit, send, draft, put } = await installation();
    await put("Keep me");
    const sent = await send({ text: "Order more feed", retryOf });
    expect(sent.statusCode).toBe(400);
    expect(sent.json().error).toBe("That message is no longer in this conversation");
    expect(submit).not.toHaveBeenCalled();
    expect(await draft()).toMatchObject({ text: "Keep me" });
  });

  it("refuses a retry written on a draft revision or sent as steering", async () => {
    const { submit, send } = await installation();
    const based = await send({ text: "Order more feed", retryOf: "u2", draftBaseRevision: 0 });
    expect(based.statusCode).toBe(400);
    expect(based.json().details[0].message).toBe("A retry is not written on a draft");
    expect((await send({ text: "Order more feed", retryOf: "u2" }, "steer")).statusCode).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses while the assistant is busy or an interrupted task awaits review", async () => {
    for (const state of ["thinking", "waiting"] as const) {
      const { submit, send } = await installation({ activity: { state } });
      const sent = await send({ text: "Order more feed", retryOf: "u2" });
      expect(sent.statusCode).toBe(409);
      expect(submit).not.toHaveBeenCalled();
    }
    const { send } = await installation({ activity: { state: "interrupted" } });
    expect((await send({ text: "Order more feed", retryOf: "u2" })).statusCode).toBe(409);
  });

  describe("one retry per failed turn", () => {
    const failed = { activity: { state: "failed" as const, runId: "run-1" } };
    it("admits the first retry of a failed run and answers a later one with its receipt", async () => {
      const submit = vi.fn(async (input: Submission) => ({ requestId: input.requestId, status: "uncertain" as const }));
      const { send } = await installation(failed, { submit });
      const first = (await send({ text: "Order more feed", retryOf: "u2" })).json();
      expect(first.requestId).toBe(await retryRequestId("shared", "u2", "run-1"));
      const second = await send({ text: "Order more feed", retryOf: "u2" });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first);
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("refuses, before admitting anything, a retry ID bound to another turn and an ordinary message with a retry's ID", async () => {
      const { app, submit, send } = await installation(failed);
      // A former reader of another assistant can work out its failed turn's retry ID.
      const taken = await retryRequestId("shared", "u2", "run-1");
      const other = await localLogin(app, origin, "two");
      const reserve = await app.inject({ method: "POST", url: "/api/bots/other/messages", headers: other,
        payload: { requestId: taken, text: "Hello", attachments: [] } });
      expect(reserve.statusCode).toBe(400);
      for (const requestId of [randomUUID(), await retryRequestId("shared", "u2", "run-0"), await retryRequestId("other", "u2", "run-1"),
        await retryRequestId("shared", "u1", "run-1"), taken.toUpperCase()]) {
        const refused = await send({ requestId, text: "Order more feed", retryOf: "u2" });
        expect(refused.statusCode).toBe(400);
        expect((await app.inject({ url: `/api/submissions/${requestId}`, headers: other })).json().status).toBe("uncertain");
      }
      expect(submit).not.toHaveBeenCalled();
      // The owner's retry still gets the turn.
      const sent = await send({ text: "Order more feed", retryOf: "u2" });
      expect(sent.json()).toMatchObject({ requestId: taken, status: "accepted" });
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("admits only one of two retries that arrive together, whichever claims the turn first", async () => {
      let open!: () => void;
      const gate = new Promise<void>(resolve => { open = resolve; });
      const { submit, read, send } = await installation(failed);
      const reading = read.getMockImplementation()!;
      // Both reads are in flight before either request claims the turn.
      read.mockImplementation(async (...args) => { await gate; return reading(...args); });
      const both = Promise.all([send({ text: "Order more feed", retryOf: "u2" }), send({ text: "Order more feed", retryOf: "u2" })]);
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      open();
      const receipts = (await both).map(response => response.json());
      expect(submit).toHaveBeenCalledTimes(1);
      expect(receipts[0].requestId).toBe(receipts[1].requestId);
    });

    it("lets another person's retry of the same failure follow it and see its receipt", async () => {
      const { app, submit, send } = await installation(failed);
      const first = (await send({ text: "Order more feed", retryOf: "u2" })).json();
      const other = await localLogin(app, origin, "two");
      for (const text of ["Order more feed", "Order more feed "]) {
        const followed = await send({ text, retryOf: "u2" }, "messages", other);
        expect(followed.statusCode).toBe(200);
        expect(followed.json()).toMatchObject({ requestId: first.requestId, status: "accepted" });
      }
      expect(submit).toHaveBeenCalledTimes(1);
      expect((await app.inject({ url: `/api/submissions/${first.requestId}`, headers: other })).json()).toMatchObject({ status: "accepted", runId: "run" });
      // An ordinary message's receipt stays its sender's.
      const own = (await send({ text: "Something else" })).json();
      expect((await app.inject({ url: `/api/submissions/${own.requestId}`, headers: other })).json().status).toBe("uncertain");
    });

    it("tells every reader of the failed conversation about the claim, and takes a new retry once the retried message fails again", async () => {
      const { app, headers, submit, read, send } = await installation(failed);
      const first = (await send({ text: "Order more feed", retryOf: "u2" })).json();
      const page = (await app.inject({ url: "/api/bots/shared/conversation?turns=20", headers })).json();
      expect(page.retry).toEqual({ ...first, retryOf: "u2" });
      // Hermes ran the retried message as a new one, which failed in its own run.
      const again = [...history, { id: "u3", role: "user" as const, text: "Order more feed" }];
      read.mockImplementation(async (botId: string) => conversationFixture({ botId, messages: again, activity: { state: "failed", runId: "run-2" } }));
      expect((await app.inject({ url: "/api/bots/shared/conversation?turns=20", headers })).json()).not.toHaveProperty("retry");
      const next = (await send({ requestId: await retryRequestId("shared", "u3", "run-2"), text: "Order more feed", retryOf: "u3" })).json();
      expect(next.requestId).not.toBe(first.requestId);
      expect(submit).toHaveBeenCalledTimes(2);
    });

    it("answers two people retrying with the same ID at once with one receipt, admitting once", async () => {
      let open!: () => void;
      const gate = new Promise<void>(resolve => { open = resolve; });
      const { app, submit, read, send } = await installation(failed);
      const other = await localLogin(app, origin, "two");
      const reading = read.getMockImplementation()!;
      // Both pass the receipt lookup before either claims the turn.
      read.mockImplementation(async (...args) => { await gate; return reading(...args); });
      const both = Promise.all([send({ text: "Order more feed", retryOf: "u2" }), send({ text: "Order more feed", retryOf: "u2" }, "messages", other)]);
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      open();
      const responses = await both;
      expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
      expect(responses[1].json()).toEqual(responses[0].json());
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("lets another person recover an unconfirmed retry, sending the original request as its original sender", async () => {
      const submit = vi.fn(async (input: Submission) => ({ requestId: input.requestId, status: "uncertain" as const }));
      const lookupSubmission = vi.fn(async () => null);
      const { app, send } = await installation(failed, { submit, lookupSubmission });
      const first = (await send({ text: "Order more feed", retryOf: "u2" })).json();
      expect(first.status).toBe("uncertain");
      const other = await localLogin(app, origin, "two");
      // Without review, it only follows the recorded request.
      expect((await send({ text: "Order more feed ", retryOf: "u2" }, "messages", other)).json()).toEqual(first);
      expect(submit).toHaveBeenCalledTimes(1);
      const recovered = await send({ text: "Order more feed ", retryOf: "u2", reviewedUncertain: true }, "messages", other);
      expect(recovered.statusCode).toBe(200);
      expect(lookupSubmission).toHaveBeenCalledWith(first.requestId);
      expect(submit).toHaveBeenCalledTimes(2);
      expect(submit.mock.calls[1][0]).toEqual(submit.mock.calls[0][0]);
      expect(submit.mock.calls[1][0]).toMatchObject({ senderId: "local-one", text: "Order more feed", requestId: first.requestId });
    });

    it("keeps an unconfirmed retry unsent when Hermes cannot look requests up, whoever reviews it", async () => {
      let supported = true;
      const submit = vi.fn(async (input: Submission) => ({ requestId: input.requestId, status: "uncertain" as const }));
      const { app, send } = await installation(failed, { submit,
        capabilities: async () => capabilitiesFixture({ chat: { supported: true }, steering: { supported: true }, idempotency: { supported } }) });
      await send({ text: "Order more feed", retryOf: "u2" });
      supported = false;
      const other = await localLogin(app, origin, "two");
      expect((await send({ text: "Order more feed", retryOf: "u2", reviewedUncertain: true }, "messages", other)).statusCode).toBe(409);
      expect(submit).toHaveBeenCalledTimes(1);
    });
  });
});

