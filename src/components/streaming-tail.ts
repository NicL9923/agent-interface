/**
 * Completes the growing end of a streaming reply for display, so half-written Markdown does not
 * flash as raw syntax. The saved reply never passes through here.
 *
 * Every repair is opt-in for a context this file has positively identified; anything else comes
 * back unchanged, because a marker shown literally for a moment is a far smaller fault than a
 * character hidden, a destination changed or content the saved reply will not show.
 *
 * 1. Block. The last block must be a paragraph, ATX heading or list item outside any fence, at
 *    one quote depth with no lazy lines, or the last cell of a table body row at the margin.
 *    A fence behind a quote or list marker, a list item's fence whose lines leave its indent, an
 *    HTML block, indented code, a definition, a table inside a container, or a line that may start
 *    another block means no repair.
 * 2. Table header. A header row is held back only while the delimiter row under it has begun and
 *    is not yet complete; a lone line that starts with a pipe shows as typed.
 * 3. Inline. One pass applies micromark's flanking rules, pairs code spans and matches `*` and `_`
 *    with a delimiter stack bounded per kind, so work stays linear, under a step budget. Any `<`,
 *    bare autolink (`://`, `www.`, `@`), marker inside brackets that are not an inline link, link
 *    destination with spaces, two tilde runs that could strike, or running out of budget means
 *    no repair.
 * 4. Repairs. Close the first unclosed code span; close a `**` or `***` that follows a space or an
 *    opening bracket or quote and precedes a letter, digit, backtick or opening bracket; close a
 *    lone `~~` the same way; show a link's text while its destination arrives and drop an image in
 *    progress. A single `*`, any `_` and a single `~` are never closed: they are as often globs,
 *    `*args`, `_private`, `~user` or footnote marks as emphasis.
 * 5. Verify. The repaired text is scanned again; unless every added closer pairs with the opener
 *    it was added for, none is left over, and no other delimiter changes, the text comes back
 *    unchanged.
 */
export function completeStreamingTail(text: string): string {
  const tail = findTail(text);
  if (tail === undefined) return text;
  if (typeof tail === "number") return text.slice(0, tail);
  return repair(text, tail) ?? text;
}

/** The last block's inline text with each character's offset in the reply, or where to cut a table header. */
interface Tail { inline: string; offsets: number[] }

const fenceLine = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const containerFence = /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])[ \t]))+[ \t]*(?:`{3,}|~{3,})/m;
// HTML blocks that may hold blank lines, so they can reach the last block from anywhere above it.
const htmlSpan = /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])[ \t]))*[ \t]*<(?:!--|\?|![A-Za-z]|!\[CDATA\[|(?:pre|script|style|textarea)(?:[\s>]|$))/i;
const thematicBreak = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const setextLine = /^ {0,3}(?:=+|-+)[ \t]*$/;
const atxHeading = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
const listItem = /^ {0,3}([-*+]|(\d{1,9})[.)])([ \t]+|$)/;
const definitionStart = /^ {0,3}\[(?:[^\\\]]|\\.)*(?:\]:|\]$|\\?$)/;
const indentOf = (line: string) => {
  const space = /^[ \t]*/.exec(line)![0];
  return space.includes("\t") ? 4 : space.length;
};

/** Whether content can only be paragraph text at the start of a block. */
function plainStart(content: string): boolean {
  return indentOf(content) < 4 && !/^[ \t]*(?:>|<|\|)/.test(content) && !listItem.test(content) && !atxHeading.test(content)
    && !thematicBreak.test(content) && !definitionStart.test(content) && !fenceLine.test(content);
}

function hasPipe(line: string): boolean {
  for (let at = 0; at < line.length; at++) if (line[at] === "\\") at++; else if (line[at] === "|") return true;
  return false;
}

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

/** Whether a line could still grow into a delimiter row. */
const delimiterPrefix = (line: string) => /^ {0,3}[|:\- \t]*$/.test(line) && /[|:-]/.test(line)
  && line.split("|").every(cell => /^[ \t]*:?-*:?[ \t]*$/.test(cell));
/** Whether a delimiter row already turns the header above it into a table. */
function completesHeader(header: string, delimiter: string): boolean {
  if (!/^ {0,3}[|:\- \t]*$/.test(delimiter)) return false;
  const columns = cells(delimiter);
  return columns.length === cells(header).length && columns.every(cell => /^\s*:?-+:?\s*$/.test(cell));
}

type Context =
  | { kind: "none" }
  | { kind: "opaque" }
  | { kind: "text"; open: boolean; depth: number; list: boolean; segments: Array<[number, number]> };

type TextContext = Extract<Context, { kind: "text" }>;
const openText = (context: Context): TextContext | undefined => context.kind === "text" && context.open ? context : undefined;

/** Finds the last block's inline context, a cut offset for a table header, or undefined for no repair. */
function findTail(text: string): Tail | number | undefined {
  if (containerFence.test(text)) return undefined;
  const lines = text.split("\n");
  let offset = 0, fence: string | undefined, fenceIndent = 0, table = false;
  let context: Context = { kind: "none" };
  for (let index = 0; index < lines.length; offset += lines[index].length + 1, index++) {
    const line = lines[index];
    if (fence) {
      // A fence in a list item ends with the item, at a line left of the fence's indent.
      if (line.trim() && indentOf(line) < fenceIndent) return undefined;
      const marker = fenceLine.exec(line)?.[1];
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = undefined;
      continue;
    }
    const marker = fenceLine.exec(line)?.[1];
    if (marker) {
      [fence, fenceIndent, table, context] = [marker, indentOf(line), false, { kind: "none" }];
      continue;
    }
    if (htmlSpan.test(line)) return undefined;
    const quote = /^(?: {0,3}>[ \t]?)*/.exec(line)![0];
    const depth = quote.split(">").length - 1;
    let rest = line.slice(quote.length), start = offset + quote.length;
    if (!rest.trim()) {
      // A blank line ends the block once something follows it; the line being typed may be empty.
      if (index < lines.length - 1) [table, context] = [false, { kind: "none" }];
      continue;
    }
    if (context.kind === "opaque") continue;
    const previous = openText(context);
    if (previous && depth !== previous.depth) {
      // A shallower line is a lazy continuation; a deeper one starts a block in a nested quote.
      if (depth < previous.depth) { context = { kind: "opaque" }; continue; }
      context = { kind: "none" };
    }
    const current = openText(context);

    if (table) {
      if (depth || !/^ {0,3}\|/.test(rest)) { context = { kind: "opaque" }; continue; }
      // Each cell is its own inline context; only the last one can still be growing.
      let cell = 0;
      for (let at = 0; at < rest.length; at++) if (rest[at] === "\\") at++; else if (rest[at] === "|") cell = at + 1;
      context = { kind: "text", open: false, depth, list: false, segments: [[start + cell, offset + line.length]] };
      continue;
    }
    if (current && indentOf(rest) >= 4) {
      // Indented code cannot interrupt a paragraph, but a nested list item can.
      if (!plainStart(rest.trimStart())) { context = { kind: "opaque" }; continue; }
      current.segments.push([start, offset + line.length]);
      continue;
    }
    if (thematicBreak.test(rest) || (current && setextLine.test(rest))) { context = { kind: "none" }; continue; }
    const heading = atxHeading.exec(rest);
    if (heading) {
      const content = rest.slice(heading[0].length);
      // A closing run of # is not content; a closer after it would make it content.
      if (/#[ \t]*$/.test(content)) { context = { kind: "opaque" }; continue; }
      context = { kind: "text", open: false, depth, list: false, segments: [[start + heading[0].length, offset + line.length]] };
      continue;
    }
    let list: boolean = current?.list ?? false;
    const item = listItem.exec(rest);
    // A list item interrupts a paragraph only when it is not empty and, if ordered, starts at 1.
    const startsItem = !!item && (!current || list || (item[0].length < rest.length && (!item[2] || Number(item[2]) === 1)));
    if (item && startsItem) {
      if (item[3].includes("\t") || item[3].length > 4) { context = { kind: "opaque" }; continue; }
      rest = rest.slice(item[0].length);
      start += item[0].length;
      list = true;
      if (!rest.trim()) { context = { kind: "text", open: true, depth, list, segments: [] }; continue; }
      if (!plainStart(rest)) { context = { kind: "opaque" }; continue; }
    } else if (!current && !plainStart(rest) && !/^ {0,3}\|/.test(rest)) {
      context = { kind: "opaque" };
      continue;
    }

    if (hasPipe(rest)) {
      // A line with a pipe may be a table header; the line under it decides.
      const next = lines[index + 1];
      if (next === undefined || (!next && index + 1 === lines.length - 1)) return undefined;
      const header = depth === 0 && !list && /^ {0,3}\|/.test(rest);
      if (index + 1 === lines.length - 1 && delimiterPrefix(next)) {
        // Holding back the header must not take a closer or a line break from the paragraph above it.
        const safe = !current || (!/[*_~`[\]]/.test(rest) && !/(?:^|[^\\])(?:\\\\)*\\$/.test(lines[index - 1]));
        return !completesHeader(rest, next) && header && safe ? offset : undefined;
      }
      if (completesHeader(rest, next)) {
        // A table in a quote or list item may end in lazy lines; only one at the margin is followed.
        if (!header) { context = { kind: "opaque" }; continue; }
        [table, context] = [true, { kind: "none" }];
        offset += line.length + 1;
        index++;
        continue;
      }
    }
    if (current && !startsItem) current.segments.push([start, offset + line.length]);
    else context = { kind: "text", open: true, depth, list, segments: [[start, offset + line.length]] };
  }
  if (fence || context.kind !== "text" || !context.segments.length) return undefined;
  const offsets: number[] = [];
  let inline = "";
  for (const [index, [from, to]] of context.segments.entries()) {
    if (index) { offsets.push(from - 1); inline += "\n"; }
    for (let at = from; at < to; at++) offsets.push(at);
    inline += text.slice(from, to);
  }
  offsets.push(context.segments.at(-1)![1]);
  return { inline, offsets };
}

interface Run { char: string; at: number; size: number; length: number; open: boolean; close: boolean; order: number }
interface Scan {
  /** Openers still waiting, innermost last, with their unused size. */
  openers: Run[];
  /** Closers that matched nothing and cannot open, so they show as typed. */
  stray: Run[];
  tildes: Run[];
  /** The order of the last `*` or `_` run, to tell whether one follows a tilde. */
  lastEmphasis: number;
  /**
   * The first backtick run with no closer. Everything after it would turn to code, so `formatted`
   * says whether the parser formats anything there now: a pair, an escape, an entity, a line
   * break, a code span or a link, which code would show as typed. A lone tilde run cannot pair.
   */
  code?: { at: number; length: number; formatted: boolean };
  link?: { at: number; textEnd: number; image: boolean };
}

const classify = (char: string | undefined) => char === undefined || /\s/.test(char) ? 1 : /[\p{P}\p{S}]/u.test(char) ? 2 : 0;

/**
 * Walks one inline context as micromark does, closely enough to tell which openers still wait at
 * the end. Returns undefined for anything it does not model, or when the step budget runs out.
 */
function scan(text: string): Scan | undefined {
  let budget = 32 * text.length + 4096;
  const openers: Run[] = [], stray: Run[] = [], tildes: Run[] = [];
  // Per closer kind, the stack depth below which no opener can match it, as CommonMark keeps.
  const bottom = new Map<string, number>();
  const brackets: Array<{ at: number; image: boolean; base: number; runs: number; crossed: boolean; active: boolean }> = [];
  // Code spans: each backtick run's start, by length, so a closer is found without rescanning.
  const ticks = new Map<number, number[]>(), next = new Map<number, number>();
  for (let at = 0; at < text.length;) {
    if (text[at] !== "`") { at++; continue; }
    let end = at;
    while (text[end] === "`") end++;
    const list = ticks.get(end - at) ?? [];
    list.push(at);
    ticks.set(end - at, list);
    at = end;
  }
  let runs = 0, lastEmphasis = -1;
  let code: Scan["code"];
  const result = (extra: Partial<Scan> = {}): Scan => ({ openers, stray, tildes, lastEmphasis, code, ...extra });
  const formats = () => { if (code) code.formatted = true; };
  for (let at = 0; at < text.length;) {
    if (--budget < 0) return undefined;
    const char = text[at];
    if (char === "&" || char === "\n") formats();
    if (char === "\\") {
      if (/[!-/:-@[-`{-~]/.test(text[at + 1] ?? "")) { formats(); at += 2; continue; }
      at++;
      continue;
    }
    if (char === "<" || char === "@" || text.startsWith("://", at) || ((char === "w" || char === "W") && /^www\./i.test(text.slice(at, at + 4)))) return undefined;
    if (char === "`") {
      let length = 0;
      while (text[at + length] === "`") length++;
      const list = ticks.get(length) ?? [];
      let pointer = next.get(length) ?? 0;
      while (pointer < list.length && list[pointer] < at + length) { pointer++; budget--; }
      next.set(length, pointer);
      if (pointer === list.length) {
        // Unmatched, so literal for now; scanning goes on to learn what follows it.
        code ??= { at, length, formatted: false };
        at += length;
        continue;
      }
      formats();
      at = list[pointer] + length;
      continue;
    }
    if (char === "[" || (char === "!" && text[at + 1] === "[")) {
      const image = char === "!";
      brackets.push({ at, image, base: openers.length, runs, crossed: false, active: true });
      at += image ? 2 : 1;
      continue;
    }
    if (char === "]") {
      const bracket = brackets.pop();
      at++;
      if (!bracket) continue;
      const inline = bracket.active && text[at] === "(";
      if (!inline) {
        // It may be a reference link, whose text keeps its markers to itself.
        if (runs !== bracket.runs) return undefined;
        continue;
      }
      let depth = 1, end = at + 1;
      for (; end < text.length && depth; end++) {
        if (--budget < 0) return undefined;
        if (/[\s<]/.test(text[end])) return undefined;
        if (text[end] === "\\") end++;
        else if (text[end] === "(") depth++;
        else if (text[end] === ")") depth--;
      }
      if (bracket.crossed) return undefined;
      formats();
      if (depth) {
        // The destination is still arriving. Markers in the text must pair inside it.
        if (openers.length > bracket.base) return undefined;
        return result({ link: { at: bracket.at, textEnd: at - 1, image: bracket.image } });
      }
      // Markers left in a finished link's text stay literal inside it.
      if (openers.length > bracket.base) openers.length = bracket.base;
      for (const [key, value] of bottom) if (value > openers.length) bottom.set(key, openers.length);
      if (!bracket.image) for (const outer of brackets) if (!outer.image) outer.active = false;
      at = end;
      continue;
    }
    if (char === "~") {
      let length = 0;
      while (text[at + length] === "~") length++;
      const before = classify(text[at - 1]), after = classify(text[at + length]);
      if (length <= 2) {
        tildes.push({ char, at, size: length, length, open: !after || (after === 2 && !!before), close: !before || (before === 2 && !!after), order: runs++ });
      }
      at += length;
      continue;
    }
    if (char === "*" || char === "_") {
      let length = 0;
      while (text[at + length] === char) length++;
      lastEmphasis = runs;
      const previous = text[at - 1], following = text[at + length];
      const before = classify(previous), after = classify(following);
      const open = !after || (after === 2 && !!before) || following === "~";
      const close = !before || (before === 2 && !!after) || previous === "~";
      const run: Run = {
        char, at, size: length, length,
        open: char === "*" ? open : open && (!!before || !close),
        close: char === "*" ? close : close && (!!after || !open),
        order: runs++,
      };
      at += length;
      if (run.close) {
        while (run.size) {
          const key = `${char}${run.open ? 1 : 0}${run.size % 3}`;
          let found = -1;
          for (let index = openers.length - 1; index >= (bottom.get(key) ?? 0); index--) {
            if (--budget < 0) return undefined;
            const opener = openers[index];
            if (opener.char !== char) continue;
            if ((opener.close || run.open) && run.size % 3 && !((opener.size + run.size) % 3)) continue;
            found = index;
            break;
          }
          if (found < 0) { bottom.set(key, openers.length); break; }
          formats();
          // Brackets opened after the matched opener now hold half a pair; their bases only grow upward.
          for (let index = brackets.length - 1; index >= 0 && brackets[index].base > found; index--) {
            if (--budget < 0) return undefined;
            brackets[index].crossed = true;
          }
          const opener = openers[found];
          const use = opener.size > 1 && run.size > 1 ? 2 : 1;
          openers.length = found + 1;
          opener.size -= use;
          run.size -= use;
          if (!opener.size) openers.pop();
          for (const [key, value] of bottom) if (value > found) bottom.set(key, found);
        }
      }
      if (run.size && run.open) openers.push(run);
      else if (run.size) stray.push(run);
      continue;
    }
    at++;
  }
  return result();
}

const opensAfter = (char: string | undefined) => char === undefined || /[\s([{"'“‘]/.test(char);
const opensBefore = (char: string | undefined) => !!char && /[\p{L}\p{N}`([{"'“‘]/u.test(char);

function repair(text: string, tail: Tail): string | undefined {
  const { inline, offsets } = tail;
  const found = scan(inline);
  // Two tilde runs of one size may strike, and micromark resolves a strike's inside on its own,
  // which this scan does not model; then nothing it found can be trusted.
  if (!found || [1, 2].some(size => found.tildes.filter(tilde => tilde.size === size).length > 1)) return undefined;
  // What shows: the context with a link's bracket and destination removed, and where each character sits in the reply.
  let shown = inline, visible = text, place = (index: number) => offsets[index];
  if (found.link) {
    // Show the link's text until its destination closes; an image waits whole. Hiding the
    // destination must not hide a marker that pairs with one before it.
    const { at, textEnd, image } = found.link;
    const destination = inline.slice(textEnd + 2);
    if ((found.tildes.length && destination.includes("~")) || found.openers.some(opener => destination.includes(opener.char))) return undefined;
    shown = inline.slice(0, at) + (image ? "" : inline.slice(at + 1, textEnd));
    visible = text.slice(0, offsets[at]) + (image ? "" : text.slice(offsets[at] + 1, offsets[textEnd]));
    place = index => index < at ? offsets[index] : offsets[index + 1] - 1;
  }
  const head = shown.trimEnd();
  // An empty list item cannot interrupt the paragraph above it, so cutting a link to nothing would join them.
  if (!head.trim()) return undefined;

  let closers = "";
  const closed: Run[] = [];
  if (found.code) {
    const { at, length, formatted } = found.code;
    if (formatted || found.link) return undefined;
    // A half-typed closer is finished; a longer run after the opener cannot close it.
    const typed = /`*$/.exec(head.slice(at + length))![0].length;
    if (typed >= length) return undefined;
    closers += "`".repeat(length - typed);
  }
  const [tilde, half] = found.tildes;
  if (tilde?.size === 2 && tilde.open && found.lastEmphasis < tilde.order && opensAfter(inline[tilde.at - 1]) && opensBefore(inline[tilde.at + 2])) {
    // A lone `~~`, or one whose closer is half typed, with no emphasis marker after it.
    if (found.tildes.length === 1) closers += "~~";
    else if (found.tildes.length === 2 && half.size === 1 && half.at + 1 === head.length && !/\s/.test(head[half.at - 1])) closers += "~";
  }
  const struck = closers.includes("~") ? head.length + closers.length : 0;
  // Openers after an unclosed code span become code.
  const waiting = found.openers.filter(opener => !found.code || opener.at < found.code.at);
  for (let index = waiting.length - 1; index >= 0; index--) {
    const opener = waiting[index];
    if (opener.char === "_") continue;
    // A `*` that is not clearly strong would capture the closer meant for one outside it.
    if (opener.length < 2 || opener.length > 3 || !opensAfter(inline[opener.at - 1]) || !opensBefore(inline[opener.at + opener.length])) break;
    closers += "*".repeat(opener.size);
    closed.push(opener);
  }
  if (!closers && !found.link) return undefined;
  // A closer beside a different marker changes how that marker flanks, and so what it pairs with.
  if (!found.code && closers && /[*_~]$/.test(head) && head.at(-1) !== closers[0]) return undefined;

  // The repaired context must close exactly what was meant and change nothing else.
  const check = scan(head + closers);
  if (!check || check.code || check.link || check.stray.some(run => run.at + run.length > head.length)) return undefined;
  // Openers inside the outermost closed one are enclosed and stay literal, as they were.
  const enclosed = closed.length ? closed.at(-1)!.at : Infinity;
  const expected = waiting.filter(opener => opener.at < enclosed && !closed.includes(opener));
  if (check.openers.length !== expected.length || check.openers.some((opener, index) => opener.at !== expected[index].at || opener.size !== expected[index].size)) return undefined;
  // A tilde closer must form one run of two, right after any code closer, pairing with the lone opener.
  const strike = check.tildes.at(-1);
  if (struck && (check.tildes.length !== 2 || strike!.size !== 2 || strike!.at + 2 !== struck)) return undefined;
  const end = place(head.length - 1) + 1;
  return visible.slice(0, end) + closers + visible.slice(end);
}
