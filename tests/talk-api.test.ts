import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { MintLimit, spokenReplies, spokenText, talkAnswer, talkPersona } from "../src/server/talk.js";
import type { Bot, Conversation, ConversationOptions, RealtimeSessionInput, Submission, SubmissionReceipt } from "../src/shared/types.js";
import { botFixture, capabilitiesFixture, conversationFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime, localLogin } from "./helpers/server.js";

const origin = "http://127.0.0.1:3000";
const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => { vi.useRealTimers(); for (const app of apps.splice(0)) await app.close(); });

const ranch = botFixture({ id: "ranch", name: "Ranch Hand", description: "Keeps the ranch running." });
// Another member's personal assistant, whose name must never reach a voice session.
const secret = botFixture({ id: "zq-ledger", name: "Moonlit Saddle Ledger", shared: false, ownerId: "local-two" });
const on = { supported: true };

async function setup(options: { native?: boolean; conversation?: (options?: ConversationOptions) => Conversation; receipt?: (input: Submission) => SubmissionReceipt;
  lookup?: (requestId: string) => SubmissionReceipt | null } = {}) {
  const bots: Bot[] = [ranch, secret];
  const realtimeSession = vi.fn(async (input: RealtimeSessionInput) => ({ clientSecret: "ek_fixture", expiresAt: 1_790_000_000, model: "gpt-realtime-2.1", voice: input.voice }));
  const submit = vi.fn(async (input: Submission): Promise<SubmissionReceipt> => options.receipt?.(input) ?? { requestId: input.requestId, status: "accepted", runId: "run-talk" });
  const setVoice = vi.fn(async () => {});
  let conversation = options.conversation ?? (() => conversationFixture({ botId: "ranch" }));
  const listeners = new Set<(kind?: "inflight") => void>();
  const runtime = fakeRuntime({
    status: async () => ({ connected: true }),
    capabilities: async () => capabilitiesFixture({ chat: on, steering: on, idempotency: on, liveVoice: on, avatarMetadata: { supported: options.native ?? true } }),
    listBots: async () => bots, canonicalSubmit: async () => true,
    conversation: async (_botId, read) => conversation(read), submit, steer: submit, lookupSubmission: async requestId => options.lookup?.(requestId) ?? null,
    realtimeSession, setVoice,
    watch: (_botId, listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    close: async () => {},
  });
  const { app, store } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), runtime, { background: false });
  apps.push(app);
  store.savePresentation(secret.id, { shared: false, ownerId: "local-two" });
  const one = await localLogin(app, origin, "one"), two = await localLogin(app, origin, "two");
  return { app, store, bots, one, two, realtimeSession, submit, setVoice,
    setConversation(next: (options?: ConversationOptions) => Conversation) { conversation = next; for (const listener of listeners) listener(); } };
}

describe("talk session", () => {
  it("builds a no-store session with the default voice, this assistant's persona and its one tool", async () => {
    const s = await setup();
    const response = await s.app.inject({ method: "POST", url: "/api/bots/ranch/talk/session", headers: s.one });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ clientSecret: "ek_fixture", expiresAt: 1_790_000_000, model: "gpt-realtime-2.1", voice: "marin" });
    const input = s.realtimeSession.mock.calls[0]![0];
    expect(input.voice).toBe("marin");
    expect(input.instructions).toContain("Ranch Hand");
    expect(input.instructions).toContain("Keeps the ranch running.");
    expect(input.instructions).not.toContain(secret.name);
    expect(input.instructions).not.toContain(secret.id);
    expect(input.tools).toEqual([expect.objectContaining({ type: "function", name: "ask_assistant",
      parameters: expect.objectContaining({ required: ["request"] }) })]);
  });

  it("speaks with the saved voice, kept in Hermes or in the app's store", async () => {
    for (const native of [true, false]) {
      const s = await setup({ native });
      const saved = await s.app.inject({ method: "PUT", url: "/api/bots/ranch/voice", headers: s.one, payload: { voice: "cedar" } });
      expect(saved.json()).toEqual({ voice: "cedar" });
      if (native) {
        expect(s.setVoice).toHaveBeenCalledWith("ranch", "cedar");
        // Hermes now reports it with the profile.
        s.bots[0] = { ...ranch, voice: "cedar" };
      } else expect(s.setVoice).not.toHaveBeenCalled();
      expect((await s.app.inject({ method: "GET", url: "/api/bots", headers: s.one })).json()[0].voice).toBe("cedar");
      await s.app.inject({ method: "POST", url: "/api/bots/ranch/talk/session", headers: s.one });
      expect(s.realtimeSession.mock.calls[0]![0].voice).toBe("cedar");
      expect((await s.app.inject({ method: "PUT", url: "/api/bots/ranch/voice", headers: s.one, payload: { voice: "nova" } })).statusCode).toBe(400);
    }
  });

  it("refuses another member's personal assistant as if it did not exist", async () => {
    const s = await setup();
    for (const [method, url, payload] of [["POST", "/api/bots/zq-ledger/talk/session", undefined], ["POST", "/api/bots/zq-ledger/talk/ask", { requestId: randomUUID(), request: "Hi" }],
      ["PUT", "/api/bots/zq-ledger/voice", { voice: "ash" }]] as const) {
      const response = await s.app.inject({ method, url, headers: s.one, ...(payload ? { payload } : {}) });
      expect(response.statusCode, url).toBe(404);
    }
    expect(s.realtimeSession).not.toHaveBeenCalled();
    expect(s.submit).not.toHaveBeenCalled();
    expect((await s.app.inject({ method: "POST", url: "/api/bots/zq-ledger/talk/session", headers: s.two })).statusCode).toBe(200);
  });

  it("allows one mint per person every few seconds and caps them each hour", () => {
    let now = 0;
    const limit = new MintLimit(() => now);
    limit.take("one");
    expect(() => limit.take("one")).toThrow(/already starting/);
    limit.take("two");
    for (let index = 1; index < 20; index++) { now += 6_000; limit.take("one"); }
    now += 6_000;
    expect(() => limit.take("one")).toThrow(/many times this hour/);
    now += 3_600_000;
    limit.take("one");
  });

  it("answers 429 to a second start right away", async () => {
    const s = await setup();
    expect((await s.app.inject({ method: "POST", url: "/api/bots/ranch/talk/session", headers: s.one })).statusCode).toBe(200);
    expect((await s.app.inject({ method: "POST", url: "/api/bots/ranch/talk/session", headers: s.one })).statusCode).toBe(429);
    expect(s.realtimeSession).toHaveBeenCalledTimes(1);
  });
});

const run = (messages: Conversation["messages"], activity: Conversation["activity"] = { state: "idle" }, changes: Partial<Conversation> = {}) =>
  conversationFixture({ botId: "ranch", messages, activity, ...changes });
// The add-on names a person's message by its request ID.
const asked = (id = "r", runId = "run-talk") => ({ id, runId, role: "user" as const, text: "What's the weather?" });
const said = (id: string, text: string, runId = "run-talk") => ({ id, runId, role: "assistant" as const, text });
/** A history read as Hermes cuts it: from the start message when it is there, else the latest turns. */
const anchored = (messages: Conversation["messages"]) => (options?: ConversationOptions) => {
  const at = messages.findIndex(message => message.id === options?.window?.start);
  return run(at >= 0 ? messages.slice(at) : messages.slice(-2));
};
const ask = (s: Awaited<ReturnType<typeof setup>>, requestId: string, request = "What's the weather?") =>
  s.app.inject({ method: "POST", url: "/api/bots/ranch/talk/ask", headers: s.one, payload: { requestId, request } });
async function fakeTime() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // The request reaches its wait through real I/O turns, so time moves a step at a time between them.
  return async (ms: number) => { for (let left = ms; left > 0; left -= 500) { await new Promise(resolve => setImmediate(resolve)); await vi.advanceTimersByTimeAsync(Math.min(500, left)); } };
}

describe("talk ask", () => {
  it("sends once per request ID as the speaker, and returns the run's reply", async () => {
    const requestId = randomUUID();
    const s = await setup({ conversation: () => run([asked(requestId), said("reply-1", "Sunny and 72.")]) });
    for (let attempt = 0; attempt < 2; attempt++) expect((await ask(s, requestId)).json()).toEqual({ state: "done", text: "Sunny and 72." });
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(s.submit.mock.calls[0]![0]).toMatchObject({ requestId, botId: "ranch", senderId: "local-one", text: "What's the weather?", attachments: [] });
    // The same ID with other words is a different request and is refused.
    expect((await ask(s, requestId, "Something else")).statusCode).toBe(409);
  });

  it("answers working after the wait, then the reply once the run settles", async () => {
    const requestId = randomUUID();
    let state = run([asked(requestId)], { state: "working", runId: "run-talk" });
    const s = await setup({ conversation: () => state });
    const pass = await fakeTime();
    const first = ask(s, requestId);
    await pass(21_000);
    expect((await first).json()).toEqual({ state: "working" });
    const second = ask(s, requestId);
    await pass(500);
    // A change notice ends the wait at once.
    s.setConversation(() => state = run([asked(requestId), said("reply-1", "Rain later.")]));
    await new Promise(resolve => setImmediate(resolve));
    expect((await second).json()).toEqual({ state: "done", text: "Rain later." });
    expect(s.submit).toHaveBeenCalledTimes(1);
  });

  it("maps rejected receipts to refused", async () => {
    const s = await setup({ receipt: input => ({ requestId: input.requestId, status: "rejected", message: "Images cannot be added." }) });
    expect((await ask(s, randomUUID(), "Hello")).json()).toEqual({ state: "refused", text: "Images cannot be added." });
  });

  it("finds an old request after later turns, and gives up on one that is gone", async () => {
    const requestId = randomUUID();
    const later = [1, 2, 3].flatMap(turn => [asked(`later-${turn}`, `run-${turn}`), said(`answer-${turn}`, `Later answer ${turn}.`, `run-${turn}`)]);
    const s = await setup({ conversation: anchored([asked(requestId), said("reply-1", "Sunny and 72."), ...later]) });
    expect((await ask(s, requestId)).json()).toEqual({ state: "done", text: "Sunny and 72." });
    // Hermes no longer holds the message, as after a reset: no read finds it.
    s.setConversation(anchored(later));
    const pass = await fakeTime();
    const gone = ask(s, requestId);
    await pass(21_000);
    expect((await gone).json()).toEqual({ state: "working" });
    const again = ask(s, requestId);
    await pass(21_000);
    expect((await again).json()).toMatchObject({ state: "refused", text: expect.stringContaining("no longer in the chat") });
  });

  it("honors Hermes's interrupted receipt, even once another run has started", async () => {
    const requestId = randomUUID();
    let receipt: SubmissionReceipt | null = null;
    // The interrupted run left partial text; then someone else's message started a new run.
    const s = await setup({ lookup: () => receipt, conversation: () => run([asked(requestId), said("partial", "Checking the gat"),
      asked("someone-else", "run-next")], { state: "working", runId: "run-next" }) });
    receipt = { requestId, status: "interrupted", runId: "run-talk" };
    expect((await ask(s, requestId)).json()).toEqual({ state: "interrupted" });
  });
});

describe("talk answer states", () => {
  const accepted: SubmissionReceipt = { requestId: "r", status: "accepted", runId: "run-talk" };
  it("names approvals, questions and interruptions of this run", () => {
    expect(talkAnswer(accepted, run([asked()], { state: "waiting", runId: "run-talk" }, { approvals: [{ id: "a", title: "Run a command?", detail: "", status: "pending" }] })))
      .toEqual({ state: "needsApproval", text: "Run a command?" });
    expect(talkAnswer(accepted, run([asked()], { state: "blocked", runId: "run-talk" }, { attention: [{ id: "q", kind: "clarify", title: "Which gate?", detail: "" }] })))
      .toEqual({ state: "needsAnswer", text: "Which gate?" });
    expect(talkAnswer(accepted, run([asked()], { state: "interrupted", runId: "run-talk" }))).toEqual({ state: "interrupted" });
    expect(talkAnswer({ ...accepted, status: "interrupted" }, run([]))).toEqual({ state: "interrupted" });
    // Hermes can report an interruption without naming its run: the request's own turn is the latest.
    expect(talkAnswer(accepted, run([asked(), said("partial", "Checking the gat")], { state: "interrupted" }))).toEqual({ state: "interrupted" });
  });
  it("keeps waiting while the run is unseen or running, and ignores other runs and unfinished text", () => {
    expect(talkAnswer(accepted, run([]))).toBe("missing");
    expect(talkAnswer(accepted, run([], { state: "thinking", runId: "run-talk" }))).toBeUndefined();
    expect(talkAnswer(accepted, run([asked(), said("x-inflight", "Partial")], { state: "thinking", runId: "run-talk" }))).toBeUndefined();
    expect(talkAnswer({ ...accepted, status: "uncertain" }, run([]))).toBeUndefined();
    const settled = run([said("old", "Old answer", "run-old"), asked(), said("r1", "First."), said("r2", "Second.")]);
    expect(talkAnswer(accepted, settled)).toEqual({ state: "done", text: "First.\n\nSecond." });
    expect(talkAnswer(accepted, run([asked()], { state: "failed" }))).toEqual({ state: "refused", text: "The assistant could not finish this request." });
  });
  it("speaks only replies after a steered request, keeping the latest when they are long", () => {
    // A steer joins the running turn, whose earlier replies answered the first question.
    const steered = run([asked("first"), said("r0", "Here is the feed plan."), asked("r"), said("r1", "x ".repeat(2500)), said("r2", "Corrected: feed at six.")]);
    const answer = talkAnswer(accepted, steered) as { text: string };
    expect(answer.text).not.toContain("feed plan");
    expect(answer.text).toMatch(/^Corrected: feed at six\. Earlier parts are in the chat\.$/);
    expect(spokenReplies(["One.", "Two."])).toBe("One.\n\nTwo.");
  });
  it("cuts long replies at a sentence and points to the chat", () => {
    const long = "Hay is in. ".repeat(500);
    const spoken = spokenText(long);
    expect(spoken.length).toBeLessThanOrEqual(4000);
    expect(spoken).toMatch(/Hay is in\. The rest is in the chat\.$/);
    expect(spokenText("  Short.  ")).toBe("Short.");
  });
  it("describes only the assistant it speaks for", () => {
    const persona = talkPersona({ name: "Ranch\u0000 Hand\u202e", description: "x".repeat(1000) });
    expect(persona).toContain("Ranch Hand");
    expect(persona).not.toMatch(/[\u0000\u202e]/);
    expect(persona).not.toContain("x".repeat(401));
  });
});
