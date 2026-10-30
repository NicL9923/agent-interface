import { describe, expect, it } from "vitest";
import { applyInflightDelta } from "../src/shared/inflight";
import type { Inflight, InflightDelta } from "../src/shared/types";

const held: Inflight = {
  botId: "shared",
  message: { id: "sid-inflight", role: "assistant", text: "Hello", reasoning: "Hm" },
  activity: { state: "thinking", runId: "run" },
  toolCalls: [{ id: "call", name: "web_search", arguments: "{}", status: "running" }],
};
const delta = (changes: Partial<InflightDelta> = {}): InflightDelta => ({
  botId: "shared", messageId: "sid-inflight", baseTextLength: 5, baseReasoningLength: 2,
  activity: { state: "working", runId: "run" }, ...changes,
});

describe("applyInflightDelta", () => {
  it("appends to the held reply and keeps tool calls the notice leaves out", () => {
    expect(applyInflightDelta(held, delta({ appendText: " there", appendReasoning: ", ok" }))).toEqual({
      ...held,
      message: { ...held.message, text: "Hello there", reasoning: "Hm, ok" },
      activity: { state: "working", runId: "run" },
    });
  });

  it("replaces tool calls only when the notice carries them", () => {
    expect(applyInflightDelta(held, delta({ toolCalls: [] }))?.toolCalls).toEqual([]);
  });

  it("starts reasoning on a reply that had none", () => {
    const { reasoning: _, ...message } = held.message;
    const plain = { ...held, message };
    const next = applyInflightDelta(plain, delta({ baseReasoningLength: 0, appendReasoning: "Thinking" }));
    expect(next?.message).toMatchObject({ text: "Hello", reasoning: "Thinking" });
    expect(applyInflightDelta(plain, delta({ baseReasoningLength: 0 }))?.message).not.toHaveProperty("reasoning");
  });

  it.each([
    ["nothing held", undefined, delta()],
    ["another message", held, delta({ messageId: "other-inflight" })],
    ["another assistant", held, delta({ botId: "other" })],
    ["a text base that disagrees", held, delta({ baseTextLength: 4 })],
    ["a reasoning base that disagrees", held, delta({ baseReasoningLength: 0 })],
  ])("refuses a notice that continues %s", (_name, current, change) => {
    expect(applyInflightDelta(current, change)).toBeUndefined();
  });
});
