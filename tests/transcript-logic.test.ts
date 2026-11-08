import { describe, expect, it } from "vitest";
import type { Message } from "../src/shared/types";
import type { SearchHit } from "../src/shared/discovery";
import {
  attentionAnchor, foldSummary, formatDuration, joinAnswer, localMatches, mergeFindMatches, nextUnanswered,
  optionForKey, quoteBlock, retryTarget, toggleOption, turnDuration,
} from "../src/app/transcript-logic";
import { afterIntent, endReserve, scrollIntent } from "../src/app/scroll-follow";
import { tableToCsv, tableToMarkdown } from "../src/components/table-export";

const user = (id: string, text = "Check the gates"): Message => ({ id, role: "user", text, sender: { id: "one", name: "One" } });
const assistant = (id: string, text: string): Message => ({ id, role: "assistant", text });
const tool = (id: string, status: "running" | "completed" = "completed"): Message =>
  ({ id, role: "tool", text: "", toolCall: { id: `call-${id}`, name: "terminal", status } });

describe("retry eligibility", () => {
  it("offers the latest human message of a failed turn with no reply text", () => {
    const messages = [user("first"), assistant("a1", "Done."), user("second"), tool("t1"), assistant("thinking", "")];
    expect(retryTarget(messages, "failed")?.id).toBe("second");
  });
  it("refuses when the assistant replied, did not fail, or no person wrote", () => {
    expect(retryTarget([user("q"), assistant("a", "Partial answer")], "failed")).toBeUndefined();
    expect(retryTarget([user("q")], "idle")).toBeUndefined();
    expect(retryTarget([user("q")], "interrupted")).toBeUndefined();
    expect(retryTarget([assistant("a", "I could not reach the service.")], "failed")).toBeUndefined();
  });
  it("skips scheduled prompts and agent envelopes when finding the person's message", () => {
    const cron: Message = { id: "cron", role: "user", text: "Check hay", origin: { kind: "scheduled", visibility: "activity" } };
    const agent: Message = { id: "agent", role: "user", text: "Message from 🤖 Planner (@planner): ok" };
    expect(retryTarget([user("mine"), cron, agent], "failed")?.id).toBe("mine");
    expect(retryTarget([cron], "failed")).toBeUndefined();
  });
  it("counts an activity reply as no reply", () => {
    const diagnostic: Message = { id: "d", role: "assistant", text: "Retrying delivery", origin: { kind: "diagnostic", visibility: "activity" } };
    expect(retryTarget([user("q"), diagnostic], "failed")?.id).toBe("q");
  });
});

describe("fold summary", () => {
  it("formats durations", () => {
    expect(formatDuration(134_000)).toBe("2m 14s");
    expect(formatDuration(45_400)).toBe("45s");
    expect(formatDuration(200)).toBe("1s");
    expect(formatDuration(3_780_000)).toBe("1h 3m");
    expect(formatDuration(65_000)).toBe("1m 05s");
  });
  it("counts each kind of work with its own noun", () => {
    const subagent: Message = { id: "s", role: "user", text: "Subagent Task Completed: x", origin: { kind: "subagent", visibility: "activity" } };
    const processes: Message[] = ["p1", "p2"].map(id => ({ id, role: "user", text: "Done", origin: { kind: "process", visibility: "activity" } }));
    expect(foldSummary([tool("a"), tool("b"), tool("c"), subagent], 134_000)).toBe("Worked for 2m 14s · 3 tool calls, 1 subagent");
    expect(foldSummary([tool("a"), ...processes])).toBe("1 tool call, 2 background processes");
    expect(foldSummary([tool("a")], undefined, true)).toBe("Working · 1 tool call");
    expect(foldSummary([], 5000)).toBe("Worked for 5s");
    expect(foldSummary([])).toBe("Reasoning");
  });
  it("measures from the turn's first timestamp to its final reply, or not at all", () => {
    const prompt = { ...user("q"), createdAt: "2026-10-01T16:00:00Z" };
    const call: Message = { ...tool("t"), toolCall: { id: "c", name: "web", status: "completed", startedAt: "2026-10-01T16:00:05Z" } };
    const reply = { ...assistant("a", "Here it is."), createdAt: "2026-10-01T16:02:14Z" };
    expect(turnDuration({ messages: [prompt, reply], work: [call] })).toBe(134_000);
    expect(turnDuration({ messages: [user("q"), reply], work: [call] })).toBe(129_000);
    expect(turnDuration({ messages: [prompt], work: [call] })).toBeUndefined();
    expect(turnDuration({ messages: [prompt, { ...reply, createdAt: "not a date" }], work: [] })).toBeUndefined();
  });
});

describe("questions", () => {
  const questions = [{ id: "a", prompt: "A" }, { id: "b", prompt: "B" }, { id: "c", prompt: "C" }];
  it("moves to the next unanswered question, wrapping, and stops when all are answered", () => {
    expect(nextUnanswered(questions, { a: "x" }, 0)).toBe(1);
    expect(nextUnanswered(questions, { a: "x", b: " " }, 0)).toBe(1);
    expect(nextUnanswered(questions, { b: "x", c: "y" }, 2)).toBe(0);
    expect(nextUnanswered(questions, { a: "x", b: "y", c: "z" }, 0)).toBeUndefined();
  });
  it("maps number keys to options that exist", () => {
    expect(optionForKey("1", 3)).toBe(0);
    expect(optionForKey("3", 3)).toBe(2);
    expect(optionForKey("4", 3)).toBeUndefined();
    expect(optionForKey("0", 3)).toBeUndefined();
    expect(optionForKey("a", 3)).toBeUndefined();
  });
  it("keeps several choices in the order offered and joins them with the person's words", () => {
    const options = ["Hay", "Water", "Pellets"];
    expect(toggleOption(options, toggleOption(options, [], "Pellets"), "Hay")).toEqual(["Hay", "Pellets"]);
    expect(toggleOption(options, ["Hay", "Pellets"], "Hay")).toEqual(["Pellets"]);
    expect(joinAnswer(["Hay", "Pellets"], "  fresh greens ")).toBe("Hay, Pellets, fresh greens");
    expect(joinAnswer([], " ")).toBe("");
  });
  it("addresses each card by kind and ID for the status dock", () => {
    expect(attentionAnchor("clarify", "ask 1")).toEqual({ id: "attention-clarify-ask-1", "data-attention-id": "ask 1", "data-attention-kind": "clarify" });
  });
});

describe("quotes", () => {
  it("quotes every line, keeping blank lines inside the quote", () => {
    expect(quoteBlock("  First line\r\n\r\nSecond line  \n")).toBe("> First line\n>\n> Second line");
  });
});

describe("find in chat", () => {
  const hit = (messageId: string, extra: Partial<SearchHit> = {}): SearchHit =>
    ({ botId: "ranch", botName: "Ranch", sessionId: "live", title: "", snippet: "", messageId, ...extra });
  it("matches loaded text without regard to case", () => {
    expect(localMatches([{ id: "a", text: "North Gate battery" }, { id: "b", text: "Barn" }, { id: "c", text: "gate check" }], " GATE "))
      .toEqual([{ messageId: "a", loaded: true }, { messageId: "c", loaded: true }]);
    expect(localMatches([{ id: "a", text: "Gate" }], "  ")).toEqual([]);
  });
  it("puts unloaded canonical hits first in history order and drops the rest", () => {
    const local = [{ messageId: "loaded", loaded: true }];
    const merged = mergeFindMatches(local, [
      hit("later", { offset: 40 }), hit("loaded"), hit("other-session", { sessionId: "old" }), hit("earlier", { offset: 3 }),
      hit("other-bot", { botId: "kitchen" }), hit("hidden-activity"), hit("earlier", { offset: 3 }), { ...hit(""), messageId: undefined },
    ], { botId: "ranch", sessionId: "live", loadedIds: new Set(["loaded", "hidden-activity"]) });
    expect(merged).toEqual([{ messageId: "earlier", loaded: false }, { messageId: "later", loaded: false }, ...local]);
  });
  it("uses only loaded matches when the session is unknown", () => {
    expect(mergeFindMatches([], [hit("x")], { botId: "ranch", loadedIds: new Set() })).toEqual([]);
  });
});

describe("table copies", () => {
  const rows = [["Gate", "Battery | level"], ["North", "14%"], ["East"]];
  it("writes Markdown with an escaped pipe and padded short rows", () => {
    expect(tableToMarkdown(rows)).toBe("| Gate | Battery \\| level |\n| --- | --- |\n| North | 14% |\n| East |  |");
    expect(tableToMarkdown([])).toBe("");
  });
  it("writes CSV that quotes only where needed and keeps formulas inert", () => {
    expect(tableToCsv([["Name", "Note"], ["Barn, west", 'Says "hi"'], ["=SUM(A1)", "-71"], ["-cmd", "+1"]]))
      .toBe('Name,Note\r\n"Barn, west","Says ""hi"""\r\n\'=SUM(A1),-71\r\n\'-cmd,\'+1');
  });
});

describe("scroll follow", () => {
  it("hears reading intent from wheel, touch and keys only", () => {
    expect(scrollIntent({ type: "wheel", deltaY: -3 })).toBe("up");
    expect(scrollIntent({ type: "wheel", deltaY: 4 })).toBe("down");
    expect(scrollIntent({ type: "touchmove" })).toBe("drag");
    expect(scrollIntent({ type: "keydown", key: "PageUp" })).toBe("up");
    expect(scrollIntent({ type: "keydown", key: " ", shiftKey: true })).toBe("up");
    expect(scrollIntent({ type: "keydown", key: "End" })).toBe("down");
    expect(scrollIntent({ type: "keydown", key: "ArrowUp", metaKey: true })).toBeUndefined();
    expect(scrollIntent({ type: "keydown", key: "a" })).toBeUndefined();
    expect(scrollIntent({ type: "scroll" })).toBeUndefined();
  });
  it("ends following on any move away from the end, and an anchor on any move", () => {
    expect(afterIntent("follow", "up")).toBe("free");
    expect(afterIntent("follow", "drag")).toBe("free");
    expect(afterIntent("follow", "down")).toBe("follow");
    expect(afterIntent("anchored", "down")).toBe("free");
    expect(afterIntent("free", "down")).toBe("free");
  });
  it("reserves just enough end space to lift a sent message to the top, shrinking as the reply grows", () => {
    // The message sits 1800px down a 2000px transcript in a 600px view: 400px must be added.
    expect(endReserve({ offset: 1800, scrollHeight: 2000, clientHeight: 600, reserve: 0, gap: 24 })).toBe(376);
    // The reply grew by 300px into the reserve; the reserve shrinks by the same amount.
    expect(endReserve({ offset: 1800, scrollHeight: 2676, clientHeight: 600, reserve: 376, gap: 24 })).toBe(76);
    expect(endReserve({ offset: 1800, scrollHeight: 2800, clientHeight: 600, reserve: 76, gap: 24 })).toBe(0);
  });
});
