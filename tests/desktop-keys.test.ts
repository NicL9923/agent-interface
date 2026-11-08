import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { desktopKeys, keysymsFor } from "../src/lib/desktop-keys";

it("maps typed text to one keysym per character", () => {
  // A pasted Windows line break presses Enter once, not twice.
  expect(keysymsFor("a\r\nb\rc\td")).toEqual([0x61, 0xff0d, 0x62, 0xff0d, 0x63, 0xff09, 0x64]);
  expect(keysymsFor("é€🤠")).toEqual([0xe9, 0x01000000 | 0x20ac, 0x01000000 | 0x1f920]);
});

it("names the same keys as the iOS keyboard", () => {
  // The app sends keys by name; one the page does not know would be dropped without a word.
  const swift = readFileSync("ios/AgentInterface/DesktopKeyboard.swift", "utf8");
  const cases = /enum Key: String, CaseIterable \{ case ([^}]+) \}/.exec(swift)?.[1].split(",").map(name => name.trim());
  expect(cases).toEqual(Object.keys(desktopKeys));
});

it("cuts a long paste at a whole character", async () => {
  const { limitPaste, pasteLimit } = await import("../src/lib/desktop-keys");
  expect(limitPaste("hi")).toEqual({ text: "hi", cut: false });
  const long = limitPaste("a".repeat(pasteLimit - 1) + "🌵🌵");
  expect(long.cut).toBe(true);
  expect(Array.from(long.text)).toHaveLength(pasteLimit);
  expect(long.text.endsWith("🌵")).toBe(true);
});
