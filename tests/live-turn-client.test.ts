import { describe, expect, it } from "vitest";
import { nextEchoes, withEchoes } from "../src/app/sent-echo";
import type { Pending, SavedConversation } from "../src/app/storage";
import { compareVersions, placeTurn, withTurn } from "../src/shared/inflight";
import type { Message, TurnEvent } from "../src/shared/types";

const message = (id: string, role: Message["role"] = "assistant", text = id): Message => ({ id, role, text });
const turn = (version: string, messages: Message[], extra: Partial<TurnEvent> = {}): TurnEvent => ({
  botId: "bot", version, messages, message: message("sid-inflight", "assistant", "Live"), activity: { state: "thinking", runId: "run" }, toolCalls: [], ...extra });

describe("compareVersions", () => {
  it("orders by connection epoch first, then by structural generation", () => {
    expect(compareVersions("b:1:9", "b:2:0")).toBeLessThan(0);
    expect(compareVersions("b:2:10", "b:2:9")).toBeGreaterThan(0);
    expect(compareVersions("b:2:9", "b:2:9")).toBe(0);
  });
  it.each([
    ["another server process", "a:5:5", "b:1:1"],
    ["a missing version", undefined, "b:1:1"],
    ["a malformed version", "b:1", "b:1:1"],
    ["a non-numeric generation", "b:1:x", "b:1:1"],
  ])("calls nothing older or newer across %s", (_name, a, b) => {
    expect(compareVersions(a, b)).toBeUndefined();
  });
});

describe("placeTurn", () => {
  const held = [message("u1", "user"), message("a1"), message("u2", "user"), message("old-inflight")];
  it("replaces everything from the turn's first message on, dropping the live reply", () => {
    expect(placeTurn(held, { messages: [message("u2", "user"), message("a2")] })!.map(item => item.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });
  it("places a turn whose prompt is not held yet after the message it names", () => {
    expect(placeTurn(held, { after: "u2", messages: [message("u3", "user")] })!.map(item => item.id)).toEqual(["u1", "a1", "u2", "u3"]);
  });
  it("replaces everything for a turn that starts the history", () => {
    expect(placeTurn(held, { after: null, messages: [message("u1", "user")] })!.map(item => item.id)).toEqual(["u1"]);
  });
  it.each([
    ["holds neither its first message nor the one before it", { after: "gone", messages: [message("u9", "user")] }],
    ["names no message before it and its first is not held", { messages: [message("u9", "user")] }],
    ["would repeat a message kept before it", { after: "u1", messages: [message("u2", "user"), message("a1")] }],
  ])("cannot place a turn that %s", (_name, rows) => {
    expect(placeTurn(held, rows)).toBeUndefined();
  });
});

describe("withTurn", () => {
  const conversation = { botId: "bot", messages: [message("u2", "user")], activity: { state: "thinking" as const, runId: "run" }, toolCalls: [], version: "b:1:5" };
  it("leaves a newer conversation as it is", () => {
    expect(withTurn(conversation, turn("b:1:4", [message("u2", "user"), message("a2")]))).toBe(conversation);
  });
  it("takes the turn's messages, version, activity and tools from an equal or newer turn", () => {
    const tool = { id: "t", name: "terminal", status: "running" as const };
    expect(withTurn(conversation, turn("b:1:6", [message("u2", "user"), message("a2")], { activity: { state: "working", runId: "run" }, toolCalls: [tool] }))).toEqual({
      ...conversation, messages: [message("u2", "user"), message("a2")], version: "b:1:6", activity: { state: "working", runId: "run" }, toolCalls: [tool] });
  });
  it("reports a turn it cannot place", () => {
    expect(withTurn(conversation, turn("b:1:6", [message("u9", "user")]))).toBeUndefined();
  });
});

describe("a turn event and the sent echo", () => {
  const sender = { id: "one", name: "One" };
  const pending: Pending = { requestId: "req-3", botId: "bot", text: "And the gate?", attachments: [], reviewedInterruption: false };
  const read = (): SavedConversation => ({ botId: "bot", messages: [message("u2", "user"), message("a2")], approvals: [], files: [],
    activity: { state: "done", runId: "run" }, version: "b:1:5", draft: null, readPosition: null });
  it("replaces the echo with Hermes's copy, once, even before the send's receipt", () => {
    const before = read();
    const echoes = nextEchoes([], { pending, receipt: null, sending: true, conversation: before, sender, now: 1000 });
    expect(withEchoes(before, echoes)!.messages.map(item => item.id)).toEqual(["u2", "a2", "req-3"]);
    // The new run's first turn event carries the prompt as Hermes saved it, named by the request's ID.
    const after = withTurn(before, turn("b:1:6", [{ ...message("req-3", "user", "And the gate?"), sender }], { after: "a2", activity: { state: "thinking", runId: "run-3" } }))!;
    const next = nextEchoes(echoes, { pending, receipt: null, sending: true, conversation: after, sender, now: 1100 });
    expect(next).toEqual([]);
    expect(withEchoes(after, next)!.messages.filter(item => item.text === "And the gate?").map(item => item.id)).toEqual(["req-3"]);
    // The receipt arriving later brings nothing back.
    expect(nextEchoes(next, { pending: null, receipt: { requestId: "req-3", status: "accepted", runId: "run-3" }, sending: false, conversation: after, sender, now: 1200 })).toEqual([]);
  });
});
