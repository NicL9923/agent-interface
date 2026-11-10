import { expect, it } from "vitest";
import { shouldStackComposer } from "../src/app/composer-layout";
const width = (value: number) => () => value;
// Text that decides the layout on its own must never pay for a measurement.
const unmeasured = () => { throw new Error("measured text whose layout the text alone decides"); };
it("keeps a short draft inline and expands when its inline slot would wrap", () => {
  expect(shouldStackComposer("Hello", 180, width(42))).toBe(false);
  expect(shouldStackComposer("A longer prompt", 180, width(180))).toBe(true);
  expect(shouldStackComposer("Hello", 180, width(42))).toBe(false);
});
it("expands for explicit lines, long drafts and narrow control layouts without measuring", () => {
  expect(shouldStackComposer("Hello\nthere", 400, unmeasured)).toBe(true);
  expect(shouldStackComposer("a".repeat(201), 2000, unmeasured)).toBe(true);
  expect(shouldStackComposer("", 119, unmeasured)).toBe(true);
});
it("does not size an empty input from its placeholder", () => {
  expect(shouldStackComposer("", 180, unmeasured)).toBe(false);
});
