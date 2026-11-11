import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DECISION_FOLLOW_MS, FOLLOW_MS, TalkLoop, type TalkLoopHost } from "../src/app/talk-loop";

// Follow-up asks wait between tries, so time is simulated.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
import type { TalkAnswer } from "../src/shared/voice";

function setup(answers: (TalkAnswer | Error)[]) {
  const sent: Record<string, unknown>[] = [];
  const asks: [string, string][] = [];
  // The progress line IDs the loop reported as heard with each ask.
  const heardWith: string[][] = [];
  const phases: string[] = [];
  const pending = [...answers];
  const host: TalkLoopHost = {
    send: event => { sent.push(event); },
    ask: async (requestId, request, _signal, heard) => {
      asks.push([requestId, request]);
      heardWith.push([...heard]);
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
  const items = () => sent.filter(event => event.type === "conversation.item.create").map(event => JSON.stringify(event.item));
  return { loop, host, sent, asks, heardWith, phases, call, types, settle, items };
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

describe("talk progress narration", () => {
  const line = (id: string, text: string) => ({ state: "working" as const, progress: { ids: [id], text } });
  it("answers the call with the first progress line, then follows without saying it twice", async () => {
    const s = setup([line("n1", "Checking the forecast."), { state: "done", text: "Sunny." }]);
    s.call();
    await s.settle();
    expect(s.sent[0]).toMatchObject({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "call-1" } });
    expect(s.items()[0]).toContain("Checking the forecast.");
    expect(s.items()[0]).not.toContain("still working");
    s.loop.handle({ type: "response.done" });
    await s.settle(FOLLOW_MS);
    // The follow-up reports the line as heard, so the server leaves it out.
    expect(s.heardWith).toEqual([[], ["n1"]]);
    expect(s.items()).toHaveLength(2);
    expect(s.items()[1]).toContain("Sunny.");
  });
  it("says each later line once, as its own spoken note, when the voice is free", async () => {
    const s = setup([line("n1", "Checking the forecast."), line("n2", "Now the radar."), { state: "working" }, { state: "done", text: "Sunny." }]);
    s.call();
    await s.settle();
    s.loop.handle({ type: "response.done" });
    await s.settle(FOLLOW_MS);
    expect(s.items()[1]).toContain("Now the radar.");
    expect(s.items()[1]).toContain("About the earlier request");
    expect(s.types().filter(type => type === "response.create")).toHaveLength(2);
    s.loop.handle({ type: "response.done" });
    await s.settle(FOLLOW_MS);
    expect(s.heardWith).toEqual([[], ["n1"], ["n1", "n2"]]);
    // The third answer is working with nothing new, which says nothing.
    expect(s.items()).toHaveLength(2);
  });
  it("holds a line that arrives while the voice is busy and says it once the response ends", async () => {
    const s = setup([line("n1", "Checking the forecast."), line("n2", "Now the radar."), { state: "working" }]);
    s.call();
    await s.settle();
    // The first line is still being said when the second arrives.
    await s.settle(FOLLOW_MS);
    expect(s.items()).toHaveLength(1);
    expect(s.types().filter(type => type === "response.create")).toHaveLength(1);
    s.loop.handle({ type: "response.done" });
    expect(s.items()).toHaveLength(2);
    expect(s.items()[1]).toContain("Now the radar.");
    expect(s.types().filter(type => type === "response.create")).toHaveLength(2);
    // That one response is active now, so nothing else is sent over it.
    await s.settle(FOLLOW_MS);
    expect(s.types().filter(type => type === "response.create")).toHaveLength(2);
  });
  it("speaks only the answer when it arrives before a held line could be said", async () => {
    const s = setup([line("n1", "Checking the forecast."), line("n2", "Now the radar."), { state: "done", text: "Sunny, 75." }]);
    s.loop.handle({ type: "response.created" });
    s.call();
    await s.settle(); await s.settle(FOLLOW_MS); await s.settle(FOLLOW_MS);
    const said = s.items().join("\n");
    expect(said).toContain("Sunny, 75.");
    expect(said).not.toContain("Now the radar.");
    s.loop.handle({ type: "response.done" });
    s.loop.handle({ type: "response.done" });
    expect(s.items().join("\n")).not.toContain("Now the radar.");
  });
  it("keeps a held line apart for each request and drops it when its request ends", async () => {
    const s = setup([line("n1", "Checking the forecast."), line("n2", "Now the radar."), new Error("Hermes restarted.")]);
    s.call();
    await s.settle(); await s.settle(FOLLOW_MS); await s.settle(FOLLOW_MS);
    // The failure while following is said, and the held radar line is old news with it.
    s.loop.handle({ type: "response.done" });
    s.loop.handle({ type: "response.done" });
    expect(s.items().join("\n")).not.toContain("Now the radar.");
    expect(s.items().join("\n")).toContain("could not reach");
  });
  it("does not tell a spoken request that its draft is saved when the app refuses it during an upgrade", async () => {
    const s = setup([new Error("Hermes is being upgraded. Your draft is saved; send it after the update finishes.")]);
    s.call();
    await s.settle();
    const said = s.items().join("\n");
    expect(said).toContain("could not reach Ranch Hand: Hermes is being upgraded.");
    expect(said).not.toContain("draft");
  });
  it("reports at most the newest 500 lines heard, so a long run never makes its own next ask invalid", async () => {
    const ids = Array.from({ length: 600 }, (_, index) => `n${index}`);
    const s = setup([{ state: "working", progress: { ids, text: "Checking." } }, { state: "done", text: "Sunny." }]);
    s.call();
    await s.settle();
    s.loop.handle({ type: "response.done" });
    await s.settle(FOLLOW_MS);
    expect(s.heardWith[1]).toHaveLength(500);
    expect(s.heardWith[1]![0]).toBe("n100");
    expect(s.heardWith[1]!.at(-1)).toBe("n599");
  });
  it("shares what it has heard between requests, so a line of a shared run is said once", async () => {
    const s = setup([line("n1", "Checking the forecast."), { state: "done", text: "Sunny." }, { state: "working" }]);
    s.call({ request: "Weather today?" });
    await s.settle(); await s.settle(FOLLOW_MS);
    s.call({ request: "And tomorrow?" });
    await s.settle();
    // The second request starts out knowing the first's line was said.
    expect(s.heardWith.at(-1)).toEqual(["n1"]);
  });
  it("never speaks held lines after Talk ends", async () => {
    const s = setup([line("n1", "Checking the forecast."), line("n2", "Now the radar.")]);
    s.call();
    await s.settle(); await s.settle(FOLLOW_MS);
    s.loop.dispose();
    s.loop.handle({ type: "response.done" });
    expect(s.items()).toHaveLength(1);
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
