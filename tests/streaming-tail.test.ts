import { readFileSync, readdirSync } from "node:fs";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { describe, expect, it } from "vitest";
import { completeStreamingTail } from "../src/components/streaming-tail";

interface Node { type: string; value?: string; alt?: string; url?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } }
const parse = (text: string) => fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as Node;
const leaves = new Set(["text", "inlineCode", "code", "html"]);

function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}
/** The characters a reader sees, in document order. */
function visible(text: string): string {
  let shown = "";
  walk(parse(text), node => { if (leaves.has(node.type)) shown += node.value; else if (node.type === "image") shown += node.alt ?? ""; });
  return shown;
}
/** Every link, image and definition destination. */
function destinations(text: string): Set<string> {
  const urls = new Set<string>();
  walk(parse(text), node => { if (node.url !== undefined) urls.add(node.url); });
  return urls;
}
/** Offsets of `*`, `_` and `~` that the parser shows as characters rather than formatting. */
function literalMarkers(text: string): Set<number> {
  const literal = new Set<number>();
  walk(parse(text), node => {
    // Text that the autolink transform splits off has no source position; it is the same in both parses.
    if (!leaves.has(node.type) || !node.position) return;
    for (let at = node.position.start.offset!; at < node.position.end.offset!; at++) if ("*_~".includes(text[at])) literal.add(at);
  });
  return literal;
}
const isSubsequence = (part: string, whole: string) => {
  let at = 0;
  for (const char of whole) if (char === part[at]) at++;
  return at === part.length;
};

/** Seeded strings built from Markdown fragments, so a failure always reproduces. */
function samples(fragments: string[], count: number, length: number, seed = 7): string[] {
  const pick = (range: number) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8) % range;
  return Array.from({ length: count }, () => Array.from({ length: 1 + pick(length) }, () => fragments[pick(fragments.length)]).join(""));
}
const prefixes = (text: string) => Array.from({ length: text.length }, (_, end) => text.slice(0, end + 1));

const fence = "```";

describe("completing a streaming reply's tail", () => {
  it.each([
    // Strong and code close once they have content, innermost first.
    ["strong", "Use **care", "Use **care**"],
    ["a half-typed strong closer", "Use **care*", "Use **care**"],
    ["strong emphasis", "***Both", "***Both***"],
    ["strong before a link", "**[docs](https://x.test/a_b) now", "**[docs](https://x.test/a_b) now**"],
    ["strikethrough", "Was ~~Friday", "Was ~~Friday~~"],
    ["strikethrough after a tilde run too long to strike", "x ~~~a ~~b", "x ~~~a ~~b~~"],
    ["a half-typed strikethrough closer", "Was ~~Friday~", "Was ~~Friday~~"],
    ["strong after a struck word that cannot close", "~~a **b", "~~a **b**"],
    ["inline code", "Run `npm ci", "Run `npm ci`"],
    ["a half-typed code closer", "Run ``a`", "Run ``a``"],
    ["markers inside an open code span as code", "Run `a **b", "Run `a **b`"],
    ["code inside strong", "**Run `npm ci", "**Run `npm ci`**"],
    ["a closer before trailing whitespace", "Use **care \n", "Use **care** \n"],
    // An unrepaired `_` opener does not take the strong closer.
    ["strong around an underscore that stays literal", "**a _b", "**a _b**"],
    // Decided: a bare **kwargs reads as strong until its paragraph ends; assistants put code in backticks.
    ["a bare double asterisk before a word", "Pass **kwargs", "Pass **kwargs**"],
    // A link shows its text while its destination arrives; an image waits.
    ["a link with a partial URL", "See [the docs](https://exa", "See the docs"],
    ["a link with a balanced paren in its URL", "See [it](https://x.test/a_(b)", "See it"],
    ["a link whose text holds closed markers", "See [**the** do](https://exa", "See **the** do"],
    ["strong around a link in progress", "**See [docs](https://exa", "**See docs**"],
    ["a partial image", "Here ![a barn](https://exa", "Here "],
    // A link cannot hold a link, so brackets around a finished one are text.
    ["strong around brackets that hold a link", "**a [b [c](d) e](f", "**a [b [c](d) e](f**"],
    // Each block kind is its own context.
    ["a heading", "## **Plan", "## **Plan**"],
    ["a list item", "1. Feed\n2. **Water", "1. Feed\n2. **Water**"],
    ["a list item's continuation line", "- **Soak\n  the beans", "- **Soak\n  the beans**"],
    ["a paragraph line that only looks like a list item", "Text **a\n2. b", "Text **a\n2. b**"],
    ["a list item in a quote", "> - **Soak", "> - **Soak**"],
    ["a paragraph across lines in a quote", "> **Soak the\n> beans", "> **Soak the\n> beans**"],
    ["a quoted paragraph ending in an empty quote line", "> **Soak\n>", "> **Soak**\n>"],
    ["a table's last cell", "| a | b |\n| - | - |\n| 1 | **tw", "| a | b |\n| - | - |\n| 1 | **tw**"],
    // A table header waits only once its delimiter row has begun.
    ["a header over a delimiter row that has begun", "| Day | Meal |\n| -", ""],
    ["a header over a delimiter row too short for it", "| Day | Meal |\n| --- |", ""],
    ["a header after a paragraph", "Menu:\n| Day | Meal |\n| -", "Menu:\n"],
    ["a delimiter row that makes a table", "| Day | Meal |\n| - | -", "| Day | Meal |\n| - | -"],
  ])("completes %s", (_case, text, shown) => {
    expect(completeStreamingTail(text)).toBe(shown);
  });

  it.each([
    ["markers in a code span", "Type `**` then go."],
    ["an unfinished fenced block", `Code:\n\n${fence}js\nconst a = **b`],
    ["a table header in an unfinished fence", "~~~md\n| Day | Meal |"],
    ["an indented code block", "Code:\n\n    let a = **b"],
    ["a balanced reply", "**Done**, _also_ ~~gone~~ and `code`. See [docs](https://x.test)."],
    ["an escaped marker", "Literal \\*\\*stars and \\_under"],
    // What assistants write that is not emphasis: a single `*`, any `_` and a single `~` never close.
    ["a file glob", "Use *.ts files"],
    ["a recursive glob", "Match **/*.ts"],
    ["a single asterisk before a word", "Pass *args"],
    ["a footnote asterisk", "Prices are estimates.*"],
    ["multiplication with spaces", "2 * 3 = 6"],
    ["multiplication inside a word", "Area is a*b*c"],
    ["snake_case", "Set max_retry_count"],
    ["a leading underscore", "The _private field"],
    ["underscore emphasis", "Use _patience"],
    ["a home directory", "Open ~user/notes"],
    ["a single tilde", "About ~5 minutes"],
    ["a strong opener before a word glued to punctuation", "Use **.env"],
    ["an italic inside strong", "**a *b"],
    ["an opener with nothing after it", "Use **"],
    ["an opener followed only by markers", "Use **_"],
    ["a strong closer that cannot close after a space", "**a **"],
    ["a strikethrough with emphasis after it", "~~a *b*"],
    // Where micromark's flanking differs from a simpler rule, found by searching random strings.
    ["a single asterisk the rule of three keeps from closing strong", "**a*b"],
    ["closers that would merge with an emphasis closer the rule of three then splits", "**a **b*c*"],
    ["a closer beside an underscore that already closed", "**b __~_"],
    ["a link cut that would empty a list item", "(~~\n* [](x"],
    ["a double underscore that cannot open between a word and a tilde", "_(**bbbx__~b"],
    ["an underscore that closes only at the end of the text", "`~__ax_"],
    ["an asterisk beside a tilde", "b***~*(**("],
    ["a trailing backslash", "**Soak\\"],
    ["a trailing backslash before a tilde closer", "Was ~~Friday\\"],
    ["an exponent", "Compute 2**10"],
    ["a strikethrough glued to a word", "Path a~~b"],
    ["a strikethrough before a path", "Use ~~/tmp"],
    ["strong inside a finished strikethrough", "~~a **b~~ c"],
    ["a code opener before an entity", "Run `a &amp; b"],
    ["an HTML attribute that holds a marker", 'Use **a <span title="**b">'],
    ["a link whose text a match crosses", "**a [b** c](x"],
    ["a code opener with nothing after it", "**Run `"],
    // Code would show what the parser formats after the opener now: a pair, an escape or a line break.
    ["a code opener before strong text", "Run `a **b** c"],
    ["a code opener before a code span", "Run ``a`b`"],
    ["a code opener before an escape", "Run `a \\*"],
    ["a code opener before a line break", "Run `a\nb"],
    // Earlier blocks are finished.
    ["an opener in an earlier paragraph", "Price **soon\n\nNext"],
    ["an opener above a heading", "Price **soon\n## Next"],
    ["an opener above a quote", "Price **soon\n> Next"],
    ["an opener above a rule", "Price **soon\n---"],
    ["an opener in an earlier list item", "- **Soak\n- Rinse"],
    ["an opener in an earlier table cell", "| a | b |\n| - | - |\n| **1 | 2"],
    ["an opener inside a finished link's text", "See [**the docs](https://x.test) now"],
    ["a heading with a closing sequence", "## **Plan #"],
    // Links and destinations are never rewritten.
    ["a link before its destination", "See [the do"],
    ["a link whose text holds an open marker", "See [**the do](https://exa"],
    ["a destination with a space", "See [a](b c"],
    ["a footnote call or regex class", "Match [^a-z"],
    ["a bracket glued to a word", "items[0"],
    ["a marker inside a reference link's text", "**See [*docs] **x"],
    ["a reference definition's destination", "See [docs][r].\n\n[r]: https://example.test/_private"],
    ["a definition label still open", "**See\n\n[r"],
    ["a bare autolink", "https://example.test/a_[b"],
    ["strong before a bare autolink", "**See https://example.test/a_"],
    ["an angle autolink", "**See <https://example.test/a_b"],
    ["an email address", "**Mail nic@example.test"],
    ["a www autolink", "Open www.x.test/(**a"],
    ["a marker inside an inline HTML tag", 'Press <kbd title="*key">'],
    ["an HTML comment above", "<!--\n\n**a"],
    // Fences the line walk cannot follow.
    ["a fence in a list item", "- ```\n  **literal"],
    ["a list item's closing fence read as an opener", "- ```\n  ```\n  ```\n  **a"],
    ["a list item's fence that ends at a line left of it", "- Run:\n\n  ```\nx\n  ```\n**a"],
    ["a fence in a quote", "> ~~~\n> **literal"],
    ["reply cards in a list item", '- ```agent-ui\n  {"title": "**x'],
    // Tables are judged only once they are tables.
    ["a paragraph that starts with a pipe", "| this is a paragraph"],
    ["a lone header line", "| Day | Meal |\n"],
    ["indented code that starts with a pipe", "    | literal code"],
    ["a table body row", "| a | b |\n| - | - |\n| 1 | 2"],
    ["an indented line under a table", "| a | b |\n| - | - |\n    **a"],
    ["a table in a quote", "> | a | b |\n> | - | - |\n> | **1"],
    ["a quoted header over lazy rows", "> | a | b |\n| - | - |\n| **c"],
    ["a header without a leading pipe over a delimiter row that has begun", "a | b\n| -"],
    ["a lazy quote continuation", "> **Soak the\nbeans"],
    ["a lazy quote line that closes a code span", "> a`\nb`c"],
    ["a setext heading underline", "**Plan\n="],
    ["indented code in a nested list item", "- -     **a"],
    ["indented code in a list item", "-      **a"],
    ["a nested list item indented four spaces", "- a **b\n    - c"],
    ["a pipe line that continues a paragraph over a delimiter row", "**a\nb** | c\n|"],
    ["a header that would take a closer from the paragraph above", "**a\n| b** | c |\n|"],
    ["a header that would take a line break from the paragraph above", "a\\\n| b | c |\n|"],
    ["a link destination that closes a strike before it", "~~a [b](c~~"],
    ["a link destination that closes strong before it", "**a [b](c**"],
    ["a strike in a link's text", "~~a [b~~ c](d"],
  ])("leaves %s alone", (_case, text) => {
    expect(completeStreamingTail(text)).toBe(text);
  });

  // The delimiter stack keeps a floor per closer kind, so a long reply with many openers still repairs.
  it("repairs the end of a long reply with many unmatched delimiters", () => {
    const text = "*a ".repeat(3000) + "b_ ".repeat(3000) + "**c";
    expect(completeStreamingTail(text)).toBe(text + "**");
  });

  it("does not overflow the stack on many open brackets", () => {
    const text = "[a ".repeat(8000);
    expect(completeStreamingTail(text)).toBe(text);
  });

  // Runs on every streaming update, so it must stay linear on the worst delimiter mix.
  it("returns quickly on many unmatched delimiters", () => {
    for (const text of ["*a ".repeat(16000) + "b_ ".repeat(16000), "**a ".repeat(25000), "`a ``b ".repeat(14000), "[a](b ".repeat(16000), "[a **b** ".repeat(11000),
      // Each closer matches an opener below every open bracket.
      "**a ".repeat(12000) + "[b ".repeat(12000) + "c** ".repeat(12000)]) {
      const start = performance.now();
      completeStreamingTail(text);
      expect(performance.now() - start).toBeLessThan(100);
    }
  });

  /*
   * The parser is the judge. For every prefix p of a reply and live = completeStreamingTail(p):
   *   1. the visible text of live is a subsequence of the visible text of p: a repair only hides;
   *   2. every destination in live is a destination in p or in the whole reply;
   *   3. a marker the parser formats in p is still formatted in live: a repair never undoes one;
   *   4. for replies an assistant would write, a marker live formats but p shows literally is one
   *      the whole reply formats too, so live never shows formatting the saved reply will not.
   * It never throws, and the average call stays well under a millisecond.
   */
  const reviewed = [
    "Note[^a]\n\nHere:\n\n- ```\n  code\n  ```\n\n[^a]: footnote",
    "See [docs][r].\n\n[r]: https://example.test/_private",
    "https://example.test/a_[b",
    "- ```\n  **literal",
    "> ~~~\n> **literal",
    "- ```agent-ui\n  {\"a\": \"**x\"}\n  ```",
    "| this is a paragraph",
    "    | literal code",
    "Use *.ts files",
    "**See [docs](https://exa.test/a_b) and **more",
  ];
  const fragments = ["a", "b ", " ", "*", "**", "_", "__", "~", "~~", "`", "``", "[", "]", "](", "(", ")", "![", "\\", "<", "|", " | ",
    "\n", "\n\n", "> ", "- ", "1. ", "# ", "    ", "```\n", "https://x.test/a_", "@x.test", "[r]: /u_", "| - |", "\n| - | - |\n"];

  let spent = 0, calls = 0;
  function checkProperties(text: string, judge: (live: string, prefix: string) => void) {
    const saved = destinations(text);
    for (const prefix of prefixes(text)) {
      const start = performance.now();
      const live = completeStreamingTail(prefix);
      spent += performance.now() - start;
      calls++;
      if (live === prefix) continue;
      expect(isSubsequence(visible(live), visible(prefix)), JSON.stringify([prefix, live])).toBe(true);
      const known = destinations(prefix);
      for (const url of destinations(live)) expect(known.has(url) || saved.has(url), JSON.stringify([prefix, live, url])).toBe(true);
      const kept = prefix.trimEnd();
      if (!live.startsWith(kept)) continue;
      const before = literalMarkers(prefix), after = literalMarkers(live);
      for (let at = 0; at < kept.length; at++) if ("*_~".includes(kept[at]) && !before.has(at)) expect(after.has(at), JSON.stringify([prefix, live, at])).toBe(false);
      judge(live, prefix);
    }
  }

  it("only hides characters, keeps destinations and formatting, for random and reviewed replies", () => {
    [spent, calls] = [0, 0];
    for (const text of [...reviewed, ...samples(fragments, 300, 24)]) checkProperties(text, () => {});
    expect(spent / calls).toBeLessThan(0.5);
  });

  const replies = [
    "**Bold** start, then *italic*, `code` and ~~struck~~ text.",
    "Use *.ts files and **/*.js globs; pass *args through.",
    "The _private field, __init__ and max_retry_count stay as typed.",
    "Home is ~user and ~/notes; it takes about ~5 minutes.",
    "Math: a*b*c and 2 * 3 * 4. Prices are estimates.*",
    "A [link](https://example.test/a_b_c), https://example.test/x_y and <https://example.test/z_>.",
    "**[Docs](https://example.test/docs)** and **more `npm ci` here**.",
    "## **Plan** for today\n\n- **Soak** the beans\n- Rinse them *well*\n\n> **Note:** keep the ~~lid~~ pot covered.",
    "| Day | Meal |\n| --- | --- |\n| **Sat** | `chili` |\n| Sun | ~~beans~~ stew |",
    "Run this:\n\n```py\nx = a**b\nprint(*args)\n```\n\nThen **check** it.",
    "See [the docs][r] and **this**.\n\n[r]: https://example.test/_private",
  ];

  it("never formats live what the saved reply shows as typed, and does format what it will", () => {
    let repaired = 0;
    for (const text of replies) {
      const saved = literalMarkers(text);
      checkProperties(text, (live, prefix) => {
        const before = literalMarkers(prefix), after = literalMarkers(live);
        for (const at of before) if (!after.has(at)) {
          expect(saved.has(at), JSON.stringify([prefix, live, at])).toBe(false);
          repaired++;
        }
      });
    }
    // An identity function passes everything above; this is what the repair is for.
    expect(repaired).toBeGreaterThan(100);
  });

  // Text the parser reads with no stray marker is finished and comes back unchanged, including
  // every paragraph of this repository's own docs.
  it("leaves text the parser reads as finished unchanged", () => {
    const docs = ["README.md", ...readdirSync(new URL("../docs/", import.meta.url)).filter(name => name.endsWith(".md")).map(name => `docs/${name}`)];
    const chunks = docs.flatMap(path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").split(/\n\n(?=\S)/));
    const strayFree = (text: string) => {
      let stray = false;
      walk(parse(text), node => { if (node.type === "text" && /[*_~`]/.test(node.value!)) stray = true; });
      return !stray;
    };
    const finished = [...chunks, ...samples(["a", " ", "*", "_", "~", "`", "**", "~~"], 4000, 10)].filter(strayFree);
    expect(finished.length).toBeGreaterThan(2000);
    expect(finished.filter(text => completeStreamingTail(text) !== text)).toEqual([]);
  });
});
