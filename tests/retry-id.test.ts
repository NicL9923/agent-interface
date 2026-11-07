import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formRequestId, isRetryRequestId, retryRequestId } from "../src/shared/retry-id.js";

// The iOS app derives the same IDs; docs/native-api.md lists these vectors for it.
const vectors: [botId: string, messageId: string, runId: string, id: string][] = [
  ["ranch", "msg-42", "run-7", "97260a13-beba-8fb5-9218-204b5e8a2010"],
  ["ranch", "msg-42", "", "3bba2658-e84c-8ad5-a391-77d34308f4b8"],
  ["café", "👋", "run", "f0431e86-8678-8bc4-92de-7d27336108fb"],
];

describe("retry request IDs", () => {
  it.each(vectors)("derives the fixed ID for %s, %s, %j", async (botId, messageId, runId, id) => {
    expect(await retryRequestId(botId, messageId, runId)).toBe(id);
  });

  it("makes version 8 UUIDs the server accepts, distinct per assistant, message and failed run", async () => {
    const ids = await Promise.all([["ranch", "m", "r"], ["barn", "m", "r"], ["ranch", "n", "r"], ["ranch", "m", "s"], ["ranch", "m", ""]]
      .map(([botId, messageId, runId]) => retryRequestId(botId, messageId, runId)));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(z.string().uuid().safeParse(id).success).toBe(true);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    // Field boundaries count: "ab" + "c" is not "a" + "bc".
    expect(await retryRequestId("ab", "c")).not.toBe(await retryRequestId("a", "bc"));
  });
});

// The iOS app derives the same IDs; docs/native-api.md lists these vectors for it.
const formVectors: [formKey: string, botId: string, messageId: string, cardId: string, attempt: number, id: string][] = [
  ["k3y_A-b", "ranch", "msg-42", "trip", 0, "1ab28536-230d-4777-84cf-8dcda31bb28c"],
  ["k3y_A-b", "ranch", "msg-42", "trip", 3, "76bbd8a5-8259-4c9e-8b2b-3b3fa7bec9d2"],
  ["café", "👋", "m", "c", 1, "f2ec6d4c-7663-410f-88ba-49c4a6921df8"],
];

describe("form request IDs", () => {
  it.each(formVectors)("derives the fixed ID for %s, %s, %s, %s, attempt %i", async (formKey, botId, messageId, cardId, attempt, id) => {
    expect(await formRequestId(formKey, botId, messageId, cardId, attempt)).toBe(id);
  });

  it("makes one version 4 UUID per person, assistant, message, card and attempt, never a retry's", async () => {
    const parts: [string, string, string, string, number][] = [["one", "ranch", "m", "c", 0], ["two", "ranch", "m", "c", 0], ["one", "barn", "m", "c", 0],
      ["one", "ranch", "n", "c", 0], ["one", "ranch", "m", "d", 0], ["one", "ranch", "m", "c", 1]];
    const ids = await Promise.all(parts.map(part => formRequestId(...part)));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(z.string().uuid().safeParse(id).success).toBe(true);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(isRetryRequestId(id)).toBe(false);
    }
    // Every tab and device derives the same ID, so the server admits the answers once.
    expect(await formRequestId("one", "ranch", "m", "c", 0)).toBe(ids[0]);
    // The prefix keeps a form's ID apart from a retry's over the same words.
    expect(ids[0]).not.toBe(await retryRequestId("one", "ranch", "m"));
  });
});
