import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import type { ActivityState, Message, Runtime, Submission } from "../src/shared/types.js";
import {
  botFixture,
  capabilitiesFixture,
  conversationFixture,
} from "./helpers/runtime-fixtures.js";
import { fakeRuntime, localLogin } from "./helpers/server.js";

// A reaction answers the reply it names in `answering`, and only while that reply still ends the chat.
// docs/native-api.md#reaction-answers is the contract these cases hold the server to.
const origin = "http://127.0.0.1:3000";
const capabilities = capabilitiesFixture({
  chat: { supported: true },
  steering: { supported: true },
  idempotency: { supported: true },
});
const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const north: Message[] = [
  { id: "u1", role: "user", text: "Check the gates" },
  { id: "a1", role: "assistant", text: "Open the north gate?" },
];
async function installation(
  read: { messages?: Message[]; state?: ActivityState } = {},
  overrides: Partial<Runtime> = {},
) {
  const submit = vi.fn(async (input: Submission) => ({
    requestId: input.requestId,
    status: "accepted" as const,
    runId: "run",
  }));
  const chat = { messages: read.messages ?? north, state: read.state ?? "done" };
  const conversation = vi.fn(async (botId: string) =>
    conversationFixture({
      botId,
      messages: chat.messages,
      activity: { state: chat.state, ...(chat.state === "working" ? { runId: "run" } : {}) },
    }),
  );
  const runtime = fakeRuntime({
    listBots: async () => [botFixture()],
    capabilities: async () => capabilities,
    conversation,
    submit,
    lookupSubmission: async () => null,
    close: async () => {},
    ...overrides,
  });
  const result = await createApp(
    loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }),
    runtime,
    { background: false },
  );
  apps.push(result.app);
  const headers = await localLogin(result.app, origin);
  const put = (text: string) =>
    result.app.inject({
      method: "PUT",
      url: "/api/bots/shared/draft",
      headers,
      payload: { text, attachments: [] },
    });
  const draft = async () =>
    (await result.app.inject({ url: "/api/bots/shared/draft", headers })).json();
  const send = (payload: Record<string, unknown>, path = "messages") =>
    result.app.inject({
      method: "POST",
      url: `/api/bots/shared/${path}`,
      headers,
      payload: { requestId: randomUUID(), attachments: [], ...payload },
    });
  return { ...result, chat, conversation, submit, headers, put, draft, send };
}

describe("reaction answers at admission", () => {
  it("admits an answer to the reply that ends the chat, read fresh, and leaves the sender's draft alone", async () => {
    const { conversation, submit, put, draft, send } = await installation();
    // The reported case: a saved 👍 draft was cleared and marked sent when a picker 👍 was accepted.
    await put("👍");
    const before = await draft();
    const sent = await send({ text: "👍", answering: "a1" });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().status).toBe("accepted");
    // A history read other callers share could be seconds old, so the guard reads the end itself.
    expect(conversation).toHaveBeenCalledWith(
      "shared",
      expect.objectContaining({ window: { turns: 1 }, fresh: true }),
    );
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ text: "👍", answering: "a1", senderId: "local-one" }),
    );
    expect(await draft()).toEqual(before);
  });

  it("leaves an empty draft's revision alone, so a save racing the answer is not taken for a sent copy", async () => {
    const { draft, send } = await installation();
    const before = await draft();
    expect((await send({ text: "❤️", answering: "a1" })).json().status).toBe("accepted");
    expect(await draft()).toEqual(before);
  });

  it("leaves the draft alone when an uncertain answer is later confirmed", async () => {
    const lookupSubmission = vi.fn(async (requestId: string) => ({
      requestId,
      status: "accepted" as const,
    }));
    const { app, headers, put, draft, send } = await installation(
      {},
      {
        submit: async (input) => ({ requestId: input.requestId, status: "uncertain" }),
        lookupSubmission,
      },
    );
    await put("👍");
    const before = await draft();
    const sent = await send({ text: "👍", answering: "a1" });
    expect(sent.json().status).toBe("uncertain");
    const checked = await app.inject({ url: `/api/submissions/${sent.json().requestId}`, headers });
    expect(checked.json().status).toBe("accepted");
    expect(await draft()).toEqual(before);
  });

  it("refuses with answer_stale, sending nothing, once another message ends the chat", async () => {
    // One member still sees "Open the north gate?" while the chat has moved on to the south gate.
    const { submit, send } = await installation({
      messages: [
        ...north,
        { id: "u2", role: "user", text: "Actually, the south one" },
        { id: "a2", role: "assistant", text: "Open the south gate?" },
      ],
    });
    const sent = await send({ text: "👍", answering: "a1" });
    expect(sent.statusCode).toBe(409);
    expect(sent.json().code).toBe("answer_stale");
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses with answer_stale while a turn runs, even when the reply still ends the chat", async () => {
    const { submit, send } = await installation({ state: "working" });
    const sent = await send({ text: "👍", answering: "a1" });
    expect(sent.statusCode).toBe(409);
    expect(sent.json().code).toBe("answer_stale");
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses with answer_stale when the named reply is not in the chat at all", async () => {
    const { submit, send } = await installation();
    const sent = await send({ text: "👍", answering: "elsewhere" });
    expect(sent.statusCode).toBe(409);
    expect(sent.json().code).toBe("answer_stale");
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses with answer_stale when the chat is empty", async () => {
    const { submit, send } = await installation({ messages: [] });
    const sent = await send({ text: "👍", answering: "a1" });
    expect(sent.json().code).toBe("answer_stale");
    expect(submit).not.toHaveBeenCalled();
  });

  it("records nothing for a stale answer, so the same request admits once the person could answer again", async () => {
    const { chat, submit, send } = await installation({ state: "working" });
    const requestId = randomUUID();
    expect((await send({ requestId, text: "👍", answering: "a1" })).statusCode).toBe(409);
    chat.state = "done";
    const again = await send({ requestId, text: "👍", answering: "a1" });
    expect(again.json().status).toBe("accepted");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  // Each refusal names the field it is about, so a client that builds the request wrong learns why.
  it.each([
    [
      "text that is not one reaction",
      { text: "Yes, open it", answering: "a1" },
      "answering",
      "is exactly one of",
    ],
    ["two reactions", { text: "👍👍", answering: "a1" }, "answering", "is exactly one of"],
    [
      "files",
      {
        text: "👍",
        answering: "a1",
        attachments: [{ id: "body.signature", name: "gate.jpg", mime: "image/jpeg", size: 1 }],
      },
      "answering",
      "no files",
    ],
    [
      "a draft revision",
      { text: "👍", answering: "a1", draftBaseRevision: 3 },
      "answering",
      "not written on a draft",
    ],
    ["a retry", { text: "👍", answering: "a1", retryOf: "u1" }, "answering", "not a retry"],
    ["an empty reply ID", { text: "👍", answering: "" }, "answering", ""],
  ])("refuses an answer with %s as invalid", async (_case, payload, field, reason) => {
    const { conversation, submit, send } = await installation();
    const sent = await send(payload);
    expect(sent.statusCode).toBe(400);
    expect(sent.json().details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: [field], message: expect.stringContaining(reason) }),
      ]),
    );
    expect(conversation).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses an answer sent as a steer, which would join a running turn", async () => {
    const { submit, send } = await installation();
    const sent = await send({ text: "👍", answering: "a1" }, "steer");
    expect(sent.statusCode).toBe(400);
    expect(sent.json().error).toBe("Answer a reply by sending, not by steering");
    expect(submit).not.toHaveBeenCalled();
  });

  it("sends an ordinary emoji message without answering as before, with no fresh read", async () => {
    const { conversation, submit, put, draft, send } = await installation({
      messages: [...north, { id: "u2", role: "user", text: "Thanks" }],
    });
    await put("👍");
    // Typed in the composer, it is a message like any other: no guard reads, and it clears its draft.
    const sent = await send({ text: "👍", draftBaseRevision: (await draft()).revision });
    expect(sent.json().status).toBe("accepted");
    expect(conversation).not.toHaveBeenCalledWith(
      "shared",
      expect.objectContaining({ fresh: true }),
    );
    expect(submit).toHaveBeenCalledWith(
      expect.not.objectContaining({ answering: expect.anything() }),
    );
    expect(await draft()).toMatchObject({ text: "", reason: "sent" });
  });
});
