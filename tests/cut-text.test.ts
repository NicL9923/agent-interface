import { afterEach, describe, expect, it, vi } from "vitest";
import { cutText, safeCut } from "../src/shared/cut-text";

const emoji = "😀", flag = "🇹🇷", family = "👨‍👩‍👧‍👦", thumbs = "👍🏽", accented = "é", keycap = "1️⃣";
// A lone half of a surrogate pair, which is what a cut inside an emoji leaves.
const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
afterEach(() => { vi.unstubAllGlobals(); });

/** Where the runtime itself says each character ends, from the whole text. */
function boundaries(text: string) {
  const ends = new Set([0]);
  for (const { index, segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) ends.add(index + segment.length);
  return ends;
}

describe("safeCut", () => {
  it.each<[string, string, number, number]>([
    ["an emoji's surrogate pair", `a${emoji}b`, 2, 1],
    ["after a whole emoji", `a${emoji}b`, 3, 3],
    ["a flag, between its two regional indicators", `x${flag}y`, 3, 1],
    ["after a whole flag", `x${flag}y`, 5, 5],
    ["a flag that starts the text", `${flag}y`, 2, 0],
    ["a family emoji, joined by zero-width joiners", `x${family}y`, 8, 1],
    ["after a whole family emoji", `x${family}y`, 12, 12],
    ["an emoji with a skin tone", `x${thumbs}y`, 3, 1],
    ["a letter and its accent", `x${accented}y`, 2, 1],
    ["a keycap", `x${keycap}y`, 3, 1],
    ["Chinese, one unit a character", "今日は晴れです", 4, 4],
  ])("does not cut %s", (_, text, index, expected) => {
    expect(safeCut(text, index)).toBe(expected);
    expect(cutText(text, index)).toBe(text.slice(0, expected));
  });

  it("falls on a character boundary and no earlier than it has to, at every index of every kind of text", () => {
    for (const text of [`a${emoji}b${flag}c${family}d${thumbs}e${accented}f${keycap}g`, emoji.repeat(9), flag.repeat(5), family.repeat(3), "今日は晴れです。", "plain words here"]) {
      const ends = boundaries(text);
      for (let index = 0; index <= text.length + 1; index++) {
        const cut = safeCut(text, index);
        const reached = Math.min(index, text.length);
        expect(ends.has(cut), `${JSON.stringify(text)} at ${index} cut at ${cut}`).toBe(true);
        expect(cut).toBeLessThanOrEqual(reached);
        // The next character does not fit, so nothing shorter than needed was given up.
        expect([...ends].some(end => end > cut && end <= reached), `${JSON.stringify(text)} at ${index} cut at ${cut}`).toBe(false);
      }
    }
  });

  it.each<[string, number, number]>([[ "abc", 0, 0 ], ["abc", -4, 0], ["abc", Number.NaN, 0], ["abc", 99, 3], ["abc", Number.POSITIVE_INFINITY, 3], ["a😀b", 2.9, 1], ["", 5, 0]])(
    "answers %j at %s with %s",
    (text, index, expected) => { expect(safeCut(text, index)).toBe(expected); });

  it("gives up the character it cannot place whole rather than the whole text, when one character is longer than the lookahead", () => {
    const text = `e${"́".repeat(80)}tail`;
    expect(safeCut(text, 40)).toBe(40);
  });

  describe("where the runtime has no grapheme segmenter", () => {
    const without = () => vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
    it("keeps every code point whole, which is all it can tell", () => {
      without();
      expect(safeCut(`a${emoji}b`, 2)).toBe(1);
      expect(safeCut(`a${emoji}b`, 3)).toBe(3);
      expect(safeCut(emoji.repeat(10), 7)).toBe(6);
      for (let index = 0; index <= 40; index++) expect(cutText(`x${family}${flag}${emoji}`, index)).not.toMatch(lone);
    });
    it("goes back to graphemes when the runtime has them again", () => {
      without();
      expect(safeCut(`x${flag}y`, 3)).toBe(3);
      vi.unstubAllGlobals();
      expect(safeCut(`x${flag}y`, 3)).toBe(1);
    });
  });
});

describe("cutText", () => {
  it("is the text itself when it fits", () => {
    expect(cutText("short", 5)).toBe("short");
    expect(cutText("short", 50)).toBe("short");
  });
  it("is never longer than the limit and never ends in half a character", () => {
    const text = `${emoji}${flag}${family}${thumbs}`.repeat(8);
    for (let limit = 0; limit <= text.length; limit++) {
      const cut = cutText(text, limit);
      expect(cut.length).toBeLessThanOrEqual(limit);
      expect(cut).not.toMatch(lone);
      expect(text.startsWith(cut)).toBe(true);
    }
  });
});
