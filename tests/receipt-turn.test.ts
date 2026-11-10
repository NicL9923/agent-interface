import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { retryRequestId } from "../src/shared/retry-id.js";
import type { Runtime, Submission, SubmissionReceipt } from "../src/shared/types.js";
import { botFixture, capabilitiesFixture, conversationFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime, localLogin } from "./helpers/server.js";

// What Hermes's admission answer said about a send's turn lives on the receipt, wherever the server keeps or returns one.
const origin = "http://127.0.0.1:3000";
const capabilities = capabilitiesFixture({ chat: { supported: true }, steering: { supported: true }, idempotency: { supported: true } });
const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const admitted = { turn: "queued", admittedVersion: "boot:0:7" } as const;

async function installation(overrides: Partial<Runtime> = {}) {
  const submit = vi.fn(async (input: Submission): Promise<SubmissionReceipt> => ({ requestId: input.requestId, status: "accepted", runId: "run", ...admitted }));
  const runtime = fakeRuntime({
    listBots: async () => [botFixture()], capabilities: async () => capabilities, submit,
    conversation: async botId => conversationFixture({ botId, messages: [{ id: "u1", role: "user", text: "Order more feed" }], activity: { state: "failed", runId: "run-1" } }),
    close: async () => {}, ...overrides,
  });
  const result = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), runtime, { background: false });
  apps.push(result.app);
  const headers = await localLogin(result.app, origin);
  const send = (payload: Record<string, unknown>) =>
    result.app.inject({ method: "POST", url: "/api/bots/shared/messages", headers, payload: { attachments: [], ...payload } });
  const check = async (requestId: string) => (await result.app.inject({ url: `/api/submissions/${requestId}`, headers })).json() as SubmissionReceipt;
  return { ...result, submit, send, check };
}

describe("the admission's turn on a receipt", () => {
  it("answers a send with it, keeps it on the recorded receipt, and answers a repeat of the request from there", async () => {
    const { submit, send, store } = await installation();
    const requestId = randomUUID();
    expect((await send({ requestId, text: "Hello" })).json()).toMatchObject({ status: "accepted", ...admitted });
    expect(store.submission(requestId)!.receipt).toMatchObject(admitted);
    expect((await send({ requestId, text: "Hello" })).json()).toMatchObject({ status: "accepted", ...admitted });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  // A lookup never carries it, so a client whose answer was lost learns it from the recorded receipt.
  it("checks a recorded receipt with the turn the lookup cannot carry, only while both say accepted", async () => {
    let looked: SubmissionReceipt["status"] = "accepted";
    const { send, check } = await installation({ lookupSubmission: async requestId => ({ requestId, status: looked, runId: "run", steered: false }) });
    const requestId = randomUUID();
    await send({ requestId, text: "Hello" });
    expect(await check(requestId)).toMatchObject({ status: "accepted", steered: false, text: "Hello", ...admitted });
    // Hermes later settles the request otherwise; that is what the check reports, and a turn belongs only to an accepted one.
    looked = "interrupted";
    const settled = await check(requestId);
    expect(settled.status).toBe("interrupted");
    expect(settled).not.toHaveProperty("turn");
    expect(settled).not.toHaveProperty("admittedVersion");
  });

  it("does not take a turn from a receipt recorded before it was accepted", async () => {
    const { send, check } = await installation({
      submit: async input => ({ requestId: input.requestId, status: "uncertain", ...admitted }),
      lookupSubmission: async requestId => ({ requestId, status: "accepted", runId: "run" }),
    });
    const requestId = randomUUID();
    await send({ requestId, text: "Hello" });
    const checked = await check(requestId);
    expect(checked.status).toBe("accepted");
    expect(checked).not.toHaveProperty("turn");
  });

  it("answers a later retry of the same failed turn with the first retry's recorded receipt, turn included", async () => {
    const { submit, send } = await installation();
    const requestId = await retryRequestId("shared", "u1", "run-1");
    expect((await send({ requestId, text: "Order more feed", retryOf: "u1" })).json()).toMatchObject(admitted);
    // Another device copied the text differently: it follows the first retry's receipt.
    expect((await send({ requestId, text: "Order more feed ", retryOf: "u1" })).json()).toMatchObject({ requestId, ...admitted });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
