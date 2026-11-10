/**
 * Whether the composer stacks its field above the controls. Measure against the inline slot even
 * while stacked, so wrapping cannot toggle the layout back. `measure` returns the text's one-line
 * width and runs only when the text alone cannot decide, because measuring can force a layout.
 */
export function shouldStackComposer(text: string, inlineWidth: number, measure: () => number): boolean {
  if (inlineWidth < 120) return true;
  if (!text) return false;
  return text.includes("\n") || text.length > 200 || measure() > inlineWidth - 8;
}

/** The field's font and the width its inline slot leaves, read once per resize rather than per keystroke. */
export type ComposerSlot = { available: number; font: string; letterSpacing: string };

let canvas: OffscreenCanvasRenderingContext2D | null | undefined;
/**
 * The one-line width of `text` in the field's font. A canvas measures without laying out the page;
 * where there is none, the hidden measuring span does, at the cost of a layout.
 */
export function textWidth(text: string, slot: ComposerSlot, span: HTMLElement | null): number {
  canvas ??= typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1).getContext("2d");
  if (canvas) {
    canvas.font = slot.font;
    canvas.letterSpacing = slot.letterSpacing === "normal" ? "0px" : slot.letterSpacing;
    return canvas.measureText(text).width;
  }
  if (!span) return 0;
  span.style.font = slot.font;
  span.style.letterSpacing = slot.letterSpacing;
  span.textContent = text;
  return span.getBoundingClientRect().width;
}

/** Whether CSS grows the field with its text, so the script need not size it. See styles.css. */
export function cssSizesField() {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");
}
