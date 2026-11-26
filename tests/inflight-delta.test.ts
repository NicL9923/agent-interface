import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyInflightDelta,
  compareVersions,
  placeTurn,
  versionBoot,
  withTurn,
} from "../src/shared/inflight";
import type {
  Conversation,
  Inflight,
  InflightDelta,
  Message,
  TurnEvent,
  TurnRows,
} from "../src/shared/types";

// The same vectors drive the iOS mirror, so both clients grow a live reply and place turns identically.
const file = fileURLToPath(
  new URL("../ios/AgentInterfaceTests/Vectors/inflight-delta.json", import.meta.url),
);
const vectors = JSON.parse(readFileSync(file, "utf8")) as {
  cases: { name: string; held: Inflight | null; delta: InflightDelta; result: Inflight | null }[];
};

const turnFile = fileURLToPath(
  new URL("../ios/AgentInterfaceTests/Vectors/turn-events.json", import.meta.url),
);
const turnVectors = JSON.parse(readFileSync(turnFile, "utf8")) as {
  compareVersions: { name: string; a: string | null; b: string | null; sign: -1 | 0 | 1 | null }[];
  versionBoot: { name: string; version: string | null; boot: string | null }[];
  placeTurn: { name: string; messages: Message[]; turn: TurnRows; result: Message[] | null }[];
  withTurn: {
    name: string;
    conversation: Conversation;
    turn: TurnEvent;
    result: Conversation | null;
  }[];
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

describe("turn-events shared vectors", () => {
  it.each(turnVectors.compareVersions)("compareVersions: $name", ({ a, b, sign }) => {
    const result = compareVersions(a ?? undefined, b ?? undefined);
    if (sign === null) return expect(result).toBeUndefined();
    expect(Math.sign(result!)).toBe(sign);
  });

  it.each(turnVectors.versionBoot)("versionBoot: $name", ({ version, boot }) => {
    expect(versionBoot(version ?? undefined)).toBe(boot ?? undefined);
  });

  it.each(turnVectors.placeTurn)("placeTurn: $name", ({ messages, turn, result }) => {
    const placed = placeTurn(messages, turn);
    if (result === null) return expect(placed).toBeUndefined();
    expect(placed).toEqual(result);
  });

  it.each(turnVectors.withTurn)("withTurn: $name", ({ conversation, turn, result }) => {
    const applied = withTurn(conversation, turn);
    if (result === null) return expect(applied).toBeUndefined();
    expect(applied).toEqual(result);
  });
});
