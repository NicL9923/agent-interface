import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";
import { SEND_TIMING_GIVE_UP_MS, SEND_TIMING_HELD, SendTimings, sendTimingHeader, type SendRecord } from "../src/server/send-timing.js";
import type { Log } from "../src/server/logging.js";
import type { Runtime, SubmissionReceipt, TurnWatcher } from "../src/shared/types.js";
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

/** A tracker on a fake clock and fake timers, with the hooks hermes.ts and the routes call. */
function timings() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { log, lines } = recordingLog();
  let clock = 0;
  const tracker = new SendTimings(log, () => clock);
  const timing = () => lines.map(line => line.fields.sendTiming as Record<string, unknown>);
  /** A frame of the shared assistant's session, as hermes.ts reports it. */
  const frame = (event: "start" | "text" | "end", session = "live") => tracker.frame(session, event);
  /** A fresh conversation read of the shared assistant found run open on its session. */
  const read = (run: string | undefined, running = true, session = "live") => tracker.run(session, "shared", run, running);
  const admit = (record: SendRecord, runId: string | undefined, admitted = 120, steered = false) =>
    tracker.admitted(record, steered ? "steer" : "messages", steered, { arrival: record.arrival, hermesStart: record.arrival + 40, admitted }, runId);
  return { tracker, lines, timing, frame, read, admit, at: (ms: number) => { clock = ms; } };
}
type Fixture = ReturnType<typeof timings>;

describe("SendTimings", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("logs one line per send with each stage measured from arrival", () => {
    const { tracker, lines, frame, read, admit, at } = timings();
    const send = tracker.begin("shared", "request-one", 0);
    at(80); frame("start"); read("run-one");
    at(120); admit(send, "run-one");
    // Another session's text, another assistant's live event and run, and another run's live event are not this send's.
    at(300); frame("text", "elsewhere"); tracker.written("other", "run-one"); tracker.run("elsewhere", "other", "other-run", true);
    tracker.written("shared", "other-run");
    at(450); frame("text");
    // Later tokens do not move the first frame.
    at(500); frame("text");
    at(700); tracker.written("shared", "run-one");
    at(900); tracker.written("shared", "run-one");
    expect(lines).toEqual([{ message: "Send timing", fields: { sendTiming: {
      route: "messages", botId: "shared", requestId: "request-one", steered: false,
      prepareMs: 40, admissionMs: 120, firstFrameMs: 450, firstLiveMs: 700, ended: "measured",
    } } }]);
  });

  it("reads nothing but its map once no open send needs more from the turn", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Requirement: a token after the first costs one map lookup. Reading the clock is the first extra cost.
    let reads = 0;
    const tracker = new SendTimings(recordingLog().log, () => { reads++; return 0; });
    const send = tracker.begin("shared", "request", 0);
    tracker.admitted(send, "messages", false, { arrival: 0, hermesStart: 0, admitted: 0 }, "run");
    tracker.frame("live", "start");
    tracker.frame("live", "text");
    expect(reads).toBe(1);
    // Nor does it visit the open send again.
    const visits = vi.spyOn(send.frames, "has");
    for (let token = 0; token < 100; token++) tracker.frame("live", "text");
    expect(reads).toBe(1);
    expect(visits).not.toHaveBeenCalled();
    // A send that begins mid-turn needs the turn again, once.
    tracker.begin("shared", "later", 0);
    tracker.frame("live", "text"); tracker.frame("live", "text");
    expect(reads).toBe(2);
    // With no send open, a session it never saw costs its lookup and no clock.
    tracker.close();
    for (let token = 0; token < 100; token++) tracker.frame("elsewhere", "text");
    expect(reads).toBe(2);
  });

  it("keeps the first text that streamed before Hermes answered, and drops a send it did not accept", () => {
    const { tracker, timing, frame, read, admit, at } = timings();
    const refused = tracker.begin("shared", "refused", 0);
    const accepted = tracker.begin("shared", "accepted", 0);
    at(60); frame("start");
    at(90); frame("text");
    at(95); read("accepted");
    at(100); tracker.written("shared", "accepted");
    tracker.discard(refused);
    admit(accepted, "accepted");
    expect(timing()).toEqual([expect.objectContaining({ requestId: "accepted", firstFrameMs: 90, firstLiveMs: 100, ended: "measured" })]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("takes the first text of the send's own run, past an earlier turn known to be another run's", () => {
    const { tracker, timing, frame, read, admit, at } = timings();
    const send = tracker.begin("shared", "second", 0);
    at(10); frame("start"); read("first");
    at(20); frame("text"); tracker.written("shared", "first");
    at(30); frame("end");
    at(40); frame("start");
    at(50); frame("text");
    at(55); read("second");
    at(60); tracker.written("shared", "second");
    admit(send, "second", 70);
    expect(timing()).toEqual([expect.objectContaining({ firstFrameMs: 50, firstLiveMs: 60, ended: "measured" })]);
  });

  it("keeps its run's first text when a later turn of its session went unidentified before Hermes answered", () => {
    const { tracker, timing, frame, read, admit, at } = timings();
    const send = tracker.begin("shared", "send", 0);
    at(10); frame("start"); read("send");
    at(20); frame("text"); tracker.written("shared", "send");
    at(30); frame("end");
    at(35); frame("start"); at(40); frame("text"); at(45); frame("end");
    admit(send, "send", 50);
    expect(timing()).toEqual([expect.objectContaining({ firstFrameMs: 20, firstLiveMs: 20, ended: "measured" })]);
  });

  // Each kind is ruled out by its own clause: a routine's or another assistant's turn before the answer names
  // the send's run, and another run's turn after it.
  it.each([
    ["routine turns, before its answer", "before", (fixture: Fixture, index: number) => {
      fixture.read(undefined, true, `s${index}`); fixture.frame("text", `s${index}`); }],
    ["another assistant's turns, before its answer", "before", (fixture: Fixture, index: number) => {
      fixture.tracker.run(`s${index}`, "other", `other-${index}`, true); fixture.frame("text", `s${index}`); }],
    ["turns identified as other runs before its answer", "identified", (fixture: Fixture, index: number) => { fixture.frame("text", `s${index}`); }],
    ["turns identified as another assistant's after their text", "after", (fixture: Fixture, index: number) => {
      fixture.frame("text", `s${index}`); fixture.tracker.run(`s${index}`, "other", `other-${index}`, true); }],
  ] as const)("keeps waiting for its run past more %s than it holds", (_name, when, turn) => {
    const fixture = timings();
    const { tracker, timing, frame, read, admit, at } = fixture;
    const send = tracker.begin("shared", "send", 0);
    at(10);
    for (let index = 0; index <= SEND_TIMING_HELD; index++) {
      frame("start", `s${index}`);
      if (when === "identified") read(`earlier-${index}`, true, `s${index}`);
      if (when === "before") turn(fixture, index);
    }
    admit(send, "send", 20);
    if (when !== "before") for (let index = 0; index <= SEND_TIMING_HELD; index++) turn(fixture, index);
    at(30); frame("start"); read("send"); frame("text"); tracker.written("shared", "send");
    expect(timing()).toEqual([expect.objectContaining({ firstFrameMs: 30, ended: "measured" })]);
  });

  it("measures a steer by its run's next growth after it arrived", () => {
    const { tracker, timing, frame, read, admit, at } = timings();
    at(10); frame("start"); read("run");
    at(200); frame("text");
    const steer = tracker.begin("shared", "steer", 300);
    at(320); tracker.written("shared", "run");
    at(330); admit(steer, "run", 330, true);
    at(350); frame("text");
    expect(timing()).toEqual([expect.objectContaining({ route: "steer", steered: true, firstFrameMs: 50, firstLiveMs: 20, ended: "measured" })]);
  });

  it("treats text after a turn ended, with no start seen, as a new turn", () => {
    const { tracker, timing, frame, read, admit, at } = timings();
    const send = tracker.begin("shared", "send", 0);
    at(10); frame("start"); read("other");
    at(20); frame("end");
    // The next turn's start was missed. Its text is not the ended turn's, which was another run's.
    at(30); frame("text");
    at(35); read("send");
    admit(send, "send", 40);
    at(50); tracker.written("shared", "send");
    expect(timing()).toEqual([expect.objectContaining({ firstFrameMs: 30, firstLiveMs: 50, ended: "measured" })]);
  });

  it("opens a turn whose start it never saw when a read finds the assistant running", () => {
    const { tracker, timing, frame, read, admit, at } = timings();
    const send = tracker.begin("shared", "send", 0);
    admit(send, "send", 10);
    at(20); read("send", true);
    at(40); frame("text"); tracker.written("shared", "send");
    expect(timing()).toEqual([expect.objectContaining({ firstFrameMs: 40, ended: "measured" })]);
  });

  it("ties no turn to a run from a read between turns", () => {
    const { tracker, timing, frame, read, admit, at } = timings();
    const send = tracker.begin("shared", "send", 0);
    admit(send, "send", 10);
    at(15); frame("start"); read("send"); frame("end");
    // The run is still open between its turns. The next turn's start is missed, and it is a routine's.
    at(20); read("send", false);
    at(25); frame("text");
    at(30); read(undefined);
    at(35); frame("end"); frame("start"); read("send");
    at(50); frame("text"); tracker.written("shared", "send");
    expect(timing()).toEqual([expect.objectContaining({ firstFrameMs: 50, ended: "measured" })]);
  });

  it.each([
    ["Hermes's answer named no run", ({ tracker, admit }: Fixture) => { admit(tracker.begin("shared", "send", 0), undefined); }],
    ["an earlier turn of its session streamed text and ended before any read identified it", ({ tracker, frame, read, admit, at }: Fixture) => {
      const send = tracker.begin("shared", "send", 0);
      at(10); frame("start"); at(20); frame("text"); tracker.written("shared", "send");
      at(30); frame("start"); read("send");
      admit(send, "send");
      at(130); frame("text");
    }],
    ["two reads disagreed on an earlier turn of its session", ({ tracker, frame, read, admit, at }: Fixture) => {
      const send = tracker.begin("shared", "send", 0);
      at(10); frame("start"); read(undefined);
      at(20); frame("text"); read("send"); tracker.written("shared", "send");
      admit(send, "send");
      at(30); frame("end"); frame("start"); read("send"); frame("text");
    }],
    ["text streamed in a turn two reads had disagreed on before the send began", ({ tracker, frame, read, admit, at }: Fixture) => {
      at(5); frame("start"); read("send"); read(undefined);
      const send = tracker.begin("shared", "send", 10);
      admit(send, "send");
      at(20); frame("text"); tracker.written("shared", "send");
      at(30); frame("end"); frame("start"); read("send"); frame("text");
    }],
    ["more turns streamed at once than a send holds", ({ tracker, frame, read, admit, at }: Fixture) => {
      const send = tracker.begin("shared", "send", 0);
      for (let turn = 0; turn <= SEND_TIMING_HELD; turn++) { at(10 + turn); frame("start", `s${turn}`); frame("text", `s${turn}`); }
      read("send", true, `s${SEND_TIMING_HELD}`); tracker.written("shared", "send");
      admit(send, "send");
    }],
    ["more runs went live before the answer than a send holds", ({ tracker, admit, at }: Fixture) => {
      const send = tracker.begin("shared", "send", 0);
      at(20);
      for (let run = 0; run <= SEND_TIMING_HELD; run++) tracker.written("shared", `run-${run}`);
      admit(send, `run-${SEND_TIMING_HELD}`);
    }],
    ["its turn was forgotten past the session limit before a read identified it", ({ tracker, frame, read, admit, at }: Fixture) => {
      const send = tracker.begin("shared", "send", 0);
      at(10); frame("start"); at(20); frame("text");
      admit(send, "send");
      for (let other = 0; other < 16; other++) frame("start", `other-${other}`);
      // A read finds the assistant running. Whether it is the forgotten turn is unknown.
      at(30); read("send"); frame("text");
    }],
  ])("omits what it cannot tie to the send's run: %s", (_name, scenario) => {
    const fixture = timings();
    scenario(fixture);
    expect(fixture.lines).toEqual([{ message: "Send timing: a moment could not be tied to the send's run",
      fields: { sendTiming: expect.objectContaining({ firstFrameMs: undefined, ended: "uncorrelated" }) } }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up on a send once more sessions went unidentified than it holds, keeping no uncertainty after", () => {
    const fixture = timings();
    const { tracker, lines, frame, read, admit, at } = fixture;
    const send = tracker.begin("shared", "send", 0);
    at(10);
    // Each session streams one turn that ends before any read identifies it. Past the limit, nothing is held.
    for (let session = 0; session < SEND_TIMING_HELD * 4; session++) {
      frame("start", `s${session}`); frame("text", `s${session}`); frame("end", `s${session}`);
    }
    // Reads that disagree on a turn blind every open send, a given-up one included.
    read("one", true, "late"); read("two", true, "late");
    expect({ frames: send.frames.size, blind: send.blind.size, lives: send.lives.size }).toEqual({ frames: 0, blind: 0, lives: 0 });
    admit(send, "send");
    expect(lines).toEqual([{ message: "Send timing: a moment could not be tied to the send's run",
      fields: { sendTiming: expect.objectContaining({ firstFrameMs: undefined, firstLiveMs: undefined, ended: "uncorrelated" }) } }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a send when a read finds another run running, keeping what its own run gave", () => {
    const { tracker, lines, frame, read, admit, at } = timings();
    const send = tracker.begin("shared", "quiet", 0);
    at(10); frame("start"); read("quiet");
    admit(send, "quiet", 20);
    at(30); tracker.written("shared", "quiet");
    at(40); frame("end");
    // Its run ended without text. A routine reply and a read naming no run do not end it; another run does.
    at(50); frame("start"); read(undefined);
    at(60); frame("text");
    at(70); frame("end"); frame("start"); read("later");
    at(80); frame("text");
    expect(lines).toEqual([{ message: "Send timing: another run started before it was measured",
      fields: { sendTiming: expect.objectContaining({ requestId: "quiet", firstFrameMs: undefined, firstLiveMs: 30, ended: "next-run" }) } }]);
  });

  it("logs at the deadline with what it has, and only once", () => {
    const { tracker, lines, frame, read, admit, at } = timings();
    const silent = tracker.begin("shared", "silent", 0);
    at(10); frame("start"); read("silent");
    admit(silent, "silent");
    at(500); frame("text");
    vi.advanceTimersByTime(SEND_TIMING_GIVE_UP_MS);
    tracker.written("shared", "silent");
    expect(lines).toEqual([{ message: "Send timing: gave up at the deadline", fields: { sendTiming: {
      route: "messages", botId: "shared", requestId: "silent", steered: false, prepareMs: 40, admissionMs: 120,
      firstFrameMs: 500, firstLiveMs: undefined, ended: "deadline", gaveUpAfterMs: SEND_TIMING_GIVE_UP_MS } } }]);
  });

  it("releases a send Hermes never answered at its deadline, and logs a late answer as given up", () => {
    const { tracker, timing, frame, read, admit, at } = timings();
    const send = tracker.begin("shared", "unanswered", 0);
    // Every record has a deadline from the moment it begins.
    expect(vi.getTimerCount()).toBe(1);
    at(10); frame("start"); read("unanswered");
    at(20); frame("text");
    at(30); tracker.written("shared", "unanswered");
    vi.advanceTimersByTime(SEND_TIMING_GIVE_UP_MS);
    // Released: a later token does no work for it.
    at(40); frame("start"); frame("text");
    admit(send, "unanswered", SEND_TIMING_GIVE_UP_MS + 10);
    expect(timing()).toEqual([expect.objectContaining({ requestId: "unanswered", ended: "deadline", firstFrameMs: undefined, firstLiveMs: undefined })]);
  });

  it.each([
    ["after Hermes answered", true],
    ["before Hermes answered", false],
  ])("ends every open send when the socket drops, %s", (_name, answered) => {
    const { tracker, timing, frame, read, admit, at } = timings();
    const send = tracker.begin("shared", "cut", 0);
    at(10); frame("start"); read("cut");
    at(20); frame("text");
    if (answered) admit(send, "cut", 25);
    tracker.disconnected();
    // A turn seen before the drop is forgotten with it.
    at(30); read("cut"); frame("text"); tracker.written("shared", "cut");
    if (!answered) admit(send, "cut", 40);
    expect(timing()).toEqual([expect.objectContaining({ requestId: "cut", ended: "disconnected", firstFrameMs: answered ? 20 : undefined, firstLiveMs: undefined })]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forgets every turn on a disconnect, so one seen before it never stands in for one after", () => {
    const { tracker, timing, frame, read, admit, at } = timings();
    at(10); frame("start"); read("before");
    tracker.disconnected();
    const send = tracker.begin("shared", "after", 20);
    admit(send, "after", 30);
    // Hermes ended that turn and started this one while the socket was down, so its start was never seen.
    at(40); frame("text");
    at(45); read("after");
    at(50); tracker.written("shared", "after");
    expect(timing()).toEqual([expect.objectContaining({ requestId: "after", firstFrameMs: 20, firstLiveMs: 30, ended: "measured" })]);
  });

  it("stops its deadlines on close", () => {
    const { tracker, lines, frame, read, admit } = timings();
    const send = tracker.begin("shared", "request", 0);
    frame("start"); read("request");
    admit(send, "request");
    tracker.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(SEND_TIMING_GIVE_UP_MS);
    frame("text"); tracker.written("shared", "request");
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
    const turns = new Set<TurnWatcher>();
    const watchers = new Set<(kind?: "inflight") => void>();
    const sent: string[] = [];
    // The live reply, and the run of the read it was built from.
    const live = { text: "Live reply", runId: "run" };
    /** Hermes reports a frame of the assistant's session, as hermes.ts calls the hook. */
    const turn = (event: "start" | "text" | "end") => { for (const watcher of turns) watcher.frame("sid", event); };
    /** A fresh conversation read found run open while the turn ran. */
    const read = (run = "run") => { for (const watcher of turns) watcher.run("sid", "shared", run, true); };
    const hermes = {
      // What Hermes streams while it is still answering a send: a turn of the send's run starts, and a read lands.
      during: (steer: boolean) => { if ((receipt.status ?? "accepted") !== "accepted") return; if (!steer) turn("start"); read(); },
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
      inflight: botId => ({ botId, message: { id: "sid-inflight", role: "assistant", text: live.text }, activity: { state: "thinking", runId: live.runId }, toolCalls: [] }),
      watch: (_botId, changed) => { watchers.add(changed); return () => { watchers.delete(changed); }; },
      watchTurns: watcher => { turns.add(watcher); return () => { turns.delete(watcher); }; },
      close: async () => {},
    });
    const lines: string[] = [];
    const { app, store } = await createApp(loadConfig({ APP_DATABASE: ":memory:", LOG_LEVEL: "info", LOCAL_DEV_AUTH: "true" }), runtime,
      { background: false, logStream: { write: line => { lines.push(line); } } });
    apps.push(app);
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const headers = await localLogin(app, origin);
    const timingLines = () => lines.map(line => JSON.parse(line) as { msg: string; sendTiming?: Record<string, unknown> }).filter(line => line.sendTiming);
    /** A live notice with no text, as a tool start or status change sends. */
    const notice = () => { for (const changed of watchers) changed("inflight"); };
    /** Hermes streams a token: the frame hook first, then the live notice, as hermes.ts calls them. */
    const token = () => { turn("text"); notice(); };
    return { base, headers, lines, timingLines, token, notice, turn, read, hermes, sent, turns, store, live };
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

  it("never credits a later run's text or live event to a send whose run streamed none", async () => {
    const s = await setup();
    const stream = await openStream(s.base, s.headers.cookie);
    const first = randomUUID();
    await post(s.base, s.headers, "messages", first);
    // Its turn ends without text, as a turn that only ran a tool or failed does.
    s.turn("end");
    // Another member's send runs next, and its live events carry its own run.
    s.turn("start"); s.read("later"); s.live.runId = "later";
    s.token();
    await vi.waitFor(() => expect(stream.text).toContain("event: inflight"));
    await vi.waitFor(() => expect(timingOf(s, first)).toBeDefined());
    expect(timingOf(s, first)).toMatchObject({ msg: "Send timing: another run started before it was measured", sendTiming: { ended: "next-run" } });
    expect(timingOf(s, first)!.sendTiming).not.toHaveProperty("firstFrameMs");
    expect(timingOf(s, first)!.sendTiming).not.toHaveProperty("firstLiveMs");
    await stream.close();
  });

  it("logs a send whose admission named no run as uncorrelated", async () => {
    const s = await setup({ runId: undefined });
    await post(s.base, s.headers, "messages");
    await vi.waitFor(() => expect(s.timingLines()).toHaveLength(1));
    expect(s.timingLines()[0]).toMatchObject({ msg: "Send timing: a moment could not be tied to the send's run", sendTiming: { ended: "uncorrelated" } });
    expect(s.timingLines()[0].sendTiming).not.toHaveProperty("firstFrameMs");
  });

  it("keeps the first text that streamed while Hermes was still answering the send", async () => {
    const s = await setup();
    const stream = await openStream(s.base, s.headers.cookie);
    s.hermes.during = () => { s.turn("start"); s.turn("text"); s.read(); };
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

