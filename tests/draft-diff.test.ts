import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DIFF_CELL_LIMIT, draftChanges, draftKey, draftRevisions, wordDiff, type DiffPart } from "../src/shared/draft-diff";
import { replyCardsFromText, type EmailCard } from "../src/shared/reply-cards";

// The same vectors drive the iOS mirror, so both clients highlight a revision identically.
const file = fileURLToPath(new URL("../ios/AgentInterfaceTests/Vectors/draft-diff.json", import.meta.url));
const vectors = JSON.parse(readFileSync(file, "utf8")) as {
  diff: { name: string; before: string; after: string; limit?: number; parts: DiffPart[] }[];
  lineage: { name: string; messages: { id: string; role: string; text: string }[]; revises: Record<string, string> }[];
};

describe("word diff vectors", () => {
  it.each(vectors.diff)("$name", ({ before, after, limit, parts }) => {
    const result = wordDiff(before, after, limit);
    expect(result).toEqual(parts);
    // Every diff rebuilds both drafts exactly.
    expect(result.filter(part => part.kind !== "added").map(part => part.text).join("")).toBe(before);
    expect(result.filter(part => part.kind !== "removed").map(part => part.text).join("")).toBe(after);
  });
});
describe("revision lineage vectors", () => {
  it.each(vectors.lineage)("$name", ({ messages, revises }) => {
    expect(Object.fromEntries([...draftRevisions(messages)].map(([key, card]) => [key.replace("\n", "/"), card.id]))).toEqual(revises);
  });
});

const fence = (card: object) => "```agent-ui\n" + JSON.stringify({ version: 1, cards: [card] }) + "\n```";
const email = { id: "reply", type: "email", title: "Reply", body: "Hi" };
it("keeps a draft whose lineage is malformed, without the lineage, and still refuses unknown fields", () => {
  for (const lineage of [{ draftId: "bad id!" }, { draftId: 7 }, { revises: "x".repeat(81) }, { revises: null }, { draftId: "" }])
    expect(replyCardsFromText(fence({ ...email, ...lineage })), JSON.stringify(lineage)).toEqual([email]);
  expect(replyCardsFromText(fence({ ...email, draftId: "d1", revises: "d0" }))).toEqual([{ ...email, draftId: "d1", revises: "d0" }]);
  expect(replyCardsFromText(fence({ ...email, draftId: "d1", revises: "d1" }))).toEqual([{ ...email, draftId: "d1" }]);
  expect(replyCardsFromText(fence({ ...email, revision: 2 }))).toEqual([]);
});

it("replaces the middle whole at the size limit and compares token pairs below it", () => {
  // 1001 changed words each side is just over a million pairs.
  const words = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");
  const over = wordDiff(words("a", 1001), words("b", 1001));
  expect(over.map(part => part.kind)).toEqual(["removed", "added"]);
  expect(2001 * 2001).toBeGreaterThan(DIFF_CELL_LIMIT);
  // At the limit the common words between changes are still found.
  const under = wordDiff("x a y", "x b y", 1);
  expect(under).toEqual([{ kind: "same", text: "x " }, { kind: "removed", text: "a" }, { kind: "added", text: "b" }, { kind: "same", text: " y" }]);
  // Five tokens a side with nothing shared at either end: 25 pairs is the boundary.
  const shared = (limit: number) => wordDiff("a q b", "c q d", limit).some(part => part.kind === "same" && part.text === " q ");
  expect([shared(25), shared(24)]).toEqual([true, false]);
});

it("reports each field's changes and whether anything changed", () => {
  const before: EmailCard = { id: "a", type: "email", title: "Reply", to: ["sam@example.com"], subject: "Saturday", body: "See you Saturday." };
  const same = draftChanges(before, { ...before, id: "b" });
  expect(same.changed).toBe(false);
  const after = draftChanges(before, { ...before, to: ["sam@example.com", "kim@example.com"], cc: ["pat@example.com"], subject: undefined });
  expect(after.changed).toBe(true);
  expect(after.to).toEqual([{ kind: "same", address: "sam@example.com" }, { kind: "added", address: "kim@example.com" }]);
  expect(after.cc).toEqual([{ kind: "added", address: "pat@example.com" }]);
  expect(draftChanges({ ...before, to: ["a@x.io", "b@x.io"] }, { ...before, to: ["c@x.io", "b@x.io"] }).to)
    .toEqual([{ kind: "removed", address: "a@x.io" }, { kind: "added", address: "c@x.io" }, { kind: "same", address: "b@x.io" }]);
  expect(after.subject).toEqual([{ kind: "removed", text: "Saturday" }]);
  expect(draftChanges(before, { ...before, body: "See you Sunday." }).changed).toBe(true);
  expect(draftKey("m", "c")).not.toBe(draftKey("m\nc", ""));
});
