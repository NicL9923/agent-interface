import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";
import { SEND_TIMING_GIVE_UP_MS, SendTimings, sendTimingHeader } from "../src/server/send-timing.js";
import type { Log } from "../src/server/logging.js";
import type { Runtime, SubmissionReceipt } from "../src/shared/types.js";
import { fakeRuntime, localLogin } from "./helpers/server.js";

const origin = "http://127.0.0.1:3000";

/** A log that keeps info lines and fails on anything else, so an unexpected warning is loud. */
function recordingLog() {
  const lines: { fields: Record<string, unknown>; message: string }[] = [];
  const log: Log = {
    info: ((fields: Record<string, unknown>, message: string) => { lines.push({ fields, message }); }) as Log["info"],
    warn: (() => { throw new Error("Unexpected warning"); }) as Log["warn"],
    error: (() => { throw new Error("Unexpected error"); }) as Log["error"],
  };
  return { log, lines };
}

describe("SendTimings", () => {
  afterEach(() => { vi.useRealTimers(); });
  function timings() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { log, lines } = recordingLog();
    let clock = 0;
    const tracker = new SendTimings(log, () => clock);
    const timing = () => lines.map(line => line.fields.sendTiming as Record<string, unknown>);
    return { tracker, lines, timing, at: (ms: number) => { clock = ms; } };
  }
  const phases = { arrival: 0, hermesStart: 40, admitted: 120 };

  it("logs one line per send with each stage measured from arrival", () => {
    const { tracker, lines, at } = timings();
    const send = tracker.begin("shared", "request-one", 0, false);
    at(80); tracker.turn("shared", "start");
    at(120); tracker.admitted(send, "messages", false, phases);
    at(300); tracker.turn("other", "text");
    at(450); tracker.turn("shared", "text");
    // Later tokens do not move the first frame.
    at(500); tracker.turn("shared", "text");
    at(700); tracker.written("shared");
    at(900); tracker.written("shared");
    expect(lines).toEqual([{ message: "Send timing", fields: { sendTiming: {
      route: "messages", botId: "shared", requestId: "request-one", steered: false,
      prepareMs: 40, admissionMs: 120, firstFrameMs: 450, firstLiveMs: 700, ended: "measured",
    } } }]);
  });

  it("reads nothing but its map once the turn's first frame is recorded", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Requirement: a token after the first costs one map lookup. Reading the clock is the first extra cost.
    let reads = 0;
    const tracker = new SendTimings(recordingLog().log, () => { reads++; return 0; });
    tracker.admitted(tracker.begin("shared", "request", 0, false), "messages", false, phases);
    tracker.turn("shared", "start");
    tracker.turn("shared", "text");
    expect(reads).toBe(1);
    for (let token = 0; token < 100; token++) tracker.turn("shared", "text");
    expect(reads).toBe(1);
  });

  it("keeps the first text that streamed before Hermes answered, and drops a send it did not accept", () => {
    const { tracker, timing, at } = timings();
    const refused = tracker.begin("shared", "refused", 0, false);
    const accepted = tracker.begin("shared", "accepted", 0, false);
    at(60); tracker.turn("shared", "start");
    at(90); tracker.turn("shared", "text");
    at(100); tracker.written("shared");
    tracker.discard(refused);
    at(120); tracker.admitted(accepted, "messages", false, phases);
    expect(timing()).toEqual([expect.objectContaining({ requestId: "accepted", firstFrameMs: 90, firstLiveMs: 100, ended: "measured" })]);
  });

  it("ends a send with its turn, so the next turn's text is never credited to it", () => {
    const { tracker, lines, timing, at } = timings();
    const send = tracker.begin("shared", "quiet", 0, false);
    at(60); tracker.turn("shared", "start");
    at(120); tracker.admitted(send, "messages", false, phases);
    at(200); tracker.turn("shared", "end");
    expect(timing()).toEqual([expect.objectContaining({ requestId: "quiet", firstFrameMs: undefined, firstLiveMs: undefined, ended: "turn" })]);
    expect(lines[0].message).toBe("Send timing: no live event in its turn");
    at(300); tracker.turn("shared", "start");
    at(310); tracker.turn("shared", "text");
    at(320); tracker.written("shared");
    vi.advanceTimersByTime(SEND_TIMING_GIVE_UP_MS);
    expect(lines).toHaveLength(1);
  });

  it("ends a send whose turn's end was never reported when a newer turn starts", () => {
    const { tracker, timing, at } = timings();
    const send = tracker.begin("shared", "replaced", 0, false);
    at(60); tracker.turn("shared", "start");
    at(120); tracker.admitted(send, "messages", false, phases);
    at(150); tracker.written("shared");
    at(400); tracker.turn("shared", "start");
    at(410); tracker.turn("shared", "text");
    expect(timing()).toEqual([expect.objectContaining({ requestId: "replaced", firstFrameMs: undefined, firstLiveMs: 150, ended: "next-turn" })]);
  });

  it.each([
    ["its end was reported", (tracker: SendTimings) => tracker.turn("shared", "end"), "turn"],
    // A newer turn starts before the answer arrives without the end of this one. It belongs to someone else.
    ["a newer turn replaced it", (tracker: SendTimings) => tracker.turn("shared", "start"), "next-turn"],
  ])("ends a send at Hermes's answer when its turn already ended: %s", (_name, end, ended) => {
    const { tracker, lines, timing, at } = timings();
    const send = tracker.begin("shared", "fast", 0, false);
    at(60); tracker.turn("shared", "start");
    at(70); tracker.turn("shared", "text");
    at(90); end(tracker);
    at(110); tracker.turn("shared", "text");
    at(120); tracker.admitted(send, "messages", false, phases);
    expect(timing()).toEqual([expect.objectContaining({ requestId: "fast", firstFrameMs: 70, ended })]);
    at(130); tracker.turn("shared", "start");
    vi.advanceTimersByTime(SEND_TIMING_GIVE_UP_MS);
    expect(lines).toHaveLength(1);
  });

  it("keeps waiting for the first text after a tool event was the first live event", () => {
    const { tracker, lines, timing, at } = timings();
    const send = tracker.begin("shared", "tool-first", 0, false);
    at(60); tracker.turn("shared", "start");
    at(120); tracker.admitted(send, "messages", false, phases);
    at(200); tracker.written("shared");
    expect(lines).toEqual([]);
    at(600); tracker.turn("shared", "text");
    expect(timing()).toEqual([expect.objectContaining({ firstLiveMs: 200, firstFrameMs: 600, ended: "measured" })]);
  });

  it("logs at the deadline with what it has, and only once", () => {
    const { tracker, lines, at } = timings();
    const silent = tracker.begin("shared", "silent", 0, false), toolOnly = tracker.begin("other", "tool-only", 0, false);
    tracker.turn("shared", "start"); tracker.turn("other", "start");
    tracker.admitted(silent, "messages", false, phases);
    tracker.admitted(toolOnly, "talk", false, phases);
    at(500); tracker.turn("shared", "text");
    at(600); tracker.written("other");
    vi.advanceTimersByTime(SEND_TIMING_GIVE_UP_MS);
    tracker.written("shared");
    tracker.turn("shared", "end");
    expect(lines).toEqual([
      { message: "Send timing: no live event before the deadline", fields: { sendTiming: {
        route: "messages", botId: "shared", requestId: "silent", steered: false, prepareMs: 40, admissionMs: 120,
        firstFrameMs: 500, firstLiveMs: undefined, ended: "deadline", gaveUpAfterMs: SEND_TIMING_GIVE_UP_MS } } },
      { message: "Send timing", fields: { sendTiming: expect.objectContaining({ requestId: "tool-only", route: "talk",
        firstFrameMs: undefined, firstLiveMs: 600, ended: "deadline", gaveUpAfterMs: SEND_TIMING_GIVE_UP_MS }) } },
    ]);
  });

  it("measures a steer by the running reply's next growth after it arrived", () => {
    const { tracker, timing, at } = timings();
    const first = tracker.begin("shared", "first", 0, false);
    at(60); tracker.turn("shared", "start");
    at(100); tracker.admitted(first, "messages", false, { arrival: 0, hermesStart: 10, admitted: 100 });
    at(200); tracker.turn("shared", "text");
    // A steer arrives during the reply. A frame held from before it arrived is not its growth.
    const steer = tracker.begin("shared", "steer", 300, true);
    tracker.turn("shared", "text", 250);
    at(320); tracker.written("shared");
    at(330); tracker.admitted(steer, "steer", true, { arrival: 300, hermesStart: 305, admitted: 330 });
    at(350); tracker.turn("shared", "text");
    expect(timing()).toEqual([
      expect.objectContaining({ requestId: "first", firstFrameMs: 200, firstLiveMs: 320 }),
      expect.objectContaining({ requestId: "steer", route: "steer", steered: true, firstFrameMs: 50, firstLiveMs: 20, ended: "measured" }),
    ]);
  });

  it("moves a send that joined a running turn to the next one when Hermes did not steer it", () => {
    const { tracker, timing, at } = timings();
    tracker.turn("shared", "start");
    const send = tracker.begin("shared", "new-turn", 0, false);
    at(50); tracker.turn("shared", "text");
    at(60); tracker.written("shared");
    at(120); tracker.admitted(send, "messages", false, phases);
    at(150); tracker.turn("shared", "end");
    expect(timing()).toEqual([]);
    at(200); tracker.turn("shared", "start");
    at(250); tracker.turn("shared", "text");
    at(260); tracker.written("shared");
    expect(timing()).toEqual([expect.objectContaining({ requestId: "new-turn", steered: false, firstFrameMs: 250, firstLiveMs: 260 })]);
  });

  it.each([
    ["its end is reported", (tracker: SendTimings) => { tracker.turn("shared", "end"); tracker.turn("shared", "start"); }],
    ["a newer turn starts without its end", (tracker: SendTimings) => tracker.turn("shared", "start")],
  ])("moves a waiting steer to the next turn when the running one gives way before Hermes answers: %s", (_name, giveWay) => {
    const { tracker, timing, at } = timings();
    const steer = tracker.begin("shared", "queued", 0, true);
    at(50); tracker.turn("shared", "text");
    // Hermes drains the queued guidance into the next turn.
    at(80); giveWay(tracker);
    at(120); tracker.admitted(steer, "steer", true, phases);
    expect(timing()).toEqual([]);
    at(150); tracker.turn("shared", "text");
    at(160); tracker.written("shared");
    expect(timing()).toEqual([expect.objectContaining({ requestId: "queued", firstFrameMs: 150, firstLiveMs: 160 })]);
  });

  it("stops its deadlines on close", () => {
    const { tracker, lines } = timings();
    const send = tracker.begin("shared", "request", 0, false);
    tracker.turn("shared", "start");
    tracker.admitted(send, "messages", false, phases);
    tracker.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(SEND_TIMING_GIVE_UP_MS);
    tracker.written("shared");
    expect(lines).toEqual([]);
  });
});

describe("sendTimingHeader", () => {
  it.each([
    ["admitted", { arrival: 10, hermesStart: 12.34, admitted: 52.36 }, "prepare;dur=2.3, hermes;dur=40, total;dur=60"],
    // Hermes threw: the send became uncertain without an answer.
    ["sent without an answer", { arrival: 10, hermesStart: 15 }, "prepare;dur=5, total;dur=60"],
    // A repeated request ID is answered from the recorded receipt without reaching Hermes.
    ["answered from the record", { arrival: 10 }, "total;dur=60"],
  ])("names only the phases a send %s reached", (_name, phases, header) => {
    expect(sendTimingHeader(phases, 70)).toBe(header);
  });
});

describe("send timing through the app", () => {
  const apps: { close(): Promise<unknown>; server: { closeAllConnections(): void } }[] = [];
  afterEach(async () => { for (const app of apps.splice(0)) { app.server.closeAllConnections(); await app.close(); } });

  async function setup(receipt: Partial<SubmissionReceipt> = {}) {
    const turns = new Set<(botId: string, event: "start" | "text" | "end") => void>();
    const watchers = new Set<(kind?: "inflight") => void>();
    const sent: string[] = [];
    const live = { text: "Live reply" };
    /** Hermes reports a turn event for the assistant, as hermes.ts calls the hooks. */
    const turn = (event: "start" | "text" | "end") => {
      for (const listener of turns) listener("shared", event);
    };
    const hermes = {
      // What Hermes streams while it is still answering a send. A new turn starts before the answer.
      during: (steer: boolean) => { if (!steer && (receipt.status ?? "accepted") === "accepted") turn("start"); },
    };
    const answer = (steer: boolean) => async (input: { requestId: string; text: string }): Promise<SubmissionReceipt> => {
      sent.push(input.text);
      hermes.during(steer);
      // Hermes takes a moment to admit, so the hermes phase has a floor.
      await new Promise(resolve => setTimeout(resolve, 20));
      return { requestId: input.requestId, status: "accepted", runId: "run", ...receipt };
    };
    const runtime: Runtime = fakeRuntime({
      status: async () => ({ connected: true }),
      capabilities: async () => new Proxy({}, { get: () => ({ supported: true }) }) as never,
      listBots: async () => [{ id: "shared", name: "Shared", model: "test", shared: true, activity: "idle" }],
      conversation: async botId => ({ botId, messages: [], activity: { state: "idle" }, approvals: [], files: [] }),
      submit: answer(false), steer: answer(true),
      inflight: botId => ({ botId, message: { id: "sid-inflight", role: "assistant", text: live.text }, activity: { state: "thinking", runId: "run" }, toolCalls: [] }),
      watch: (_botId, changed) => { watchers.add(changed); return () => { watchers.delete(changed); }; },
      watchTurns: listener => { turns.add(listener); return () => { turns.delete(listener); }; },
      close: async () => {},
    });
    const lines: string[] = [];
    const { app, store } = await createApp(loadConfig({ APP_DATABASE: ":memory:", LOG_LEVEL: "info", LOCAL_DEV_AUTH: "true" }), runtime,
      { background: false, logStream: { write: line => { lines.push(line); } } });
    apps.push(app);
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const headers = await localLogin(app, origin);
    const timingLines = () => lines.map(line => JSON.parse(line) as { msg: string; sendTiming?: Record<string, unknown> }).filter(line => line.sendTiming);
    /** Hermes streams a token: the text hook first, then the live notice, as hermes.ts calls them. */
    /** A live notice with no text, as a tool start or status change sends. */
    const notice = () => { for (const changed of watchers) changed("inflight"); };
    const token = () => { turn("text"); notice(); };
    return { base, headers, lines, timingLines, token, notice, turn, hermes, sent, turns, store, live };
  }
  async function openStream(base: string, cookie: string) {
    const response = await fetch(`${base}/api/bots/shared/events?inflight=2`, { headers: { cookie } });
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let received = "";
    void (async () => { for (;;) { const chunk = await reader.read(); if (chunk.done) return; received += chunk.value; } })().catch(() => {});
    await vi.waitFor(() => expect(received).toContain("retry"));
    return { get text() { return received; }, close: () => reader.cancel() };
  }
  const post = (base: string, headers: Record<string, string>, path: "messages" | "steer", requestId = randomUUID()) =>
    fetch(`${base}/api/bots/shared/${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ requestId, text: "Private words about the herd", attachments: [] }) });

  it("times a message from arrival to the first live event and never logs its text", async () => {
    const s = await setup();
    const stream = await openStream(s.base, s.headers.cookie);
    const response = await post(s.base, s.headers, "messages");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "accepted" });
    const header = response.headers.get("server-timing")!;
    expect(header).toMatch(/^prepare;dur=[\d.]+, hermes;dur=[\d.]+, total;dur=[\d.]+$/);
    expect(Number(/hermes;dur=([\d.]+)/.exec(header)![1])).toBeGreaterThanOrEqual(19);
    expect(s.timingLines()).toEqual([]);
    s.token();
    await vi.waitFor(() => expect(stream.text).toContain("event: inflight"));
    await vi.waitFor(() => expect(s.timingLines()).toHaveLength(1));
    const [line] = s.timingLines();
    expect(line.msg).toBe("Send timing");
    const timing = line.sendTiming as Record<string, number>;
    expect(timing).toMatchObject({ route: "messages", botId: "shared", steered: false });
    expect(timing.prepareMs).toBeLessThanOrEqual(timing.admissionMs);
    expect(timing.admissionMs - timing.prepareMs).toBeGreaterThanOrEqual(19);
    expect(timing.admissionMs).toBeLessThanOrEqual(timing.firstFrameMs);
    expect(timing.firstFrameMs).toBeLessThanOrEqual(timing.firstLiveMs);
    expect(s.sent).toEqual(["Private words about the herd"]);
    expect(s.lines.join("\n")).not.toContain("Private words");
    // The turn is finished: later tokens log nothing more.
    s.token();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(s.timingLines()).toHaveLength(1);
    await stream.close();
  });

  it("counts a growth notice as the first live event when the send's change notice is still held", async () => {
    const s = await setup();
    const stream = await openStream(s.base, s.headers.cookie);
    await post(s.base, s.headers, "steer");
    s.token();
    await vi.waitFor(() => expect(s.timingLines()).toHaveLength(1));
    // Change notices go at most once a second, so this send's notice waits and the stream keeps the reply it holds.
    await post(s.base, s.headers, "steer");
    s.live.text = "Live reply grows";
    s.token();
    await vi.waitFor(() => expect(s.timingLines()).toHaveLength(2));
    expect(stream.text.split("event: inflight-delta").length - 1).toBe(1);
    expect(stream.text.indexOf("event: inflight-delta")).toBeGreaterThan(stream.text.lastIndexOf("event: inflight\n"));
    expect(s.timingLines()[1].sendTiming).toMatchObject({ route: "steer", firstLiveMs: expect.any(Number) });
    await stream.close();
  });

  it("times a steer under its own route", async () => {
    const s = await setup({ steered: true });
    const stream = await openStream(s.base, s.headers.cookie);
    const response = await post(s.base, s.headers, "steer");
    expect(response.headers.get("server-timing")).toMatch(/^prepare;dur=[\d.]+, hermes;dur=[\d.]+, total;dur=[\d.]+$/);
    s.token();
    await vi.waitFor(() => expect(s.timingLines()).toHaveLength(1));
    expect(s.timingLines()[0].sendTiming).toMatchObject({ route: "steer", steered: true });
    await stream.close();
  });

  it("does not time a send Hermes did not admit", async () => {
    const s = await setup({ status: "rejected", runId: undefined, message: "Images cannot be added while Hermes is working." });
    const stream = await openStream(s.base, s.headers.cookie);
    const response = await post(s.base, s.headers, "messages");
    expect(await response.json()).toMatchObject({ status: "rejected" });
    expect(response.headers.get("server-timing")).toMatch(/^prepare;dur=[\d.]+, hermes;dur=[\d.]+, total;dur=[\d.]+$/);
    s.token();
    await vi.waitFor(() => expect(stream.text).toContain("event: inflight"));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(s.timingLines()).toEqual([]);
    await stream.close();
  });

  it("does not count a live event the viewer could no longer be sent", async () => {
    const s = await setup();
    const stream = await openStream(s.base, s.headers.cookie);
    await post(s.base, s.headers, "messages");
    // The send's own change notice goes first, so the live event is the stream's next write and is refused.
    await vi.waitFor(() => expect(stream.text).toContain("data: change"));
    s.store.deleteSession(hash(s.headers.cookie.slice("session=".length)));
    s.token();
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(stream.text).not.toContain("event: inflight");
    expect(s.timingLines()).toEqual([]);
    await stream.close();
  });

  const timingOf = (s: { timingLines(): { msg: string; sendTiming?: Record<string, unknown> }[] }, requestId: string) =>
    s.timingLines().find(line => line.sendTiming!.requestId === requestId);

  it("ends a send's measurement with its turn, so a later turn's text is never credited to it", async () => {
    const s = await setup();
    const stream = await openStream(s.base, s.headers.cookie);
    const first = randomUUID();
    await post(s.base, s.headers, "messages", first);
    // Its turn ends without text, as a turn that only ran a tool or failed does.
    s.turn("end");
    // A routine's turn, or another member's send, streams text to the same chat next.
    s.turn("start");
    s.token();
    await vi.waitFor(() => expect(stream.text).toContain("event: inflight"));
    await vi.waitFor(() => expect(timingOf(s, first)).toBeDefined());
    const line = timingOf(s, first)!;
    expect(line.sendTiming!.firstFrameMs).toBeUndefined();
    expect(line.sendTiming!.firstLiveMs).toBeUndefined();
    expect(line).toMatchObject({ msg: "Send timing: no live event in its turn", sendTiming: { ended: "turn" } });
    await stream.close();
  });

  it("keeps the first text that streamed while Hermes was still answering the send", async () => {
    const s = await setup();
    const stream = await openStream(s.base, s.headers.cookie);
    s.hermes.during = () => { s.turn("start"); s.turn("text"); };
    await post(s.base, s.headers, "messages");
    // No more text after the answer, only the live event that shows what already streamed.
    s.notice();
    await vi.waitFor(() => expect(s.timingLines()).toHaveLength(1));
    const timing = s.timingLines()[0].sendTiming as Record<string, number>;
    expect(timing.firstFrameMs).toBeGreaterThanOrEqual(timing.prepareMs);
    expect(timing.firstFrameMs).toBeLessThan(timing.admissionMs);
    expect(timing.firstLiveMs).toBeGreaterThanOrEqual(timing.admissionMs);
    await stream.close();
  });

  it("does not time a send whose admission Hermes refused, even when text streamed meanwhile", async () => {
    const s = await setup({ status: "rejected", runId: undefined, message: "Images cannot be added while Hermes is working." });
    const stream = await openStream(s.base, s.headers.cookie);
    s.hermes.during = () => { s.turn("start"); s.turn("text"); };
    await post(s.base, s.headers, "messages");
    s.token();
    await vi.waitFor(() => expect(stream.text).toContain("event: inflight"));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(s.timingLines()).toEqual([]);
    await stream.close();
  });

  it("keeps waiting for the first text after a tool event was the first live event", async () => {
    const s = await setup();
    const stream = await openStream(s.base, s.headers.cookie);
    await post(s.base, s.headers, "messages");
    s.notice();
    await vi.waitFor(() => expect(stream.text).toContain("event: inflight"));
    s.token();
    await vi.waitFor(() => expect(s.timingLines()).toHaveLength(1));
    const [line] = s.timingLines();
    const timing = line.sendTiming as Record<string, number>;
    expect(timing.firstFrameMs).toBeGreaterThan(timing.firstLiveMs);
    expect(line).toMatchObject({ msg: "Send timing", sendTiming: { ended: "measured" } });
    await stream.close();
  });

  it("reports only the total for a repeated request answered from its record", async () => {
    const s = await setup();
    const requestId = randomUUID();
    await post(s.base, s.headers, "messages", requestId);
    const repeated = await post(s.base, s.headers, "messages", requestId);
    expect(repeated.headers.get("server-timing")).toMatch(/^total;dur=[\d.]+$/);
    expect(s.sent).toHaveLength(1);
  });

  it("stops listening for turn events when the app closes", async () => {
    const s = await setup();
    expect(s.turns.size).toBe(1);
    const app = apps.pop()!;
    app.server.closeAllConnections();
    await app.close();
    expect(s.turns.size).toBe(0);
  });
});
