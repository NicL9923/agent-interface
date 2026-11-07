import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DECISION_FOLLOW_MS, FOLLOW_MS, TalkLoop, type TalkLoopHost } from "../src/app/talk-loop";

// Follow-up asks wait between tries, so time is simulated.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
import type { TalkAnswer } from "../src/shared/voice";

function setup(answers: (TalkAnswer | Error)[]) {
  const sent: Record<string, unknown>[] = [];
  const asks: [string, string][] = [];
  const phases: string[] = [];
  const pending = [...answers];
  const host: TalkLoopHost = {
    send: event => { sent.push(event); },
    ask: async (requestId, request) => {
      asks.push([requestId, request]);
      const next = pending.shift() ?? { state: "working" };
      if (next instanceof Error) throw next;
      return next;
    },
    phase: phase => { phases.push(phase); },
    captions: vi.fn(), activity: vi.fn(), problem: vi.fn(),
    newId: () => "request-1",
  };
  const loop = new TalkLoop(host, "Ranch Hand");
  const call = (args: unknown = { request: "Is the gate shut?" }) =>
    loop.handle({ type: "response.function_call_arguments.done", name: "ask_assistant", call_id: "call-1", arguments: JSON.stringify(args) });
  const types = () => sent.map(event => event.type);
  const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
  return { loop, host, sent, asks, phases, call, types, settle };
}

describe("talk tool loop", () => {
  it("answers a finished request and asks for a spoken response", async () => {
    const s = setup([{ state: "done", text: "The gate is shut." }]);
    s.call();
    await s.settle();
    expect(s.asks).toEqual([["request-1", "Is the gate shut?"]]);
    expect(s.sent[0]).toEqual({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "call-1", output: "Ranch Hand answered: The gate is shut." } });
    expect(s.types()).toEqual(["conversation.item.create", "response.create"]);
    expect(s.phases).toContain("working");
  });

  it("queues response.create while a response is active and sends it once that one is done", async () => {
    const s = setup([{ state: "done", text: "Shut." }]);
    s.loop.handle({ type: "response.created" });
    s.call();
    await s.settle();
    expect(s.types()).toEqual(["conversation.item.create"]);
    s.loop.handle({ type: "response.done" });
    expect(s.types()).toEqual(["conversation.item.create", "response.create"]);
    // Counted active until the server confirms, so a second request in that gap waits too.
    s.loop.respond();
    expect(s.types().filter(type => type === "response.create")).toHaveLength(1);
    s.loop.handle({ type: "response.done" });
    expect(s.types().filter(type => type === "response.create")).toHaveLength(2);
  });

  it("recovers from the server's active-response refusal by sending after the current response", () => {
    const s = setup([]);
    s.loop.respond();
    s.loop.handle({ type: "response.done" });
    s.loop.respond();
    s.loop.handle({ type: "error", error: { code: "conversation_already_has_active_response", message: "busy" } });
    expect(s.host.problem).not.toHaveBeenCalled();
    s.loop.handle({ type: "response.done" });
    expect(s.types()).toEqual(["response.create", "response.create", "response.create"]);
  });

  it("says a working request will follow, keeps asking with the same ID, then speaks the answer", async () => {
    const s = setup([{ state: "working" }, { state: "working" }, { state: "done", text: "Fed the horses." }]);
    s.call({ request: "Feed the horses" });
    await s.settle();
    s.loop.handle({ type: "response.done" });
    await s.settle(FOLLOW_MS); await s.settle(FOLLOW_MS);
    expect(s.asks.map(([id]) => id)).toEqual(["request-1", "request-1", "request-1"]);
    const outputs = s.sent.filter(event => event.type === "conversation.item.create").map(event => event.item as Record<string, unknown>);
    expect(outputs[0]).toMatchObject({ type: "function_call_output", output: expect.stringContaining("still working") });
    expect(outputs[1]).toMatchObject({ type: "message", role: "system" });
    expect(JSON.stringify(outputs[1])).toContain("Fed the horses.");
    expect(outputs).toHaveLength(2);
  });

  it("tells the person to check the screen for approvals and questions", async () => {
    const s = setup([{ state: "needsApproval", text: "Run the sprinkler?" }, { state: "done", text: "Sprinkler on." }]);
    s.call();
    await s.settle(); await s.settle(DECISION_FOLLOW_MS);
    const items = s.sent.filter(event => event.type === "conversation.item.create").map(event => JSON.stringify(event.item));
    expect(items[0]).toContain("check the screen");
    expect(items[0]).toContain("Run the sprinkler?");
    expect(items[1]).toContain("Sprinkler on.");
  });

  it("waits between asks while a decision stays pending, instead of asking in a tight loop", async () => {
    const pending = Array.from({ length: 100 }, () => ({ state: "needsApproval" as const, text: "Open the gate?" }));
    const s = setup(pending);
    s.call();
    await s.settle(60_000);
    // One ask, then one every five seconds for a minute.
    expect(s.asks.length).toBeLessThanOrEqual(1 + 60_000 / DECISION_FOLLOW_MS);
    expect(s.asks.length).toBeGreaterThan(5);
    // The screen prompt is said once, not on every repeat.
    expect(s.sent.filter(event => event.type === "conversation.item.create")).toHaveLength(1);
    s.loop.dispose();
    await s.settle();
    // Disposal clears the pending wait, so nothing is left to fire.
    expect(vi.getTimerCount()).toBe(0);
    const asked = s.asks.length;
    await s.settle(60_000);
    expect(s.asks.length).toBe(asked);
  });

  it("answers a failed send once, and an empty request without asking", async () => {
    const s = setup([new Error("Hermes is being upgraded.")]);
    s.call();
    await s.settle();
    expect(JSON.stringify(s.sent[0])).toContain("Hermes is being upgraded.");
    const empty = setup([]);
    empty.call({ request: "  " });
    await empty.settle();
    expect(empty.asks).toEqual([]);
    expect(JSON.stringify(empty.sent[0])).toContain("No request was given");
  });

  it("stops following and sending once disposed", async () => {
    const s = setup([{ state: "working" }]);
    s.call();
    s.loop.dispose();
    await s.settle();
    s.loop.handle({ type: "response.created" });
    expect(s.sent).toEqual([]);
  });

  it("shows the latest words from each side", () => {
    const s = setup([]);
    s.loop.handle({ type: "conversation.item.input_audio_transcription.completed", transcript: " Howdy " });
    s.loop.handle({ type: "response.output_audio_transcript.delta", delta: "Hey " });
    s.loop.handle({ type: "response.output_audio_transcript.delta", delta: "there." });
    expect(s.host.captions).toHaveBeenLastCalledWith({ you: "Howdy", assistant: "Hey there." });
    s.loop.handle({ type: "response.output_audio_transcript.done", transcript: "Hey there." });
    s.loop.handle({ type: "response.output_audio_transcript.delta", delta: "Next" });
    expect(s.host.captions).toHaveBeenLastCalledWith({ you: "Howdy", assistant: "Next" });
  });
});

it("allows a new response after a failed response.create", () => {
  const s = setup([]);
  s.loop.respond();
  s.loop.handle({ type: "error", error: { code: "invalid_request_error", message: "Try again" } });
  s.loop.respond();
  expect(s.types().filter(type => type === "response.create")).toHaveLength(2);
});

it("keeps working visible when speech starts during an assistant request", async () => {
  const s = setup([{ state: "working" }]);
  s.call();
  await s.settle();
  s.loop.handle({ type: "input_audio_buffer.speech_started" });
  expect(s.phases.at(-1)).toBe("working");
  s.loop.dispose();
});
