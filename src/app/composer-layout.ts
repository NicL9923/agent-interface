/** Measure against the inline slot even while stacked, so wrapping cannot toggle the layout back. */
export function shouldStackComposer(text: string, inlineWidth: number, measuredWidth: number): boolean {
  if (inlineWidth < 120) return true;
  if (!text) return false;
  return text.includes("\n") || text.length > 200 || measuredWidth > inlineWidth - 8;
}
