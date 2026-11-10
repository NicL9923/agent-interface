/**
 * Holds back the unfinished end of a streaming reply's last block, so a half-written marker, link
 * or table header waits until it is whole instead of flashing as raw Markdown. The saved reply
 * never passes through here.
 *
 * Contract:
 * - The result is a prefix of the input. No character is added, removed or reordered, so the live
 *   view only ever shows a state the reply actually passed through.
 * - At most HOLD_LIMIT characters are held, all on the last line: the cut never crosses a line
 *   break. A construct that started further back is shown as typed.
 * - A block longer than BLOCK_LIMIT comes back whole without being read. Otherwise each step is
 *   one pass over at most BLOCK_LIMIT characters, so the cost does not grow with the reply.
 * - Code is never cut. A block with any fence-shaped line, or whose last line is indented as
 *   code, comes back whole.
 * - Only a construct recognized as unfinished is held; anything else comes back whole.
 * - A hold that would hide a whole line is dropped once that line reads as a finished sentence:
 *   `_private is the field.` was never an opener, and a pause would leave the reply blank.
 * - The cut falls on a grapheme boundary, or nothing is held, so no character is shown in part.
 * - It never throws.
 *
 * Held while unfinished, each only when it starts within HOLD_LIMIT of the end:
 * 1. An inline code span with no closing run of the same length.
 * 2. A `**`, `__`, `~~`, `*` or `_` opener with no closer. It must follow a space, the line start
 *    or an opening bracket or quote, and precede a letter, digit or, for `*` and `~~`, a backtick,
 *    bracket or quote, so `*.ts`, `a * b`, `snake_case` and `/_private` show at once.
 * 3. A link or image whose text or destination is still arriving. Its `[` must follow a space,
 *    the line start, `(`, `*` or a quote, so `arr[0` and a URL holding `[` show at once, unless
 *    `](` or `][` already makes it a link.
 * 4. A table header: a last line starting with `|` under a line that does not.
 * 5. A run that cannot be classified yet: a last line of only `-`, `=`, `*`, `_`, `+`, `#`, `|`,
 *    `:`, `~` and `>`, which may become a rule, heading underline, list item, heading or delimiter
 *    row; or a trailing `*`, `_`, `~` or `|` run after a space.
 */
/** The most characters held back: about one short phrase, a bold term or a link to a docs page. */
export const HOLD_LIMIT = 120;
/** The longest block read, so every pass is bounded; a longer block shows as typed. */
export const BLOCK_LIMIT = 4_000;

// Quote and list markers and the indentation around them. Each character has one way to match,
// so a failed match backtracks linearly: nested space quantifiers made "-   ".repeat(20) take a minute.
const container = String.raw`(?:[ \t>]|(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$))*`;
// A fence anywhere in the block, behind any container markers or indentation.
const fenceLine = new RegExp(String.raw`^${container}(?:\`{3,}|~{3,})`, "m");
const containerPrefix = new RegExp(`^${container}`);
const markerLine = /^[ \t]*[-=*_+#|:~>][-=*_+#|:~> \t]*$/;
const spaceOrOpening = /[\s([{"'\u2018\u201c]/;
const letterOrDigit = /[\p{L}\p{N}]/u;
const opensAfter = { "*": /[\p{L}\p{N}`[("'\u2018\u201c]/u, "_": letterOrDigit, "~": /[\p{L}\p{N}`[("'\u2018\u201c]/u };
// A line that ends a sentence, with any closing quote or bracket after its full stop.
const sentenceEnd = /[.!?\u3002\uff01\uff1f]["')\]\u2019\u201d]*[ \t]*$/;
// Without a segmenter a cut cannot be proved to fall between characters, so nothing is held.
const graphemes = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

export function streamingHoldBack(text: string): string {
  try {
    if (text.length > BLOCK_LIMIT || fenceLine.test(text)) return text;
    const lineStart = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1;
    const line = text.slice(lineStart);
    if (/[\t]| {4}/.test(containerPrefix.exec(line)![0])) return text;
    const earliest = text.length - HOLD_LIMIT - lineStart;
    const cut = markerLine.test(line) || /^ {0,3}\|/.test(line) && !/^ {0,3}\|/.test(previousLine(text, lineStart)) ? 0 : inlineCut(line, earliest);
    if (cut === undefined || cut < earliest) return text;
    // Only quote and list markers stay before the cut, so the hold hides everything the line says.
    if (containerPrefix.exec(line)![0].length >= cut && sentenceEnd.test(line)) return text;
    const at = lineStart + cut;
    if (at > 0 && graphemes?.segment(text).containing(at)?.index !== at) return text;
    return text.slice(0, at);
  } catch {
    return text;
  }
}

function previousLine(text: string, lineStart: number): string {
  if (lineStart === 0) return "";
  let end = lineStart - 1;
  if (text[end] === "\n" && text[end - 1] === "\r") end--;
  return text.slice(Math.max(text.lastIndexOf("\n", end - 1), text.lastIndexOf("\r", end - 1)) + 1, end);
}

/** Where an unfinished inline construct on the line starts, if one does. One pass over the line. */
function inlineCut(line: string, earliest: number): number | undefined {
  const length = line.length;
  // Backtick runs by size, so a code span's closer is found without rescanning the line.
  const runs = new Map<number, number[]>(), seen = new Map<number, number>();
  for (let at = 0; at < length;) {
    if (line[at] !== "`") { at++; continue; }
    let end = at;
    while (line[end] === "`") end++;
    const starts = runs.get(end - at);
    if (starts) starts.push(at); else runs.set(end - at, [at]);
    at = end;
  }
  const closerAfter = (from: number, size: number) => {
    const starts = runs.get(size) ?? [];
    let index = seen.get(size) ?? 0;
    while (index < starts.length && starts[index] < from) index++;
    seen.set(size, index);
    return starts[index];
  };

  const open = { "*": [] as Array<{ at: number; size: number }>, "_": [] as Array<{ at: number; size: number }>, "~": [] as Array<{ at: number; size: number }> };
  const brackets: Array<{ at: number; link: boolean }> = [];
  // Where a construct that runs to the end of the line starts: everything after it is its content.
  let rest: number | undefined;
  for (let at = 0; at < length && rest === undefined;) {
    const char = line[at];
    if (char === "\\") { at += 2; continue; }
    if (char === "`") {
      let end = at;
      while (line[end] === "`") end++;
      const closer = closerAfter(end, end - at);
      if (closer === undefined) rest = at;
      else at = closer + end - at;
      continue;
    }
    if (char === "*" || char === "_" || char === "~") {
      let end = at;
      while (line[end] === char) end++;
      const size = end - at, after = line[end] ?? "", spaced = at === 0 || spaceOrOpening.test(line[at - 1]);
      const stack = open[char], top = stack.at(-1);
      if (char === "~" && size !== 2) {
        // A single tilde at the end may still become `~~`.
        if (size === 1 && spaced && !after) rest = at;
      } else if (!spaced && top && (char !== "_" || !letterOrDigit.test(after))) {
        // A shorter run is a closer still being typed, so its opener stays open.
        if (size >= top.size) {
          stack.pop();
          for (const other of Object.values(open)) while (other.length && other.at(-1)!.at > top.at) other.pop();
        }
      } else if (spaced && !after) rest = at;
      else if (spaced && opensAfter[char].test(after)) stack.push({ at, size });
      at = end;
      continue;
    }
    if (char === "|" && at === length - 1 && (at === 0 || /\s/.test(line[at - 1]))) { rest = at; break; }
    if (char === "[") {
      const start = line[at - 1] === "!" ? at - 1 : at;
      brackets.push({ at: start, link: start === 0 || /[\s(*"'\u2018\u201c]/.test(line[start - 1]) });
      at++;
      continue;
    }
    if (char !== "]") { at++; continue; }
    const bracket = brackets.pop();
    at++;
    if (!bracket) continue;
    if (at === length) { if (bracket.link) rest = bracket.at; break; }
    if (line[at] === "(") {
      // A destination, read to its closing parenthesis.
      let depth = 1, end = at + 1;
      for (; end < length && depth; end++) if (line[end] === "\\") end++; else if (line[end] === "(") depth++; else if (line[end] === ")") depth--;
      if (depth) rest = bracket.at;
      at = end;
    } else if (line[at] === "[") {
      const label = line.indexOf("]", at + 1);
      if (label < 0) rest = bracket.at;
      else at = label + 1;
    }
  }
  // A construct running to the end that started before the window holds everything after it, so
  // the caller shows the line as typed.
  let cut = rest ?? Infinity;
  for (const stack of Object.values(open)) for (const opener of stack) if (opener.at >= earliest) cut = Math.min(cut, opener.at);
  for (const bracket of brackets) if (bracket.link && bracket.at >= earliest) cut = Math.min(cut, bracket.at);
  return cut === Infinity ? undefined : cut;
}
