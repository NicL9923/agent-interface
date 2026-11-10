import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { continueChips, continueTurns, settleChips, settleRevisions, settleTurns } from "../src/app/transcript-window";
import { conversationArtifacts, replyArtifacts } from "../src/shared/artifacts";
import { continueDraftRevisions, draftRevisions } from "../src/shared/draft-diff";
import type { EarlierFiles } from "../src/shared/history";
import type { FileRef, Message, ToolCall } from "../src/shared/types";

// The transcript reads the settled messages once and continues that reading over the live rows on
// each change. Wherever the live rows start, the continuation must give what one reading of the whole
// window gives; these hold every continuation to that at every split.
const splits = <T,>(items: T[]) => Array.from({ length: items.length + 1 }, (_, at) => [items.slice(0, at), items.slice(at)] as const);
const vectors = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../ios/AgentInterfaceTests/Vectors/${name}`, import.meta.url)), "utf8"));

const call = (id: string, status: ToolCall["status"]): ToolCall => ({ id, name: "terminal", status, startedAt: "2026-11-10T15:00:00Z" });
const window: Message[] = [
  { id: "u1", role: "user", text: "Check the gate", sender: { id: "one", name: "One" } },
  { id: "p1", role: "assistant", interim: true, text: "Reading the log." },
  { id: "t1", role: "tool", text: "", toolCall: call("c1", "running") },
  { id: "a1", role: "assistant", text: "The gate is latched.", reasoning: "Gates first." },
  // A scheduled delivery starts a turn, and its reply inherits the scheduled origin.
  { id: "s1", role: "user", text: "[Cron delivery: Morning report]" },
  { id: "a3", role: "assistant", text: "All quiet this morning." },
  { id: "u2", role: "user", text: "And the barn?", sender: { id: "one", name: "One" } },
  // Another assistant's message is activity, and the reply to it inherits that.
  { id: "f1", role: "user", text: "Message from Fox (@fox): the east gate is open" },
  { id: "a2", role: "assistant", text: "Thanks, Fox." },
  { id: "t2", role: "tool", text: "", toolCall: call("c2", "completed") },
  { id: "t3", role: "tool", text: "", toolCall: call("c2", "completed") },
  { id: "a4", role: "assistant", text: "", reasoning: "Only thinking here." },
  { id: "a5", role: "assistant", text: "The barn is shut." },
  { id: "x-inflight", role: "assistant", text: "Still checking the loft", reasoning: "Loft next." },
];
// A unique match updates its row, a reused ID cannot be placed, and a new call joins the last turn.
const calls = [call("c1", "completed"), call("c2", "running"), call("c9", "running")];

describe("turns continued past the live rows", () => {
  it("are the whole window's turns at every split, with and without the running turn's calls", () => {
    for (const advanced of [false, true]) for (const running of [[], calls]) {
      const whole = continueTurns(settleTurns(window, advanced), [], running);
      for (const [settled, live] of splits(window)) expect(continueTurns(settleTurns(settled, advanced), live, running)).toEqual(whole);
    }
  });

  it("keep the object of each turn neither the live rows nor the calls change", () => {
    const settled = settleTurns(window.slice(0, -1), true);
    const turns = continueTurns(settled, window.slice(-1), calls);
    // The scheduled turn is untouched; the first turn has a call, and the last the live row.
    expect(turns[1]).toBe(settled.shown[1]);
    expect(turns[0]).not.toBe(settled.shown[0]);
    expect(turns[2]).not.toBe(settled.shown[2]);
    // A running saved call keeps the reply unfolded, and a live update that finishes it folds the work again.
    expect(settled.shown[0].replyAt).toBeUndefined();
    expect(turns[0].replyAt).toBe("a1");
    expect(continueTurns(settled, [], [])).toBe(settled.shown);
  });
});

describe("reply file chips continued past the live rows", () => {
  const { cases } = vectors("reply-artifacts.json") as { cases: { name: string; messages: Message[]; files?: FileRef[]; earlier?: EarlierFiles["messages"] }[] };
  it("are the whole window's chips at every split of every shared vector, live rows with files included", () => {
    for (const { messages, files, earlier = [] } of cases) {
      const whole = replyArtifacts(messages, conversationArtifacts(messages, earlier, files), earlier);
      for (const [settled, live] of splits(messages)) expect(continueChips(settleChips(settled, files, earlier), settled, live, files, earlier)).toEqual(whole);
    }
  });
});

describe("draft revisions continued past the live rows", () => {
  const { lineage } = vectors("draft-diff.json") as { lineage: { messages: { id: string; role: string; text: string }[] }[] };
  it("are the whole window's revisions at every split of every shared vector", () => {
    for (const { messages } of lineage) {
      const whole = draftRevisions(messages);
      for (const [settled, live] of splits(messages)) expect(continueDraftRevisions(settleRevisions(settled), live).revisions).toEqual(whole);
    }
  });

  it("keep their map while a live reply holds no draft, and copy it when one does, leaving the settled map as it was", () => {
    const card = (id: string, body: string) => `\`\`\`agent-ui\n${JSON.stringify({ version: 1, cards: [{ id, type: "email", title: "Gate", body }] })}\n\`\`\``;
    const settled = settleRevisions([{ id: "m1", role: "assistant", text: card("gate", "Noon.") }]);
    // The email cards read this map, so the same map means they do not render again.
    expect(continueDraftRevisions(settled, [{ id: "x-inflight", role: "assistant", text: "Still writing" }])).toBe(settled);
    const revised = continueDraftRevisions(settled, [{ id: "x-inflight", role: "assistant", text: card("gate2__revises__gate", "One.") }]);
    expect([...revised.revisions].map(([key, previous]) => [key, previous.body])).toEqual([["x-inflight\ngate2__revises__gate", "Noon."]]);
    expect(settled.revisions.size).toBe(0);
    expect([...settled.drafts.keys()]).toEqual(["gate"]);
  });
});
