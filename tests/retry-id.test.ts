import { describe, expect, it } from "vitest";
import { z } from "zod";
import { retryRequestId } from "../src/shared/retry-id.js";

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
