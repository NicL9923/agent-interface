// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { enterSends, hardwareKey } from "../src/app/enter-key";
import { stubMatchMedia } from "./ui-harness";

const key = (key: string, chord: Partial<Pick<KeyboardEvent, "ctrlKey" | "metaKey">> = {}) => ({ ctrlKey: false, metaKey: false, key, ...chord });

describe("a key only a hardware keyboard sends", () => {
  it.each([
    ["a lone Shift", key("Shift"), true],
    ["a function key", key("F5"), true],
    ["a Cmd chord", key("k", { metaKey: true }), true],
    ["a Ctrl chord", key("Enter", { ctrlKey: true }), true],
    // On-screen keyboards send these too.
    ["Enter", key("Enter"), false],
    // A letter F, not a function key.
    ["a letter", key("F"), false],
    ["an Android keyboard's unnamed key", key("Unidentified"), false],
  ])("%s", (_, event, expected) => {
    expect(hardwareKey(event)).toBe(expected);
  });
});

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

  it("stays a new line on a touch screen when storage is refused, and never throws", () => {
    stubMatchMedia(query => query === "(any-pointer: coarse)");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    expect(enterSends()).toBe(false);
  });
});
