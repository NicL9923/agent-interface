import { expect, it } from "vitest";
import { shouldStackComposer } from "../src/app/composer-layout";
it("keeps a short draft inline and expands when its inline slot would wrap", () => {
  expect(shouldStackComposer("Hello", 180, 42)).toBe(false);
  expect(shouldStackComposer("A longer prompt", 180, 180)).toBe(true);
  expect(shouldStackComposer("Hello", 180, 42)).toBe(false);
});
it("expands for explicit lines, long drafts and narrow control layouts", () => {
  expect(shouldStackComposer("Hello\nthere", 400, 42)).toBe(true);
  expect(shouldStackComposer("a".repeat(201), 2000, 600)).toBe(true);
  expect(shouldStackComposer("", 119, 0)).toBe(true);
});
it("does not size an empty input from its placeholder", () => {
  expect(shouldStackComposer("", 180, 900)).toBe(false);
});
