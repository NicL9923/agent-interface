import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyInflightDelta } from "../src/shared/inflight";
import type { Inflight, InflightDelta } from "../src/shared/types";

// The same vectors drive the iOS mirror, so both clients grow a live reply identically.
const file = fileURLToPath(new URL("../ios/AgentInterfaceTests/Vectors/inflight-delta.json", import.meta.url));
const vectors = JSON.parse(readFileSync(file, "utf8")) as {
  cases: { name: string; held: Inflight | null; delta: InflightDelta; result: Inflight | null }[];
};

describe("applyInflightDelta", () => {
  it.each(vectors.cases)("$name", ({ held, delta, result }) => {
    const next = applyInflightDelta(held ?? undefined, delta);
    if (!result) return expect(next).toBeUndefined();
    expect(next).toEqual(result);
    // A key left out must stay out, as a reply without reasoning must not gain an empty one.
    expect(Object.keys(next!.message).sort()).toEqual(Object.keys(result.message).sort());
  });
});
