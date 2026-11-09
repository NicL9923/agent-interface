import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { MintLimit, spokenProgress, spokenReplies, spokenText, talkAnswer, talkPersona, talkProgress } from "../src/server/talk.js";
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
/** A history read as Hermes cuts it: from the start message and `turns` user turns before it, else the latest turns. */
const anchored = (messages: Conversation["messages"], activity?: Conversation["activity"]) => (options?: ConversationOptions) => {
  let at = messages.findIndex(message => message.id === options?.window?.start);
  if (at < 0) return run(messages.slice(-2), activity);
  for (let turns = options?.window?.turns ?? 0; at > 0 && turns > 0;) if (messages[--at]!.role === "user") turns--;
  return run(messages.slice(at), activity);
};
const event = (kind: "completed" | "interrupted", runId = "run-talk") =>
  ({ id: `${runId}:${kind}`, botId: "ranch", runId, kind, title: `Hermes ${kind}`, occurredAt: new Date().toISOString() });
const ask = (s: Awaited<ReturnType<typeof setup>>, requestId: string, request = "What's the weather?", extra: Record<string, unknown> = {}) =>
  s.app.inject({ method: "POST", url: "/api/bots/ranch/talk/ask", headers: s.one, payload: { requestId, request, ...extra } });
const noted = (id: string, text: string, runId = "run-talk") => ({ ...said(id, text, runId), interim: true });
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

  it("follows a steered request's run to its reported ending, as its receipt settles at admission", async () => {
    const requestId = randomUUID();
    // Someone's question started run-talk; the spoken request steered it, then it was interrupted
    // with partial text, and another message started run-next.
    const history = [asked("first"), said("r0", "Here is the feed plan."), asked(requestId), said("partial", "Checking the gat"), asked("someone-else", "run-next")];
    // Hermes's receipt for a steer is terminal and accepted from admission on.
    const s = await setup({ lookup: id => id === requestId ? { requestId: id, status: "accepted", runId: "run-talk" } : null,
      conversation: anchored(history, { state: "working", runId: "run-next" }) });
    s.store.recordEvents([event("interrupted")], "1");
    expect((await ask(s, requestId)).json()).toEqual({ state: "interrupted" });
    // A finished steered run answers with what followed the request.
    const finished = randomUUID();
    s.setConversation(anchored([asked("first", "run-done"), said("d0", "Earlier."), asked(finished, "run-done"), said("d1", "Done now.", "run-done")]));
    s.store.recordEvents([event("completed", "run-done")], "2");
    s.submit.mockImplementationOnce(async input => ({ requestId: input.requestId, status: "accepted", runId: "run-done" }));
    expect((await ask(s, finished)).json()).toEqual({ state: "done", text: "Done now." });
  });

  it("never takes a steered run with no reported ending as finished", async () => {
    const requestId = randomUUID();
    const s = await setup({ conversation: anchored([asked("first"), said("r0", "Earlier."), asked(requestId), said("r1", "Gate is shut.")]) });
    const pass = await fakeTime();
    // Each ask waits about 20 seconds and keeps the request working while no ending is known.
    const first = ask(s, requestId);
    await pass(21_000);
    expect((await first).json()).toEqual({ state: "working" });
    let answer: unknown = { state: "working" };
    for (let i = 0; i < 10 && (answer as { state: string }).state === "working"; i++) {
      const next = ask(s, requestId);
      await pass(21_000);
      answer = (await next).json();
    }
    expect(answer).toMatchObject({ state: "refused", text: expect.stringContaining("could not confirm") });
  });

  it("reports a steered run's interruption discovered late", async () => {
    const requestId = randomUUID();
    const s = await setup({ conversation: anchored([asked("first"), said("r0", "Earlier."), asked(requestId), said("partial", "Checking the gat")]) });
    const pass = await fakeTime();
    const first = ask(s, requestId);
    await pass(21_000);
    expect((await first).json()).toEqual({ state: "working" });
    s.store.recordEvents([event("interrupted")], "1");
    const second = ask(s, requestId);
    await pass(3_000);
    expect((await second).json()).toEqual({ state: "interrupted" });
  });

  it("does not let unrelated work hide a lost request", async () => {
    const requestId = randomUUID();
    const s = await setup({ conversation: anchored([asked("other", "run-other")], { state: "working", runId: "run-other" }) });
    const pass = await fakeTime();
    const first = ask(s, requestId);
    await pass(21_000);
    expect((await first).json()).toEqual({ state: "working" });
    const second = ask(s, requestId);
    await pass(21_000);
    expect((await second).json()).toMatchObject({ state: "refused" });
  });

  it("restarts the missing wait whenever the request's own run shows", async () => {
    const requestId = randomUUID();
    const lost = anchored([asked("other", "run-other")]);
    const s = await setup({ conversation: lost });
    const pass = await fakeTime();
    const first = ask(s, requestId);
    await pass(21_000);
    expect((await first).json()).toEqual({ state: "working" });
    // The request's run is at work, though its message is not readable yet.
    s.setConversation(() => run([], { state: "working", runId: "run-talk" }));
    const second = ask(s, requestId);
    await pass(5_000);
    s.setConversation(lost);
    await pass(17_000);
    // Missing again for under 30 seconds since its run was seen: still waiting, not refused.
    expect((await second).json()).toEqual({ state: "working" });
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

describe("talk progress", () => {
  const accepted: SubmissionReceipt = { requestId: "r", status: "accepted", runId: "run-talk" };
  const working = { state: "working" as const, runId: "run-talk" };
  const none = new Set<string>();
  const same = (message: Conversation["messages"][number]) => message;
  it("returns every new line of the request's own turn, naming all of them and saying the newest", () => {
    const read = run([said("old-note", "Earlier.", "run-old"), asked(), noted("n1", "I'll check the forecast."), noted("n2", "Now the radar."), noted("other", "Someone else's.", "run-other")], working);
    expect(talkProgress(accepted, read, same, none)).toEqual({ ids: ["n1", "n2"], text: "Now the radar." });
  });
  it("leaves out lines already heard, and says nothing when none is new", () => {
    const read = run([asked(), noted("n1", "I'll check the forecast."), noted("n2", "Now the radar.")], working);
    expect(talkProgress(accepted, read, same, new Set(["n1"]))).toEqual({ ids: ["n2"], text: "Now the radar." });
    expect(talkProgress(accepted, read, same, new Set(["n1", "n2"]))).toBeUndefined();
    // An ID the conversation never had is ignored, not an error.
    expect(talkProgress(accepted, read, same, new Set(["nope", "n1", "n2"]))).toBeUndefined();
  });
  it("gives a steer's lines to the steer only: the earlier request in the same run stops at the next person's message", () => {
    const read = run([asked("first"), noted("n1", "For the first."), asked("r"), noted("n2", "For the steer.")], working);
    // The first request's turn ends where the steer begins, whichever receipt asks.
    expect(talkProgress({ requestId: "first", status: "accepted", runId: "run-talk" }, read, same, none)).toEqual({ ids: ["n1"], text: "For the first." });
    expect(talkProgress(accepted, read, same, none)).toEqual({ ids: ["n2"], text: "For the steer." });
  });
  it("ignores an answer, an earlier turn's lines, a line before the request and a request not yet readable", () => {
    expect(talkProgress(accepted, run([asked(), said("a", "The answer.")], working), same, none)).toBeUndefined();
    expect(talkProgress(accepted, run([noted("before", "Before it."), asked(), said("a", "x")], working), same, none)).toBeUndefined();
    // A steer joins a run an earlier message started: that message's lines answered something else.
    const steered = run([asked("first"), noted("early", "For the first question."), asked("r"), noted("mine", "For the steer.")], working);
    expect(talkProgress(accepted, steered, same, none)).toEqual({ ids: ["mine"], text: "For the steer." });
    expect(talkProgress(accepted, run([], working), same, none)).toBeUndefined();
    // The unsaved tail is not a saved line.
    expect(talkProgress(accepted, run([asked(), noted("sid-inflight", "Still arriving")], working), same, none)).toBeUndefined();
  });
  it("never counts activity rows or empty lines, and takes lines of a request without a run ID by position", () => {
    const diagnostic = { ...noted("d", "Retrying delivery."), origin: { kind: "diagnostic" as const, visibility: "activity" as const } };
    expect(talkProgress(accepted, run([asked(), diagnostic, noted("blank", "   ")], working), same, none)).toBeUndefined();
    const legacy = run([asked("r", "run-x"), noted("n1", "Checking.", "run-x"), asked("next", "run-y"), noted("n2", "Another's.", "run-y")], { state: "working" });
    expect(talkProgress({ requestId: "r", status: "accepted" }, legacy, same, none)).toEqual({ ids: ["n1"], text: "Checking." });
  });
  it("says what this person may read: the redaction applies to the line", () => {
    const read = run([asked(), noted("n1", "Checking the vault password hunter2.")], working);
    expect(talkProgress(accepted, read, message => ({ ...message, text: message.text.replace("hunter2", "[hidden]") }), none)?.text).toBe("Checking the vault password [hidden].");
  });
  it("makes plain, short speech from Markdown, cutting a long line at a sentence", () => {
    expect(spokenProgress("I'll check **Search Console** and [the site](https://example.invalid) first.")).toBe("I'll check Search Console and the site first.");
    expect(spokenProgress("Short.\n\nWith  a   break.")).toBe("Short. With a break.");
    const long = "I rechecked the existing setup. ".repeat(20);
    const spoken = spokenProgress(long);
    expect(spoken.length).toBeLessThanOrEqual(280);
    expect(spoken.endsWith("setup.")).toBe(true);
    expect(spokenProgress("word ".repeat(200)).length).toBeLessThanOrEqual(280);
    expect(spokenProgress("```\ncode\n```")).not.toContain("`");
    expect(spokenProgress("  \u200b ")).toBe("");
  });
  it("skips a line that has no words to say, but still names it as heard", () => {
    const read = run([asked(), noted("n1", "I'll check."), noted("blank", "\u200b")], working);
    expect(talkProgress(accepted, read, same, none)).toEqual({ ids: ["n1", "blank"], text: "I'll check." });
    expect(talkProgress(accepted, run([asked(), noted("blank", "\u200b")], working), same, none)).toBeUndefined();
  });
});

describe("talk ask with progress", () => {
  it("returns working with the new line as soon as it exists, without waiting for the answer", async () => {
    const requestId = randomUUID();
    let state = run([asked(requestId)], { state: "working", runId: "run-talk" });
    const s = await setup({ conversation: () => state });
    const pass = await fakeTime();
    const first = ask(s, requestId);
    await pass(2_000);
    // The line is saved while the run is still working, and a structural change reaches the waiting ask.
    s.setConversation(() => state = run([asked(requestId), noted("n1", "I'll check the forecast first.")], { state: "working", runId: "run-talk" }));
    await new Promise(resolve => setImmediate(resolve));
    const early = await first;
    expect(early.json()).toEqual({ state: "working", progress: { ids: ["n1"], text: "I'll check the forecast first." } });
    expect(early.headers["cache-control"]).toBe("no-store");
    // Asking again with the line heard waits as before.
    const next = ask(s, requestId, "What's the weather?", { heard: ["n1"] });
    await pass(21_000);
    expect((await next).json()).toEqual({ state: "working" });
    // The request was sent once, whatever was asked after it.
    expect(s.submit).toHaveBeenCalledTimes(1);
  });
  it("answers at once with only the answer when it is already there beside progress lines", async () => {
    const requestId = randomUUID();
    const s = await setup({ conversation: () => run([asked(requestId), noted("n1", "I'll check."), said("a", "Sunny, 75.")]) });
    expect((await ask(s, requestId)).json()).toEqual({ state: "done", text: "Sunny, 75." });
  });
  it("returns a line already saved at the first ask, and never repeats one the client heard", async () => {
    const requestId = randomUUID();
    const s = await setup({ conversation: () => run([asked(requestId), noted("n1", "I'll check."), noted("n2", "Now the radar.")], { state: "working", runId: "run-talk" }) });
    expect((await ask(s, requestId)).json()).toEqual({ state: "working", progress: { ids: ["n1", "n2"], text: "Now the radar." } });
    // One new line after n1 is what is said, and a repeat of the same ask returns the same, as it is stateless.
    const again = await ask(s, requestId, "What's the weather?", { heard: ["n1"] });
    expect(again.json()).toEqual({ state: "working", progress: { ids: ["n2"], text: "Now the radar." } });
  });
  it("does not return progress for a steered run that ended without a reported outcome", async () => {
    const requestId = randomUUID();
    // Someone's question started run-talk; the spoken request steered it. Its lines are in the read, but the run has ended.
    const s = await setup({ lookup: id => id === requestId ? { requestId: id, status: "accepted", runId: "run-talk" } : null,
      conversation: anchored([asked("first"), asked(requestId), noted("n1", "Checking.")], { state: "idle" }) });
    const pass = await fakeTime();
    const waiting = ask(s, requestId);
    await pass(21_000);
    expect((await waiting).json()).toEqual({ state: "working" });
  });
  it("reports an approval before a progress line, since the person has to act", async () => {
    const requestId = randomUUID();
    const s = await setup({ conversation: () => run([asked(requestId), noted("n1", "I'll check.")], { state: "waiting", runId: "run-talk" }, { approvals: [{ id: "a", title: "Run a command?", detail: "", status: "pending" }] }) });
    expect((await ask(s, requestId)).json()).toEqual({ state: "needsApproval", text: "Run a command?" });
  });
  it("shows no progress when the assistant wrote none, as when the profile turns commentary off", async () => {
    const requestId = randomUUID();
    const s = await setup({ conversation: () => run([asked(requestId)], { state: "working", runId: "run-talk" }) });
    const pass = await fakeTime();
    const waiting = ask(s, requestId);
    await pass(21_000);
    expect((await waiting).json()).toEqual({ state: "working" });
  });
  it("refuses a malformed list of heard lines before sending anything", async () => {
    const requestId = randomUUID();
    const s = await setup({ conversation: () => run([asked(requestId), said("a", "Fine.")]) });
    const bad: [string, unknown][] = [["not a list", "n1"], ["an object", { n1: true }], ["a number in it", [1]], ["an empty ID", [""]],
      ["a long ID", ["x".repeat(513)]], ["too many", Array.from({ length: 501 }, (_, index) => `n${index}`)], ["null", null]];
    for (const [name, heard] of bad) {
      const response = await ask(s, requestId, "Hi", { heard });
      expect(response.statusCode, name).toBe(400);
    }
    expect((await ask(s, requestId, "Hi", { heard: [], extra: 1 })).statusCode).toBe(400);
    expect(s.submit).not.toHaveBeenCalled();
    expect((await ask(s, requestId, "Hi", { heard: Array.from({ length: 500 }, (_, index) => `n${index}`) })).statusCode).toBe(200);
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
    // Only the request's own run covers a message not yet readable.
    expect(talkAnswer(accepted, run([], { state: "working", runId: "run-other" }))).toBe("missing");
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
    expect(talkAnswer(accepted, steered)).toBe("settling");
    expect(talkAnswer(accepted, steered, undefined, "interrupted")).toEqual({ state: "interrupted" });
    const answer = talkAnswer(accepted, steered, undefined, "completed") as { text: string };
    expect(answer.text).not.toContain("feed plan");
    expect(answer.text).toMatch(/^Corrected: feed at six\. Earlier parts are in the chat\.$/);
    expect(spokenReplies(["One.", "Two."])).toBe("One.\n\nTwo.");
  });
  it("never reads a progress line back as the answer", () => {
    const note = (id: string, text: string) => ({ ...said(id, text), interim: true });
    const settled = run([asked(), note("n1", "I'll check the forecast first."), said("r1", "Sunny, 75.")]);
    expect(talkAnswer(accepted, settled)).toEqual({ state: "done", text: "Sunny, 75." });
    // A run that ended having written only a progress line has no reply to read, so Talk says so.
    expect(talkAnswer(accepted, run([asked(), note("n1", "I'll check the forecast first.")]))).toEqual({ state: "done", text: "" });
    // And a failed run is refused rather than answered with what it meant to do.
    expect(talkAnswer(accepted, run([asked(), note("n1", "I'll check the forecast first.")], { state: "failed" })))
      .toEqual({ state: "refused", text: "The assistant could not finish this request." });
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
    // oxlint-disable-next-line no-control-regex -- the test checks a control character is gone
    expect(persona).not.toMatch(/[\u0000\u202e]/);
    expect(persona).not.toContain("x".repeat(401));
  });
});
