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
