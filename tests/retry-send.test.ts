import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
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
  const send = (payload: Record<string, unknown>, path = "messages") =>
    result.app.inject({ method: "POST", url: `/api/bots/shared/${path}`, headers, payload: { requestId: randomUUID(), attachments: [], ...payload } });
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
    const requestId = randomUUID();
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
});
