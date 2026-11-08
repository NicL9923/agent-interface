import { expect, it } from "vitest";
import { desktopKeys, type DesktopKey } from "../src/lib/desktop-keys";
import { chunkInput, controlCharacter, inputLimit, keySequence } from "../src/lib/terminal-input";

const bytes = (text: string) => new TextEncoder().encode(text).length;

it("splits input at the server's byte limit without cutting a code point", () => {
  expect(chunkInput("")).toEqual([]);
  expect(chunkInput("a".repeat(inputLimit))).toEqual(["a".repeat(inputLimit)]);
  // One byte past the limit starts a second message.
  expect(chunkInput("a".repeat(inputLimit + 1))).toEqual(["a".repeat(inputLimit), "a"]);
  // A four-byte cactus that would straddle the limit moves whole into the next message.
  const straddling = "a".repeat(inputLimit - 2) + "🌵" + "é";
  const chunks = chunkInput(straddling);
  expect(chunks).toEqual(["a".repeat(inputLimit - 2), "🌵é"]);
  expect(chunks.join("")).toBe(straddling);
  // Two- and three-byte characters count as their UTF-8 size, not as one.
  for (const text of ["é".repeat(inputLimit), "€".repeat(inputLimit)]) {
    const parts = chunkInput(text);
    expect(parts.join("")).toBe(text);
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(inputLimit);
    expect(bytes(parts[0])).toBeGreaterThan(inputLimit - 3);
  }
});

it("sends what xterm sends for each key the iOS keyboard offers, honoring application cursor keys", () => {
  expect(Object.fromEntries((Object.keys(desktopKeys) as DesktopKey[]).map(key => [key, [keySequence(key, false), keySequence(key, true)]]))).toEqual({
    enter: ["\r", "\r"], tab: ["\t", "\t"], backspace: ["\x7f", "\x7f"], escape: ["\x1b", "\x1b"], delete: ["\x1b[3~", "\x1b[3~"],
    left: ["\x1b[D", "\x1bOD"], up: ["\x1b[A", "\x1bOA"], right: ["\x1b[C", "\x1bOC"], down: ["\x1b[B", "\x1bOB"],
    home: ["\x1b[H", "\x1bOH"], end: ["\x1b[F", "\x1bOF"], pageUp: ["\x1b[5~", "\x1b[5~"], pageDown: ["\x1b[6~", "\x1b[6~"],
  });
});

it("turns Control and one letter or symbol into its control character, and refuses anything else", () => {
  expect(["c", "C", "d", "z", "@", " ", "[", "\\", "]", "^", "_"].map(controlCharacter))
    .toEqual(["\x03", "\x03", "\x04", "\x1a", "\0", "\0", "\x1b", "\x1c", "\x1d", "\x1e", "\x1f"]);
  for (const text of ["", "cc", "1", "?", "é", "\n", "`", "{"]) expect(controlCharacter(text)).toBeUndefined();
});
