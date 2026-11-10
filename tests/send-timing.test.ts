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
    return { tracker, lines, at: (ms: number) => { clock = ms; } };
  }
  const phases = { arrival: 0, hermesStart: 40, admitted: 120 };

  it("logs one line per turn with each stage measured from arrival", () => {
    const { tracker, lines, at } = timings();
    tracker.admitted("messages", "shared", "request-one", false, phases);
    at(300); tracker.frame("other");
    at(450); tracker.frame("shared");
    // Later tokens do not move the first frame.
    at(500); tracker.frame("shared");
    at(700); tracker.written("shared");
    at(900); tracker.written("shared");
    expect(lines).toEqual([{ message: "Send timing", fields: { sendTiming: {
      route: "messages", botId: "shared", requestId: "request-one", steered: false,
      prepareMs: 40, admissionMs: 120, firstFrameMs: 450, firstLiveMs: 700,
    } } }]);
  });

  it("reads nothing but its map once a waiting turn has its first frame", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Requirement: a token after the first costs one map lookup. Reading the clock is the first extra cost.
    let reads = 0;
    const tracker = new SendTimings(recordingLog().log, () => { reads++; return 0; });
    tracker.admitted("messages", "shared", "request", false, phases);
    tracker.frame("shared");
    expect(reads).toBe(1);
    for (let token = 0; token < 100; token++) tracker.frame("shared");
    expect(reads).toBe(1);
  });

  it("ignores frames that arrived before the turn was admitted", () => {
    const { tracker, lines, at } = timings();
    tracker.admitted("messages", "shared", "earlier", false, phases);
    at(200); tracker.frame("shared");
    at(250); tracker.written("shared");
    at(260); tracker.frame("shared");
    at(300); tracker.admitted("steer", "shared", "request-two", true, { arrival: 280, hermesStart: 285, admitted: 300 });
    at(310); tracker.written("shared");
    expect(lines[1].fields.sendTiming).toMatchObject({ requestId: "request-two", route: "steer", steered: true, firstFrameMs: undefined, firstLiveMs: 30 });
  });

  it("gives every waiting turn of an assistant its own first frame after its admission", () => {
    const { tracker, lines, at } = timings();
    tracker.admitted("messages", "shared", "first", false, phases);
    at(200); tracker.frame("shared");
    at(250); tracker.admitted("steer", "shared", "second", true, { arrival: 210, hermesStart: 220, admitted: 250 });
    at(260); tracker.frame("shared");
    at(400); tracker.written("shared");
    expect(lines.map(line => line.fields.sendTiming)).toMatchObject([
      { requestId: "first", firstFrameMs: 200, firstLiveMs: 400 },
      { requestId: "second", firstFrameMs: 50, firstLiveMs: 190 },
    ]);
  });

  it("logs a turn with no live event once the deadline passes, and only once", () => {
    const { tracker, lines, at } = timings();
    tracker.admitted("messages", "shared", "slow", false, phases);
    at(500); tracker.frame("shared");
    vi.advanceTimersByTime(SEND_TIMING_GIVE_UP_MS);
    tracker.written("shared");
    expect(lines).toEqual([{ message: "Send timing: no live event before the deadline", fields: { sendTiming: {
      route: "messages", botId: "shared", requestId: "slow", steered: false,
      prepareMs: 40, admissionMs: 120, firstFrameMs: 500, firstLiveMs: undefined, gaveUpAfterMs: SEND_TIMING_GIVE_UP_MS,
    } } }]);
  });

  it("keeps waiting for a turn whose neighbour gave up", () => {
    const { tracker, lines, at } = timings();
    tracker.admitted("messages", "shared", "old", false, phases);
    vi.advanceTimersByTime(SEND_TIMING_GIVE_UP_MS - 1000);
    tracker.admitted("steer", "shared", "new", true, phases);
    vi.advanceTimersByTime(1000);
    at(700); tracker.written("shared");
    expect(lines.map(line => [(line.fields.sendTiming as { requestId: string }).requestId, line.message])).toEqual([
      ["old", "Send timing: no live event before the deadline"], ["new", "Send timing"]]);
  });

  it("stops its deadlines on close", () => {
    const { tracker, lines } = timings();
    tracker.admitted("messages", "shared", "request", false, phases);
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
    const text = new Set<(botId: string) => void>();
    const watchers = new Set<(kind?: "inflight") => void>();
    const sent: string[] = [];
    const live = { text: "Live reply" };
    const answer = async (input: { requestId: string; text: string }): Promise<SubmissionReceipt> => {
      sent.push(input.text);
      // Hermes takes a moment to admit, so the hermes phase has a floor.
      await new Promise(resolve => setTimeout(resolve, 20));
      return { requestId: input.requestId, status: "accepted", runId: "run", ...receipt };
    };
    const runtime: Runtime = fakeRuntime({
      status: async () => ({ connected: true }),
      capabilities: async () => new Proxy({}, { get: () => ({ supported: true }) }) as never,
      listBots: async () => [{ id: "shared", name: "Shared", model: "test", shared: true, activity: "idle" }],
      conversation: async botId => ({ botId, messages: [], activity: { state: "idle" }, approvals: [], files: [] }),
      submit: answer, steer: answer,
      inflight: botId => ({ botId, message: { id: "sid-inflight", role: "assistant", text: live.text }, activity: { state: "thinking", runId: "run" }, toolCalls: [] }),
      watch: (_botId, changed) => { watchers.add(changed); return () => { watchers.delete(changed); }; },
      watchStreamedText: listener => { text.add(listener); return () => { text.delete(listener); }; },
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
    const token = () => { for (const listener of text) listener("shared"); for (const changed of watchers) changed("inflight"); };
    return { base, headers, lines, timingLines, token, sent, text, store, live };
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

  it("reports only the total for a repeated request answered from its record", async () => {
    const s = await setup();
    const requestId = randomUUID();
    await post(s.base, s.headers, "messages", requestId);
    const repeated = await post(s.base, s.headers, "messages", requestId);
    expect(repeated.headers.get("server-timing")).toMatch(/^total;dur=[\d.]+$/);
    expect(s.sent).toHaveLength(1);
  });

  it("stops listening for streamed text when the app closes", async () => {
    const s = await setup();
    expect(s.text.size).toBe(1);
    const app = apps.pop()!;
    app.server.closeAllConnections();
    await app.close();
    expect(s.text.size).toBe(0);
  });
});
