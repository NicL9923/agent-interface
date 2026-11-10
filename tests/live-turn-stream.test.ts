import { afterEach, describe, expect, it, vi } from "vitest";
import { setTimeout as realDelay } from "node:timers/promises";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { createHermesRuntime } from "../src/server/hermes.js";
import { compareVersions, placeTurn } from "../src/shared/inflight.js";
import type { InflightDelta, Message, TurnEvent } from "../src/shared/types.js";
import { fakeHermes, HERMES_URL, row } from "./helpers/fake-hermes.js";

// `?inflight=3` end to end: the real app and the real Hermes runtime, with only Hermes's socket faked.
const origin = "http://127.0.0.1:3000";
const apps: { close(): Promise<unknown>; server: { closeAllConnections(): void } }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) { app.server.closeAllConnections(); await app.close(); }
  vi.unstubAllGlobals();
});
// The stream's throttles run on virtual time, as in conversation-events.test.ts; sockets stay real.
const virtualClock: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ["setTimeout", "clearTimeout", "Date"] };

async function setup() {
  const hermes = fakeHermes();
  hermes.profiles = ["shared", "hidden"];
  const runtime = createHermesRuntime({ url: HERMES_URL, token: "isolated-contract-token" });
  const { app, store } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), runtime, { background: false });
  apps.push(app);
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const member = async (name: string) => {
    const response = await fetch(`${base}/api/auth/local`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ member: name }) });
    return response.headers.getSetCookie()[0].split(";")[0];
  };
  const one = await member("one"), two = await member("two");
  const get = async (cookie: string, query = "turns=20") => {
    const response = await fetch(`${base}/api/bots/shared/conversation?${query}`, { headers: { cookie } });
    expect(response.status).toBe(200);
    return await response.json() as { messages: Message[]; version?: string; activity: TurnEvent["activity"] };
  };
  vi.useFakeTimers(virtualClock);
  return { hermes, runtime, store, base, one, two, get };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** A stream's events as they arrive. Waiting moves virtual time too. */
async function stream(s: Setup, cookie: string, mode = "3") {
  const response = await fetch(`${s.base}/api/bots/shared/events?inflight=${mode}`, { headers: { cookie } });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "", done = false;
  const pump = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) { done = true; return; }
      text += chunk.value;
    }
  })().catch(() => { done = true; });
  const events = () => text.split("\n\n").filter(frame => frame.startsWith("event:") || frame.startsWith("data:")).map(frame => {
    if (frame.startsWith("data:")) return ["change", frame.slice(6)] as const;
    const [event, data] = frame.split("\n");
    return [event.slice(7), JSON.parse(data.slice(6))] as const;
  });
  const of = <T,>(type: string) => events().filter(([name]) => name === type).map(([, data]) => data as T);
  const until = async (ready: () => boolean, ms = 3000) => {
    const deadline = performance.now() + ms;
    while (!ready()) {
      if (performance.now() > deadline) throw new Error(`Stream never got there: ${JSON.stringify(text)}`);
      await vi.advanceTimersByTimeAsync(10);
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  await until(() => text.includes("retry"));
  return { events, turns: () => of<TurnEvent>("turn"), deltas: () => of<InflightDelta>("inflight-delta"), until,
    get done() { return done; }, get text() { return text; }, close: () => reader.cancel().then(() => pump) };
}

const opens = (s: Setup) => s.hermes.opens().map(call => call.params.window);
function midTurn(s: Setup) {
  s.hermes.history = [row(1, "user", "Fence?", { app_run_id: "run-1" }), row(2, "assistant", "Fixed.", { app_run_id: "run-1" }),
    row(3, "user", "Check the barn", { app_request_id: "req-2", app_run_id: "run-2" })];
  Object.assign(s.hermes, { running: true, runId: "run-2", inflight: { user: "Check the barn", assistant: "" } });
}
const saved = (messages: Message[]) => messages.filter(message => !message.id.endsWith("-inflight"));

/**
 * A `?inflight=1` or `?inflight=2` client through the reviewer's sequence: it reads on each change notice, as the
 * app does, and logs every event and read with the step it arrived in, which is its timing class. A `?inflight=3`
 * stream of another member watches beside it when `beside` is set, and never reads, so any difference is the
 * server's own turn reads.
 */
async function legacyRun(mode: "1" | "2", beside: boolean) {
  const s = await setup();
  midTurn(s);
  const legacy = await stream(s, s.one, mode);
  const turns = beside ? await stream(s, s.two, "3") : undefined;
  // Both runs go on from the same instant, so tool times match.
  vi.setSystemTime(new Date("2026-11-10T06:00:00Z"));
  const log: unknown[] = [];
  let step = 0, logged = 0;
  const read = async () => {
    const { messages, activity } = await s.get(s.one);
    log.push([step, "read", messages.map(message => [message.id, message.text]), activity.state]);
  };
  /** Runs `ms` of virtual time, logging what the legacy stream got and reading on each change notice. */
  const run = async (ms: number) => {
    for (let at = 0; at < ms; at += 10) {
      await vi.advanceTimersByTimeAsync(10);
      await new Promise(resolve => setImmediate(resolve));
      for (const [name, data] of legacy.events().slice(logged)) {
        logged++;
        log.push([step, name, data]);
        if (name === "change") await read();
      }
    }
  };
  await read();
  const steps = [
    // A turn's structure changes, so the change notice throttle is running when the tool finishes below.
    () => s.hermes.frame("message.start", {}),
    () => s.hermes.frame("message.delta", { text: "Looking." }),
    () => {
      s.hermes.history.push(row(4, "assistant", "Looking.", { app_run_id: "run-2" }));
      s.hermes.frame("tool.start", { tool_id: "t1", name: "terminal" });
      s.hermes.frame("tool.complete", { tool_id: "t1", name: "terminal" });
      s.hermes.frame("message.delta", { text: " Found it." });
    },
    () => s.hermes.frame("message.delta", { text: " More." }),
  ];
  const durations = [200, 300, 1500, 400];
  for (const [index, frame] of steps.entries()) {
    step = index + 1;
    frame();
    await run(durations[index]);
  }
  // The turn stream did see the turn, so a run beside it really had the server reading turns.
  if (turns) expect(turns.turns().map(turn => turn.message.text)).toContain("Found it.");
  await legacy.close();
  await turns?.close();
  return log;
}

describe("?inflight=3 turn streams", () => {
  it("sends the turn whole after each change to its structure, and growth on top of it", async () => {
    const s = await setup();
    midTurn(s);
    const events = await stream(s, s.one);
    await s.get(s.one);
    s.hermes.frame("message.delta", { text: "Looking. " });
    await events.until(() => events.turns().length === 1);
    const [first] = events.turns();
    expect(first).toMatchObject({ botId: "shared", messages: [{ id: "req-2" }], message: { text: "Looking. " }, activity: { runId: "run-2" } });
    s.hermes.frame("message.delta", { text: "One sec." });
    await events.until(() => events.deltas().length === 1);
    expect(events.deltas()[0]).toMatchObject({ baseTextLength: 9, appendText: "One sec." });

    s.hermes.history.push(row(4, "assistant", "Looking. One sec.", { app_run_id: "run-2" }));
    s.hermes.frame("tool.start", { tool_id: "t1", name: "terminal" });
    s.hermes.frame("tool.complete", { tool_id: "t1", name: "terminal" });
    s.hermes.frame("message.delta", { text: "Found it." });
    await events.until(() => events.turns().length === 2);
    const second = events.turns()[1];
    // The saved segment arrives as a row of the turn, and the live reply holds only what follows it.
    expect(second.messages.map(message => message.text)).toEqual(["Check the barn", "Looking. One sec."]);
    expect(second.message.text).toBe("Found it.");
    expect(compareVersions(second.version, first.version)).toBeGreaterThan(0);
    // The change notice still goes, for approvals, files and everything else the read carries.
    await events.until(() => events.events().some(([name]) => name === "change"));
    // One read by the client and one by the server for the tool; nothing for the growth.
    expect(opens(s)).toEqual([{ turns: 20 }, { start: "req-2" }]);
    await events.close();
  });

  it("keeps growth as deltas across a write's change notice, and stops reading turns once the stream closes", async () => {
    const s = await setup();
    midTurn(s);
    const events = await stream(s, s.one);
    await s.get(s.one);
    s.hermes.frame("message.delta", { text: "Looking." });
    await events.until(() => events.turns().length === 1);
    // A write's own notice, with no change to the turn's structure: the reply goes on growing.
    const csrf = await (await fetch(`${s.base}/api/bootstrap?roster=lean`, { headers: { cookie: s.one } })).json() as { csrfToken: string };
    const answer = await fetch(`${s.base}/api/bots/shared/steer`, { method: "POST", headers: { cookie: s.one, origin, "content-type": "application/json", "x-csrf-token": csrf.csrfToken },
      body: JSON.stringify({ requestId: crypto.randomUUID(), text: "Also the loft" }) });
    expect(answer.status).toBe(200);
    await events.until(() => events.events().some(([name]) => name === "change"));
    s.hermes.frame("message.delta", { text: " Still looking." });
    await events.until(() => events.deltas().length === 1);
    expect(events.turns()).toHaveLength(1);
    await events.close();
    await realDelay(25);
    const before = opens(s).length;
    s.hermes.frame("tool.complete", { tool_id: "t1" });
    await realDelay(25);
    expect(opens(s)).toHaveLength(before);
  });

  it("serves two members with one turn read, and each places it on what it holds, scrolled back or not", async () => {
    const s = await setup();
    midTurn(s);
    const one = await stream(s, s.one), two = await stream(s, s.two);
    const latest = await s.get(s.one), back = await s.get(s.two, "start=1");
    s.hermes.history.push(row(4, "assistant", "Looking.", { app_run_id: "run-2" }));
    s.hermes.frame("tool.complete", { tool_id: "t1" });
    s.hermes.frame("message.delta", { text: "Looking. Found it." });
    await one.until(() => one.turns().length === 1);
    await two.until(() => two.turns().length === 1);
    expect(one.turns()[0]).toEqual(two.turns()[0]);
    const turn = one.turns()[0];
    expect(placeTurn(latest.messages, turn)!.map(message => message.id)).toEqual(["1", "2", "req-2", "4"]);
    expect(placeTurn(back.messages, turn)!.map(message => message.id)).toEqual(["1", "2", "req-2", "4"]);
    expect(turn.message.text).toBe("Found it.");
    expect(opens(s)).toEqual([{ turns: 20 }, { start: "1" }, { start: "req-2" }]);
    await one.close(); await two.close();
  });

  it("shows the turn's saved messages exactly as the conversation read shows them to the same member", async () => {
    const s = await setup();
    s.store.savePresentation("hidden", { shared: false, ownerId: "local-two" });
    s.store.intent({ requestId: "steer-two", botId: "shared", senderId: "local-two", text: "Check the loft too", attachments: [] });
    midTurn(s);
    s.hermes.history.push(
      row(4, "assistant", "On it.\n\n```reply-card\n{\"type\":\"checklist\",\"title\":\"Barn\",\"items\":[{\"id\":\"a\",\"text\":\"Door\"}]}\n```", {
        app_run_id: "run-2", display_commentary: ["Opening the barn camera."], app_artifacts: [{ path: "/workspace/out/barn.png", name: "barn.png" }] }),
      row(5, "user", "Check the loft too", { app_request_id: "steer-two", app_run_id: "run-2", app_steering: true }),
      { row_id: 6, role: "tool", name: "message_agent", content: "Asked", app_run_id: "run-2",
        app_tool_call: { id: "call-6", name: "message_agent", arguments: JSON.stringify({ target: "hidden", text: "private" }), result: "private answer", status: "completed" } });
    const events = await stream(s, s.one);
    const read = await s.get(s.one);
    s.hermes.frame("message.delta", { text: "Loft is dry." });
    await events.until(() => events.turns().length === 1);
    const turn = events.turns()[0];
    const start = read.messages.findIndex(message => message.id === "req-2");
    expect(turn.messages).toEqual(saved(read.messages).slice(start));
    expect(turn.messages.map(message => [message.id, message.sender?.id, message.interim ?? false, message.files?.length ?? 0])).toEqual([
      ["req-2", undefined, false, 0], ["4-progress-0", undefined, true, 0], ["4", undefined, false, 1], ["steer-two", "local-two", false, 0], ["6", undefined, false, 0]]);
    expect(JSON.stringify(turn)).not.toContain("private");
    await events.close();
  });

  it("redacts a newly private assistant in the next turn, and ends the stream of a member who can no longer see the assistant", async () => {
    const s = await setup();
    midTurn(s);
    s.hermes.history.push({ row_id: 4, role: "tool", name: "message_agent", content: "Asked", app_run_id: "run-2",
      app_tool_call: { id: "call-4", name: "message_agent", arguments: JSON.stringify({ target: "hidden", text: "secret plan" }), status: "completed" } });
    const events = await stream(s, s.one);
    await s.get(s.one);
    s.hermes.frame("message.delta", { text: "Asking." });
    await events.until(() => events.turns().length === 1);
    expect(JSON.stringify(events.turns()[0])).toContain("secret plan");
    s.store.savePresentation("hidden", { shared: false, ownerId: "local-two" });
    s.hermes.frame("tool.complete", { tool_id: "call-4" });
    s.hermes.frame("message.delta", { text: " Done." });
    await events.until(() => events.turns().length === 2);
    expect(JSON.stringify(events.turns()[1])).not.toContain("secret plan");
    s.store.savePresentation("shared", { shared: false, ownerId: "local-two" });
    s.hermes.frame("tool.complete", { tool_id: "call-5" });
    s.hermes.frame("message.delta", { text: " More." });
    await events.until(() => events.done);
    expect(events.turns()).toHaveLength(2);
  });

  it("starts a stream that connects mid-turn from a whole turn event after its read", async () => {
    const s = await setup();
    midTurn(s);
    // Read earlier, as the home screen's activity does, with no chat open.
    await s.get(s.one);
    s.hermes.history.push(row(4, "assistant", "Looking.", { app_run_id: "run-2" }));
    s.hermes.frame("tool.complete", { tool_id: "t1" });
    await realDelay(25);
    // No stream follows the turn yet, so the frame cost no read.
    expect(opens(s)).toEqual([{ turns: 20 }]);
    const events = await stream(s, s.one);
    await s.get(s.one);
    s.hermes.frame("message.delta", { text: "Looking. Found it." });
    await events.until(() => events.turns().length === 1);
    expect(events.deltas()).toEqual([]);
    expect(events.turns()[0]).toMatchObject({ messages: [{ id: "req-2" }, { id: "4" }], message: { text: "Found it." } });
  });

  it("keeps ?inflight=1 and ?inflight=2 as they were: no turn events, no turn reads", async () => {
    const s = await setup();
    midTurn(s);
    const whole = await stream(s, s.one, "1"), growth = await stream(s, s.two, "2");
    await s.get(s.one);
    s.hermes.frame("message.delta", { text: "Looking." });
    await whole.until(() => whole.events().some(([name]) => name === "inflight"));
    await growth.until(() => growth.events().some(([name]) => name === "inflight"));
    s.hermes.frame("tool.complete", { tool_id: "t1" });
    await growth.until(() => growth.events().some(([name]) => name === "change"));
    await realDelay(25);
    expect(opens(s)).toEqual([{ turns: 20 }]);
    for (const events of [whole, growth]) {
      expect(events.turns()).toEqual([]);
      expect(Object.keys(events.events().find(([name]) => name === "inflight")![1] as object)).toEqual(["botId", "message", "activity", "toolCalls"]);
    }
  });

  it("carries the conversation read's version, which a turn event after it never undercuts", async () => {
    const s = await setup();
    midTurn(s);
    const events = await stream(s, s.one);
    const read = await s.get(s.one);
    s.hermes.frame("message.delta", { text: "Hi" });
    await events.until(() => events.turns().length === 1);
    expect(compareVersions(events.turns()[0].version, read.version)).toBe(0);
    s.hermes.frame("tool.complete", { tool_id: "t1" });
    s.hermes.frame("message.delta", { text: " there" });
    await events.until(() => events.turns().length === 2);
    expect(compareVersions(events.turns()[1].version, read.version)).toBeGreaterThan(0);
  });
});

describe("?inflight=1 and ?inflight=2 beside a turn stream", () => {
  const reset = async () => {
    vi.useRealTimers();
    for (const app of apps.splice(0)) { app.server.closeAllConnections(); await app.close(); }
    vi.unstubAllGlobals();
  };
  // The iOS app in the field reads ?inflight=1 and cannot be updated in step, so the server's own turn reads
  // must never reach it: it gets a live reply only once its own read stored what the reply is built on.
  it.each(["1", "2"] as const)("?inflight=%s gets the same events and reads, in the same steps, with a turn stream beside it", async mode => {
    const alone = await legacyRun(mode, false);
    await reset();
    const beside = await legacyRun(mode, true);
    expect(beside).toEqual(alone);
    // After the tool, nothing live arrives before the change notice's read, which still shows the saved segment.
    const afterTool = alone.filter(entry => (entry as unknown[])[0] === 3).map(entry => (entry as unknown[])[1]);
    expect(afterTool.slice(0, 2)).toEqual(["change", "read"]);
  });
});

describe("the native turn a live reply belongs to, after a steer or queued guidance", () => {
  /** What a client shows of the live reply after these events, applying growth to the last whole reply. */
  const live = (events: (readonly [string, any])[]) => {
    let text = "";
    for (const [name, data] of events) {
      if (name === "inflight" || name === "turn") text = data.message.text;
      if (name === "inflight-delta") { expect(data.baseTextLength).toBe(text.length); text += data.appendText ?? ""; }
    }
    return text;
  };
  type Native = {
    s: Setup;
    /** Hermes streams text, which its snapshot of the native turn accumulates too. `shown` false: it shows nothing yet. */
    say(text: string, shown?: boolean): Promise<void>;
    /** A change to the turn's structure, then the client's read on its change notice, as the app does. */
    structural(change: () => void): Promise<void>;
    /** Hermes starts a native turn with this prompt: a person's message, or guidance it queued instead of steering in. */
    begin(prompt: string): Promise<void>;
    /** Saves the reply so far as a segment before a tool, as Hermes does before each tool call. */
    segment(id: number, text: string, during?: () => void): Promise<void>;
    /** The native turn ends: its reply is saved and Hermes's snapshot of it is cleared. */
    end(): Promise<void>;
    /** Guidance the app admitted as steering, which Hermes saved as a prompt of its own. */
    guidance(id: number, requestId: string, text: string): void;
    /**
     * A new prompt Hermes saved before its native turn starts: the app's, under a new app run `extra.app_run_id`, or another
     * client's, with no app run. Call `begin` next.
     */
    prompt(id: number, text: string, extra?: Record<string, unknown>): void;
    /** The native turn stops, failed or interrupted, and Hermes's snapshot keeps the prompt and the reply it reports. */
    stop(snapshot: Record<string, unknown>): Promise<void>;
  };
  /**
   * The real app through `?inflight=MODE` and the conversation read, with Hermes's frames, saved rows and its snapshot of the
   * native turn (`inflight.user`, `inflight.assistant`) moving as Hermes moves them. The app run `run-2` spans every native turn.
   */
  async function nativeTurns(mode: string, script: (turn: Native) => Promise<void>, prompt?: [Record<string, unknown>, string]) {
    const s = await setup();
    midTurn(s);
    if (prompt) s.hermes.history[2] = prompt[0];
    const events = await stream(s, s.one, mode);
    await s.get(s.one);
    const changes = () => events.events().filter(([name]) => name === "change").length;
    const turn: Native = {
      s,
      async say(text, shown = true) {
        s.hermes.inflight.assistant += text;
        s.hermes.frame("message.delta", { text });
        if (shown) await events.until(() => live(events.events()).endsWith(text.trim()));
        else await vi.advanceTimersByTimeAsync(500);
      },
      async structural(change) {
        const before = changes();
        change();
        await events.until(() => changes() > before);
        await s.get(s.one);
      },
      begin: prompt => turn.structural(() => {
        s.hermes.inflight = { user: prompt, assistant: "" };
        s.hermes.frame("message.start", {});
      }),
      segment: (id, text, during) => turn.structural(() => {
        s.hermes.history.push(row(id, "assistant", text, { app_run_id: "run-2" }));
        s.hermes.frame("tool.start", { tool_id: `t${id}`, name: "terminal" });
        during?.();
        s.hermes.frame("tool.complete", { tool_id: `t${id}`, name: "terminal" });
      }),
      end: () => turn.structural(() => {
        s.hermes.inflight = {};
        s.hermes.frame("message.complete", { text: "" });
      }),
      guidance(id, requestId, text) {
        s.hermes.history.push(row(id, "user", text, { app_request_id: requestId, app_run_id: "run-2", app_steering: true }));
      },
      prompt(id, text, extra = {}) {
        s.hermes.history.push(row(id, "user", text, extra));
        s.hermes.runId = typeof extra.app_run_id === "string" ? extra.app_run_id : undefined;
      },
      stop: snapshot => turn.structural(() => {
        Object.assign(s.hermes, { running: false, runId: undefined, inflight: snapshot });
        s.hermes.frame("message.complete", { text: "" });
      }),
    };
    await turn.begin(prompt?.[1] ?? "Check the barn");
    await script(turn);
    const read = await s.get(s.one);
    const result = { live: live(events.events()), read, turn: events.turns().at(-1) };
    await events.close();
    return result;
  }
  /** Saved text the person sees, each saved row and the live row once, in order. */
  const shown = (messages: Message[]) => messages.filter(message => message.role !== "tool").map(message => message.text);
  const pdf = { path: "/uploads/a.pdf", name: "a.pdf", mime: "application/pdf" };
  /** A hidden prompt Hermes saved for a native turn it started itself, such as a goal continuation. No read shows it. */
  const hidden = (turn: Native, id = 5) => turn.s.hermes.history.push(row(id, "user", "Continue toward the goal.", { display_kind: "hidden", app_run_id: "run-2" }));
  const photo = { path: "/uploads/c.png", name: "c.png", mime: "image/png" };
  const cases: { name: string; script: (turn: Native) => Promise<void>; live: string; turn: string[]; shown: string[];
    /**
     * The native turn stopped. Hermes's snapshot still holds its prompt and reply, but the stream sends no live text after the
     * stop: modes 1 and 2 send nothing and mode 3 a last turn with an empty reply. Every client takes the settled read over
     * a retained live tail, so the read's live row, `live`, is what shows.
     */
    settled?: true;
    /** The native turn's saved prompt row and the prompt Hermes reports for it, in place of "Check the barn". */
    prompt?: [Record<string, unknown>, string] }[] = [
    {
      // The reviewer's order. Hermes queued the guidance instead of steering it in, so it started a native turn of its own
      // under the same app run, and that turn's live text holds only what it said.
      name: "guidance Hermes queued, which started its own native turn",
      async script(turn) {
        await turn.say("Barn is dry.");
        turn.s.hermes.history.push(row(4, "assistant", "Barn is dry.", { app_run_id: "run-2" }));
        await turn.end();
        turn.guidance(5, "steer-two", "Check the loft");
        await turn.begin("Check the loft");
        await turn.say("Loft checked.");
        await turn.segment(6, "Loft checked.");
        await turn.say(" Dry.");
      },
      live: "Dry.", turn: ["steer-two", "6"],
      shown: ["Fence?", "Fixed.", "Check the barn", "Barn is dry.", "Check the loft", "Loft checked.", "Dry."],
    },
    {
      // Round 1's order. Steered in place, the guidance joins the running native turn, whose live text still holds "Looking.".
      name: "guidance steered into the running native turn",
      async script(turn) {
        await turn.say("Looking.");
        // Hermes saves the segment before the tool and the steered guidance after it. Its snapshot keeps the turn's prompt.
        await turn.segment(4, "Looking.", () => turn.guidance(5, "steer-two", "Check the loft too"));
        await turn.say(" Loft checked.");
        await turn.say(" Dry.");
      },
      live: "Loft checked. Dry.", turn: ["req-2", "4", "steer-two"],
      shown: ["Fence?", "Fixed.", "Check the barn", "Looking.", "Check the loft too", "Loft checked. Dry."],
    },
    {
      name: "guidance Hermes queued after the original turn saved nothing",
      async script(turn) {
        await turn.structural(() => {
          turn.s.hermes.history.push({ row_id: 4, role: "tool", name: "terminal", content: "ok", app_run_id: "run-2" });
          turn.s.hermes.frame("tool.complete", { tool_id: "t4", name: "terminal" });
        });
        await turn.end();
        turn.guidance(5, "steer-two", "Check the loft");
        await turn.begin("Check the loft");
        await turn.say("Loft checked.");
        await turn.segment(6, "Loft checked.");
        await turn.say(" Dry.");
      },
      live: "Dry.", turn: ["steer-two", "6"],
      shown: ["Fence?", "Fixed.", "Check the barn", "Check the loft", "Loft checked.", "Dry."],
    },
    {
      name: "two guidance messages Hermes queued in a row, each its own native turn",
      async script(turn) {
        await turn.say("Barn is dry.");
        turn.s.hermes.history.push(row(4, "assistant", "Barn is dry.", { app_run_id: "run-2" }));
        await turn.end();
        turn.guidance(5, "steer-two", "Check the loft");
        await turn.begin("Check the loft");
        await turn.say("Loft checked.");
        turn.s.hermes.history.push(row(6, "assistant", "Loft checked.", { app_run_id: "run-2" }));
        await turn.end();
        turn.guidance(7, "steer-three", "And the gate");
        await turn.begin("And the gate");
        await turn.say("Gate shut.");
        await turn.segment(8, "Gate shut.");
        await turn.say(" Latched.");
      },
      live: "Latched.", turn: ["steer-three", "8"],
      shown: ["Fence?", "Fixed.", "Check the barn", "Barn is dry.", "Check the loft", "Loft checked.", "And the gate", "Gate shut.", "Latched."],
    },
    {
      // Both native turns save "Checked." first. Only the boundary tells which one the live text's "Checked." is.
      name: "two native turns that each save the same short sentence",
      async script(turn) {
        await turn.say("Checked.");
        await turn.segment(4, "Checked.");
        await turn.end();
        turn.guidance(5, "steer-two", "Check the loft");
        await turn.begin("Check the loft");
        await turn.say("Checked.");
        await turn.segment(6, "Checked.");
        await turn.say(" Loft dry.");
        await turn.segment(7, "Loft dry.");
        await turn.say(" Done.");
      },
      live: "Done.", turn: ["steer-two", "6", "7"],
      shown: ["Fence?", "Fixed.", "Check the barn", "Checked.", "Check the loft", "Checked.", "Loft dry.", "Done."],
    },
    {
      // The reviewer's order. The app sent a newline and the reference, which the add-on leaves out of the saved prompt's
      // text. Hermes strips the whole prompt, so it reports only the reference, with no newline before it.
      name: "a file sent alone",
      prompt: [row(3, "user", '\n@file:"/uploads/a.pdf"', { app_request_id: "req-2", app_run_id: "run-2", app_display_text: "", app_attachments: [pdf] }),
        '@file:"/uploads/a.pdf"'],
      async script(turn) {
        await turn.say("Read it.");
        await turn.segment(4, "Read it.");
        await turn.say(" Two pages.");
      },
      live: "Two pages.", turn: ["req-2", "4"],
      shown: ["Fence?", "Fixed.", "", "Read it.", "Two pages."],
    },
    {
      // The reviewer's order. The continuation's prompt is hidden, so the boundary falls back to the last shown prompt, as on
      // main, and the two "Checked." segments are both stripped from the front of the live text.
      name: "a hidden continuation that saves what the turn before it saved",
      async script(turn) {
        await turn.say("Checked.");
        await turn.segment(4, "Checked.");
        await turn.end();
        hidden(turn);
        await turn.begin("Continue toward the goal.");
        // Until it says more, the live "Checked." is the earlier turn's saved one, so nothing shows, as on main.
        await turn.say("Checked.", false);
        await turn.segment(6, "Checked.");
        await turn.say(" Loft dry.");
      },
      live: "Loft dry.", turn: ["req-2", "4", "6"],
      shown: ["Fence?", "Fixed.", "Check the barn", "Checked.", "Checked.", "Loft dry."],
    },
    {
      name: "a hidden continuation that saved nothing yet",
      async script(turn) {
        await turn.say("Checked.");
        await turn.segment(4, "Checked.");
        await turn.end();
        hidden(turn);
        await turn.begin("Continue toward the goal.");
        await turn.say("Loft dry.");
      },
      live: "Loft dry.", turn: ["req-2", "4"],
      shown: ["Fence?", "Fixed.", "Check the barn", "Checked.", "Loft dry."],
    },
    {
      // A prompt Hermes reports before it saved it falls back to the last prompt too. The earlier turn's "Checked." does not
      // match this turn's first words, so stripping stops there. The known gap is a turn whose live text starts with them.
      name: "a prompt not saved yet, whose reply starts with other words than the turn before",
      async script(turn) {
        await turn.say("Checked.");
        await turn.segment(4, "Checked.");
        await turn.end();
        await turn.begin("Check the loft");
        await turn.say("Loft dry.");
      },
      live: "Loft dry.", turn: ["req-2", "4"],
      shown: ["Fence?", "Fixed.", "Check the barn", "Checked.", "Loft dry."],
    },
  ];
  // The boundary looks for the reported prompt only among the trailing prompts: the last one and the steered guidance directly
  // before it, back to and including the first prompt that is not guidance. The three orders below are GPT-6.1 Sol's, where
  // a search of the whole history reached an older prompt with the same text. Each matches nothing in the trailing prompts
  // and falls back to the last prompt, so it shows what main shows.
  cases.push(
    {
      // Another client's image saves its own `@image:` text, so the app image's empty prompt is not the last one.
      name: "another client's uncaptioned image after an app image sent alone, both finished",
      prompt: [row(3, "user", "@image:/uploads/c.png", { app_request_id: "req-2", app_run_id: "run-2", app_display_text: "", app_attachments: [photo] }), ""],
      async script(turn) {
        await turn.say("Read it.");
        turn.s.hermes.history.push(row(4, "assistant", "Read it.", { app_run_id: "run-2" }));
        await turn.end();
        turn.prompt(5, "@image:/uploads/d.png");
        await turn.begin("");
        await turn.say("A cow.");
        // Hermes saved the reply and its snapshot of the finished turn still holds it.
        turn.s.hermes.history.push(row(6, "assistant", "A cow."));
        await turn.stop({ user: "", assistant: "A cow." });
      },
      live: "", turn: ["5", "6"],
      settled: true,
      shown: ["Fence?", "Fixed.", "", "Read it.", "@image:/uploads/d.png", "A cow."],
    },
    {
      // Hermes removes bracketed-paste markers from the prompt it reports, and the add-on keeps them in the saved row.
      name: "a failed pasted prompt whose reported text equals an older prompt",
      prompt: [row(3, "user", "Check the gate", { app_request_id: "req-2", app_run_id: "run-2" }), "Check the gate"],
      async script(turn) {
        await turn.say("Looking.");
        await turn.segment(4, "Looking.");
        await turn.say(" Gate shut.");
        turn.s.hermes.history.push(row(5, "assistant", "Gate shut.", { app_run_id: "run-2" }));
        await turn.end();
        turn.prompt(6, "[200~Check the gate[201~", { app_request_id: "req-3", app_run_id: "run-3" });
        await turn.begin("Check the gate");
        await turn.say("Looking.");
        await turn.say(" Gate open.");
        await turn.stop({ user: "Check the gate", assistant: "Looking. Gate open.", error: "boom" });
      },
      live: "Looking. Gate open.", turn: ["req-3"],
      settled: true,
      shown: ["Fence?", "Fixed.", "Check the gate", "Looking.", "Gate shut.", "[200~Check the gate[201~", "Looking. Gate open."],
    },
    {
      name: "a prompt not saved yet that repeats a prompt before the last one, interrupted",
      async script(turn) {
        await turn.say("Barn checked.");
        turn.s.hermes.history.push(row(4, "assistant", "Barn checked.", { app_run_id: "run-2" }));
        await turn.end();
        turn.prompt(5, "Check the loft", { app_request_id: "req-3", app_run_id: "run-3" });
        await turn.begin("Check the loft");
        await turn.say("Loft checked.");
        turn.s.hermes.history.push(row(6, "assistant", "Loft checked.", { app_run_id: "run-3" }));
        await turn.end();
        // The app admitted "Check the barn" again as run-4. Hermes reports its prompt before it saved it.
        turn.s.hermes.runId = "run-4";
        await turn.begin("Check the barn");
        await turn.say("Barn checked.");
        await turn.say(" Door shut.");
        await turn.stop({ user: "Check the barn", assistant: "Barn checked. Door shut.", interrupted: true });
      },
      live: "Barn checked. Door shut.", turn: ["req-3", "6"],
      settled: true,
      shown: ["Fence?", "Fixed.", "Check the barn", "Barn checked.", "Check the loft", "Loft checked.", "Barn checked. Door shut."],
    },
    {
      // Identical to main: the hidden prompt matches nothing, and the last shown prompt is the queued guidance.
      name: "a hidden continuation after guidance Hermes queued",
      async script(turn) {
        await turn.say("Barn is dry.");
        turn.s.hermes.history.push(row(4, "assistant", "Barn is dry.", { app_run_id: "run-2" }));
        await turn.end();
        turn.guidance(5, "steer-two", "Check the loft");
        await turn.begin("Check the loft");
        await turn.say("Checked.");
        await turn.segment(6, "Checked.");
        await turn.end();
        hidden(turn, 7);
        await turn.begin("Continue toward the goal.");
        await turn.say("Checked.", false);
        await turn.segment(8, "Checked.");
        await turn.say(" Loft dry.");
      },
      live: "Loft dry.", turn: ["steer-two", "6", "8"],
      shown: ["Fence?", "Fixed.", "Check the barn", "Barn is dry.", "Check the loft", "Checked.", "Checked.", "Loft dry."],
    },
    {
      // Differs from main, which strips from the last prompt, the guidance, and so repeats "Read it.".
      name: "an image sent alone, then guidance steered into its turn",
      prompt: [row(3, "user", "@image:/uploads/c.png", { app_request_id: "req-2", app_run_id: "run-2", app_display_text: "", app_attachments: [photo] }), ""],
      async script(turn) {
        await turn.say("Read it.");
        await turn.segment(4, "Read it.", () => turn.guidance(5, "steer-two", "Summarize it"));
        await turn.say(" Two pages.");
      },
      live: "Two pages.", turn: ["req-2", "4", "steer-two"],
      shown: ["Fence?", "Fixed.", "", "Read it.", "Summarize it", "Two pages."],
    },
    {
      // Differs from main, which strips from the second guidance and so repeats both segments.
      name: "two guidance messages steered into the running native turn",
      async script(turn) {
        await turn.say("Looking.");
        await turn.segment(4, "Looking.", () => turn.guidance(5, "steer-two", "Check the loft too"));
        await turn.say(" Loft checked.");
        await turn.segment(6, "Loft checked.", () => turn.guidance(7, "steer-three", "And the gate"));
        await turn.say(" Gate shut.");
      },
      live: "Gate shut.", turn: ["req-2", "4", "steer-two", "6", "steer-three"],
      shown: ["Fence?", "Fixed.", "Check the barn", "Looking.", "Check the loft too", "Loft checked.", "And the gate", "Gate shut."],
    },
    {
      // Differs from main, which strips from the steered guidance and so repeats "Loft checked.".
      name: "guidance Hermes queued, then guidance steered into that native turn",
      async script(turn) {
        await turn.say("Barn is dry.");
        turn.s.hermes.history.push(row(4, "assistant", "Barn is dry.", { app_run_id: "run-2" }));
        await turn.end();
        turn.guidance(5, "steer-two", "Check the loft");
        await turn.begin("Check the loft");
        await turn.say("Loft checked.");
        await turn.segment(6, "Loft checked.", () => turn.guidance(7, "steer-three", "And the gate"));
        await turn.say(" Gate shut.");
      },
      live: "Gate shut.", turn: ["steer-two", "6", "steer-three"],
      shown: ["Fence?", "Fixed.", "Check the barn", "Barn is dry.", "Check the loft", "Loft checked.", "And the gate", "Gate shut."],
    },
    {
      // The accepted gap, pinned as the rule gives it. Queued guidance "Check the loft" started its own native turn, and Hermes
      // now reports a new native turn whose prompt, "Check the barn" again, it has not saved. The rule matches the run's first
      // prompt, which ends the trailing prompts, so "Barn checked." is stripped as if the guidance had been steered into the
      // barn turn. Main strips from the guidance and shows the whole reply. Rows and text cannot tell the two apart. It needs
      // an unsaved prompt that repeats one in the trailing prompts and a reply that starts with that turn's first saved words,
      // and it clears once Hermes saves the prompt, which is then the last match. 5688e59 shows the same.
      name: "the accepted gap: a native turn not saved yet that repeats the run's first prompt after queued guidance",
      async script(turn) {
        await turn.say("Barn checked.");
        turn.s.hermes.history.push(row(4, "assistant", "Barn checked.", { app_run_id: "run-2" }));
        await turn.end();
        turn.guidance(5, "steer-two", "Check the loft");
        await turn.begin("Check the loft");
        await turn.say("Loft checked.");
        turn.s.hermes.history.push(row(6, "assistant", "Loft checked.", { app_run_id: "run-2" }));
        await turn.end();
        await turn.begin("Check the barn");
        await turn.say("Barn checked.", false);
        await turn.say(" Door shut.");
      },
      live: "Door shut.", turn: ["req-2", "4", "steer-two", "6"],
      shown: ["Fence?", "Fixed.", "Check the barn", "Barn checked.", "Check the loft", "Loft checked.", "Door shut."],
    },
  );
  describe.each(cases)("$name", ({ script, live: expected, turn: ids, shown: texts, prompt, settled }) => {
    it.each(["1", "2", "3"])("?inflight=%s and the conversation read show each saved segment once", async mode => {
      const result = await nativeTurns(mode, script, prompt);
      if (!settled) expect(result.live).toBe(expected);
      if (expected) expect(result.read.messages.at(-1)).toMatchObject({ id: "live-one-inflight", text: expected });
      else expect(result.read.messages.map(message => message.id)).not.toContain("live-one-inflight");
      expect(shown(result.read.messages)).toEqual(texts);
      if (mode !== "3") return;
      // The event starts at the native turn's prompt, and the client keeps every earlier row it holds above it.
      expect(result.turn!.messages.map(message => message.id)).toEqual(ids);
      const reply = expected ? [{ ...result.turn!.message, text: expected }] : [];
      expect(shown([...placeTurn(saved(result.read.messages), result.turn!)!, ...reply])).toEqual(texts);
    });
  });
});
