import { beforeAll, describe, expect, it, vi } from "vitest";
import { shouldStackComposer, textWidth, type ComposerSlot } from "../src/app/composer-layout";
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
describe("textWidth", () => {
  const slot: ComposerSlot = { available: 238, font: "400 16px Inter", letterSpacing: "normal" };
  // The real canvas and span widths differ only for these; jsdom lays out nothing, so both are faked.
  const canvasWidth = 186, spanWidth = 247;
  const span = () => {
    const element = { style: {} as CSSStyleDeclaration, textContent: "", getBoundingClientRect: () => ({ width: spanWidth }) };
    return element as unknown as HTMLElement & typeof element;
  };
  beforeAll(() => {
    vi.stubGlobal("OffscreenCanvas", class {
      getContext(kind: string) {
        if (kind !== "2d") throw new Error(`unexpected context ${kind}`);
        return { font: "", letterSpacing: "", measureText: () => ({ width: canvasWidth }) };
      }
    });
  });
  it("measures plain text on the canvas without touching the span", () => {
    const measure = span();
    expect(textWidth("Name Quantity Price Total", slot, measure)).toBe(canvasWidth);
    expect(measure.textContent).toBe("");
  });
  // Chromium, 16px app font: a tabbed row measured 185.85px on canvas and 247.17px in the span and field.
  it.each([["a tab", "Name\tQuantity\tPrice\tTotal"], ["a vertical tab", "Name\vTotal"], ["a form feed", "Name\fTotal"],
    // Chromium: 102.27px on canvas, 118.27px in the span and field.
    ["an object replacement character", "Name\uFFFCQuantity"]])(
    "measures text with %s in the span, as the field draws it", (_, text) => {
      const measure = span();
      expect(textWidth(text, slot, measure)).toBe(spanWidth);
      expect(measure.textContent).toBe(text);
    });
});
