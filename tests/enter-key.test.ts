// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { enterSends, sendsOnKey } from "../src/app/enter-key";
import { stubMatchMedia } from "./ui-harness";

describe("whether Enter sends", () => {
  it.each([
    ["a phone or tablet with only a finger", ["(any-pointer: coarse)"], false],
    ["a touch-screen laptop", ["(any-pointer: coarse)", "(any-pointer: fine)"], true],
    ["a computer with a mouse", ["(any-pointer: fine)"], true],
    ["a computer driven by its keyboard alone", [], true],
  ])("%s", (_, matching, expected) => {
    stubMatchMedia(query => matching.includes(query));
    expect(enterSends()).toBe(expected);
  });

  it("sends where the browser cannot answer a media query, as on a computer", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(enterSends()).toBe(true);
  });
});

describe("whether a key sends", () => {
  const enter = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 13 };
  // The composers return early for an input method's keys too; this keeps the rule safe for a caller that does not.
  it.each([
    ["Safari's word-confirming Enter", { keyCode: 229 }],
    ["an Enter while composing", { isComposing: true }],
  ])("never sends on %s, not even with Ctrl or Cmd", (_, ime) => {
    expect([sendsOnKey({ ...enter, ...ime }, true), sendsOnKey({ ...enter, ...ime, ctrlKey: true }, false),
      sendsOnKey({ ...enter, ...ime, metaKey: true }, false)]).toEqual([false, false, false]);
  });
});
