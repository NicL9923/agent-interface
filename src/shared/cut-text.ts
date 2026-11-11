/**
 * Cutting text to a length without cutting a character in two. A limit counts UTF-16 units, as `String.length` does, and
 * `slice` at one can fall inside an emoji's surrogate pair, a flag, a family emoji or a letter with its accent, leaving half
 * of what a person sees as one character. These cut at the nearest whole character at or before the limit instead.
 */

/** Characters of context past the limit, enough for any cluster a person writes; a longer one is cut at a code point. */
const LOOKAHEAD = 64;

let made: { from: unknown; segmenter: Intl.Segmenter } | undefined;
/** Where the runtime has it: Node and every current browser do. Looked up on each call so a missing one is a fallback, not a crash. */
function graphemes(): Intl.Segmenter | undefined {
  const Segmenter = typeof Intl === "object" ? Intl.Segmenter : undefined;
  if (typeof Segmenter !== "function") return undefined;
  if (made?.from !== Segmenter) made = { from: Segmenter, segmenter: new Segmenter(undefined, { granularity: "grapheme" }) };
  return made.segmenter;
}

const high = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const low = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * The largest index at or below `index` that does not fall inside a character: between two graphemes where the runtime
 * can tell them apart, else between two code points. Never negative, never past the text.
 */
export function safeCut(text: string, index: number): number {
  if (!(index > 0)) return 0;
  if (index >= text.length) return text.length;
  const whole = Math.floor(index);
  const segmenter = graphemes();
  if (segmenter) {
    for (const { index: at, segment } of segmenter.segment(text.slice(0, whole + LOOKAHEAD))) {
      // A character that starts the text and is longer than the lookahead may run on past it, so it is not known to end there.
      if (at + segment.length > whole) { if (at > 0 || segment.length < LOOKAHEAD) return at; break; }
    }
  }
  // No grapheme boundary found, or none to look for: do not split a surrogate pair.
  return high(text.charCodeAt(whole - 1)) && low(text.charCodeAt(whole)) ? whole - 1 : whole;
}

/** The first `limit` UTF-16 units of `text`, less any character the limit would cut in two. */
export const cutText = (text: string, limit: number) => text.slice(0, safeCut(text, limit));
