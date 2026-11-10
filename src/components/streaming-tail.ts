/**
 * Completes the growing end of a streaming reply for display, so half-written Markdown does not
 * flash as raw syntax: it closes an unbalanced strong, emphasis, strikethrough or inline-code
 * marker, shows a partial link as its text and drops a partial image, and holds back a table's
 * header line until its delimiter row arrives. It follows the approach of Streamdown's `remend`
 * (flanking rules, skipping code and escapes, only closing an opener with content after it) and
 * of Streak's "Flash of Incomplete Markdown" write-up (hold a link's URL back until it closes).
 *
 * Only the last paragraph, list item, heading or table cell is judged, because inline markers
 * never cross those. Code fences, code spans and escaped characters are left alone, and text with
 * no unfinished construct comes back unchanged. The saved reply never passes through here.
 */
export function completeStreamingTail(text: string): string {
  const lines = text.split("\n");
  const offsets: number[] = [];
  for (let index = 0, offset = 0; index < lines.length; offset += lines[index].length + 1, index++) offsets.push(offset);

  // Lines that form the final inline context, as [start, end) offsets into text.
  let segments: Array<[number, number]> = [];
  let open: string | undefined, depth = 0, standalone = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], start = offsets[index];
    const marker = fenceLine.exec(line)?.[1];
    if (open || marker) {
      if (!open) open = marker;
      else if (marker && marker[0] === open[0] && marker.length >= open.length && !line.trim().slice(marker.length).trim()) open = undefined;
      segments = [];
      continue;
    }
    const quote = /^(?: {0,3}>[ \t]?)*/.exec(line)![0];
    const quoteDepth = quote.split(">").length - 1;
    const rest = line.slice(quote.length);
    // A blank line ends a paragraph once something follows it; the line being typed may be empty.
    if (!rest.trim()) { if (index < lines.length - 1) segments = []; continue; }
    // A deeper quote starts a block; a shallower line is a lazy continuation of the quoted paragraph.
    if (quoteDepth > depth || standalone) { segments = []; standalone = false; }
    depth = quoteDepth;
    if (!segments.length && /^(?: {4}|\t)/.test(rest)) { standalone = true; continue; } // Indented code.
    if (thematicBreak.test(rest)) { segments = []; continue; }
    const contentStart = start + quote.length;
    const heading = /^ {0,3}#{1,6}(?:[ \t]+|$)/.exec(rest);
    if (heading) { segments = [[contentStart + heading[0].length, start + line.length]]; standalone = true; continue; }
    if (tableRow.test(rest)) {
      // Each cell is its own inline context; only the last one can still be growing.
      let cell = 0;
      for (let at = 0; at < rest.length; at++) if (rest[at] === "\\") at++; else if (rest[at] === "|") cell = at + 1;
      segments = [[contentStart + cell, start + line.length]];
      standalone = true;
      continue;
    }
    const item = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(rest);
    if (item) segments = [[contentStart + item[0].length, start + line.length]];
    else segments.push([contentStart, start + line.length]);
  }
  if (open) return text;

  // A table's header shows as a paragraph until its delimiter row makes it a table.
  let last = lines.length - 1;
  if (!lines[last] && last > 0) last--;
  const pipe = (index: number) => index >= 0 && tableRow.test(lines[index]);
  if (pipe(last) && !pipe(last - 1)) return text.slice(0, offsets[last]);
  if (delimiterRow.test(lines[last]) && pipe(last - 1) && !pipe(last - 2) && !completesHeader(lines[last - 1], lines[last])) {
    return text.slice(0, offsets[last - 1]);
  }

  if (!segments.length) return text;
  const map: number[] = [];
  let inline = "";
  for (const [index, [from, to]] of segments.entries()) {
    if (index) { map.push(from - 1); inline += "\n"; }
    for (let at = from; at < to; at++) map.push(at);
    inline += text.slice(from, to);
  }
  map.push(segments.at(-1)![1]);

  const scan = scanInline(inline);
  if (scan.link) {
    const { start, textEnd, image } = scan.link;
    const raw = map[start];
    // Everything from the closing bracket on is the URL still arriving.
    return completeStreamingTail(image ? text.slice(0, raw) : text.slice(0, raw) + text.slice(raw + 1, textEnd < inline.length ? map[textEnd] : text.length));
  }

  let closers = "";
  if (scan.code) {
    const body = inline.slice(scan.code.start + scan.code.length).trimEnd();
    const typed = /`*$/.exec(body)![0].length;
    // An opener with nothing after it yet is left as typed.
    if (!body.slice(0, body.length - typed).trim() || typed >= scan.code.length) return text;
    closers += "`".repeat(scan.code.length - typed);
  }
  for (const opener of [...scan.openers].reverse()) {
    if (opener.intraword || opener.original === 1 && opener.char === "~" || !/[^\s*_~`]/.test(inline.slice(opener.start + opener.length))) continue;
    closers += opener.char.repeat(opener.length);
  }
  if (!closers) return text;

  const end = text.trimEnd().length;
  const head = text.slice(0, end);
  if (!scan.code) {
    if (/(?:^|[^\\])(?:\\\\)*\\$/.test(head)) return text; // A trailing backslash would escape the closer.
    // An emphasis closer must touch text to close, and must not merge into a longer tilde run.
    let run = end;
    while (run > 0 && head[run - 1] === closers[0]) run--;
    if (!head[run - 1] || /\s/.test(head[run - 1])) return text;
    if (closers[0] === "~") {
      // A half-typed `~~` closer needs one more tilde; any other tilde run beside it would not close.
      if (end - run === 1) closers = closers.slice(1);
      else if (end - run) return text;
    }
  }
  return head + closers + text.slice(end);
}

const fenceLine = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const thematicBreak = /^ {0,3}(?:([-*_])(?:[ \t]*\1){2,}|=+)[ \t]*$/;
const tableRow = /^[ \t]*\|/;
const delimiterRow = /^[ \t]*\|?[ \t]*[:-][ \t:|-]*$/;

function cells(row: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let at = 0; at < row.length; at++) {
    if (row[at] === "\\") { current += row.slice(at, at + 2); at++; } else if (row[at] === "|") { parts.push(current); current = ""; } else current += row[at];
  }
  parts.push(current);
  if (!parts[0].trim()) parts.shift();
  if (parts.length && !parts.at(-1)!.trim()) parts.pop();
  return parts;
}

/** Whether a delimiter row already turns the header above it into a table. */
function completesHeader(header: string, delimiter: string): boolean {
  const columns = cells(delimiter);
  return columns.length === cells(header).length && columns.every(cell => /^\s*:?-+:?\s*$/.test(cell));
}

interface Opener { char: string; start: number; length: number; original: number; both: boolean; intraword: boolean }
interface InlineScan { openers: Opener[]; code?: { start: number; length: number }; link?: { start: number; textEnd: number; image: boolean } }

const whitespace = (char: string) => /\s/.test(char);
const punctuation = (char: string) => /[\p{P}\p{S}]/u.test(char);
const word = (char: string) => /[\p{L}\p{N}]/u.test(char);

/**
 * Walks one inline context the way CommonMark matches delimiters, closely enough to tell which
 * openers are still waiting at the end: a simplified delimiter stack with the flanking rules and
 * the rule of three, code spans that pair runs of equal length, and links that close on `)`.
 */
function scanInline(text: string): InlineScan {
  const openers: Opener[] = [];
  const brackets: Array<{ start: number; image: boolean }> = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === "\\" && /[!-/:-@[-`{-~]/.test(text[at + 1] ?? "")) { at += 2; continue; }
    if (char === "`") {
      const length = /^`+/.exec(text.slice(at))![0].length;
      const close = new RegExp(`(?<!\`)\`{${length}}(?!\`)`, "g");
      close.lastIndex = at + length;
      const match = close.exec(text);
      if (!match) return { openers, code: { start: at, length } };
      at = match.index + length;
      continue;
    }
    if (char === "<") {
      const tag = /^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|\/?[A-Za-z][^<>]*)>/.exec(text.slice(at));
      if (tag) { at += tag[0].length; continue; }
    }
    if (char === "[" || (char === "!" && text[at + 1] === "[")) {
      const image = char === "!";
      // A footnote call, or a bracket glued to a word such as items[0], is not a link.
      if (text[at + (image ? 2 : 1)] !== "^" && (image || !word(text[at - 1] ?? ""))) brackets.push({ start: at, image });
      at += image ? 2 : 1;
      continue;
    }
    if (char === "]") {
      const bracket = brackets.pop();
      if (bracket && text[at + 1] === "(") {
        let depth = 1, end = at + 2;
        for (; end < text.length && depth; end++) {
          if (text[end] === "\\") end++;
          else if (text[end] === "(") depth++;
          else if (text[end] === ")") depth--;
        }
        if (depth) return { openers, link: { start: bracket.start, textEnd: at, image: bracket.image } };
        // Delimiters inside a finished link's text only pair with each other.
        while (openers.length && openers.at(-1)!.start > bracket.start) openers.pop();
        at = end;
        continue;
      }
      at++;
      continue;
    }
    if (char === "*" || char === "_" || char === "~") {
      const length = new RegExp(`^\\${char}+`).exec(text.slice(at))![0].length;
      const before = text[at - 1] ?? "\n", after = text[at + length] ?? "\n";
      at += length;
      // GFM strikes with one or two tildes. One may be plain text, as in ~5 minutes, so only two are closed.
      if (char === "~" && length > 2) continue;
      // micromark's flanking: beside `*` or `_`, a strikethrough tilde counts as an ordinary character.
      const kind = (neighbor: string) => char !== "~" && neighbor === "~" ? 0 : whitespace(neighbor) ? 1 : punctuation(neighbor) ? 2 : 0;
      const previous = kind(before), next = kind(after);
      const left = !next || (next === 2 && previous > 0);
      const right = !previous || (previous === 2 && next > 0);
      const canOpen = char === "_" ? left && (previous > 0 || !right) : left;
      const canClose = char === "_" ? right && (next > 0 || !left) : right;
      let remaining = length;
      if (canClose) {
        for (let index = openers.length - 1; index >= 0 && remaining; index--) {
          const opener = openers[index];
          if (opener.char !== char || (char === "~" && opener.length !== length)) continue;
          if (char !== "~" && (opener.both || (canOpen && canClose)) && (opener.original + length) % 3 === 0 && (opener.original % 3 || length % 3)) continue;
          openers.length = index + 1;
          const used = char === "~" ? length : Math.min(opener.length, remaining) >= 2 ? 2 : 1;
          opener.length -= used;
          remaining -= used;
          if (!opener.length) openers.pop();
          index = openers.length;
        }
      }
      if (remaining && canOpen) {
        openers.push({ char, start: at - remaining, length: remaining, original: length, both: canOpen && canClose, intraword: word(before) && word(after) });
      }
      continue;
    }
    at++;
  }
  const bracket = brackets[0];
  if (bracket) return { openers, link: { start: bracket.start, textEnd: text.length, image: bracket.image } };
  return { openers };
}
