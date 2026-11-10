import { readFileSync } from "node:fs";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { describe, expect, it } from "vitest";
import { completeStreamingTail } from "../src/components/streaming-tail";

/** The marker characters the parser leaves as plain text, in order. */
function literalMarkers(text: string): string {
  let found = "";
  const walk = (node: { type: string; value?: string; children?: unknown[] }) => {
    if (node.type === "text") found += node.value!.replace(/[^*_~`]/g, "");
    else for (const child of node.children ?? []) walk(child as typeof node);
  };
  walk(fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
  return found;
}

/** Short strings of words, spaces and markers from a fixed seed, so a failure always reproduces. */
function samples(alphabet: string, count: number): string[] {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: count }, () => "x" + Array.from({ length: 1 + Math.floor(next() * 9) }, () => alphabet[Math.floor(next() * alphabet.length)]).join(""));
}

const fence = "```";

describe("completing a streaming reply's tail", () => {
  it.each([
    // Each marker closes once it has content.
    ["strong", "Use **care", "Use **care**"],
    ["a half-typed strong closer", "Use **care*", "Use **care**"],
    ["emphasis", "Use *patience", "Use *patience*"],
    ["underscore emphasis", "Use _patience", "Use _patience_"],
    ["strong emphasis", "***Both", "***Both***"],
    ["strikethrough", "Was ~~Friday", "Was ~~Friday~~"],
    ["a half-typed strikethrough closer", "Was ~~Friday~", "Was ~~Friday~~"],
    ["inline code", "Run `npm ci", "Run `npm ci`"],
    ["a half-typed code closer", "Run ``a`b`", "Run ``a`b``"],
    ["markers inside an open code span as code", "Run `a **b", "Run `a **b`"],
    ["code inside strong, innermost first", "**Run `npm ci", "**Run `npm ci`**"],
    ["a closer before trailing whitespace", "Use **care \n", "Use **care** \n"],
    // Links show their text until the URL closes; a partial image waits.
    ["a link with a partial URL", "See [the docs](https://exa", "See the docs"],
    ["a link with a balanced paren in its URL", "See [it](https://x.test/a_(b)", "See it"],
    ["a link before its URL", "See [the do", "See the do"],
    ["a link's text with an open marker", "See [**the do", "See **the do**"],
    ["a partial image", "Here ![a barn](https://exa", "Here "],
    // Each block kind is its own context.
    ["a heading", "## **Plan", "## **Plan**"],
    ["a list item", "1. Feed\n2. **Water", "1. Feed\n2. **Water**"],
    ["a paragraph across lines in a quote", "> **Soak the\n> beans", "> **Soak the\n> beans**"],
    ["a quoted paragraph's lazy continuation", "> **Soak the\nbeans", "> **Soak the\nbeans**"],
    ["a table's last cell", "| a | b |\n| - | - |\n| 1 | **tw", "| a | b |\n| - | - |\n| 1 | **tw**"],
    // A table header waits for its delimiter row.
    ["a table header", "Menu:\n| Day | Me", "Menu:\n"],
    ["a finished table header line", "| Day | Meal |\n", ""],
    ["a delimiter row too short for the header", "| Day | Meal |\n| --- |", ""],
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
    ["multiplication with spaces", "2 * 3 = 6"],
    ["multiplication inside a word", "Area is 2*3"],
    ["snake_case", "Set max_retry_count"],
    ["a single tilde", "About ~5 minutes"],
    ["an opener with nothing after it", "Use **"],
    ["an opener followed only by markers", "Use **_"],
    ["a marker that cannot close after a space", "*a *"],
    ["a trailing backslash", "**Soak\\"],
    ["an opener in an earlier paragraph", "Price **soon\n\nNext"],
    ["an opener above a heading", "Price **soon\n## Next"],
    ["an opener above a quote", "Price **soon\n> Next"],
    ["an opener above a rule", "Price **soon\n---"],
    ["an opener in an earlier list item", "- **Soak\n- Rinse"],
    ["an opener inside a finished link's text", "See [**the docs](https://x.test) now"],
    ["a marker inside an inline HTML tag", 'Press <kbd title="*key">'],
    ["a footnote call or regex class", "Match [^a-z"],
    ["a bracket glued to a word", "items[0"],
    ["a table body row", "| a | b |\n| - | - |\n| 1 | 2"],
    ["an opener in an earlier table cell", "| a | b |\n| - | - |\n| **1 | 2"],
  ])("leaves %s alone", (_case, text) => {
    expect(completeStreamingTail(text)).toBe(text);
  });

  // The real parser is the judge: text it reads with no stray marker must come back unchanged, and
  // a repair of emphasis must not leave more stray markers than it found.
  it("never changes text the parser reads as finished, and never adds a stray marker", () => {
    const changed = samples("a *_~`", 4000).filter(text => !literalMarkers(text) && completeStreamingTail(text) !== text);
    expect(changed).toEqual([]);
    const worse = samples("a *_", 4000).filter(text => literalMarkers(completeStreamingTail(text)).length > literalMarkers(text).length);
    expect(worse).toEqual([]);
  });

  // Every finished paragraph in this repository's own docs is well formed; none may change.
  it("leaves well-formed Markdown unchanged", () => {
    const chunks = readFileSync(new URL("../README.md", import.meta.url), "utf8").split(/\n\n(?=\S)/);
    expect(chunks.filter(chunk => completeStreamingTail(chunk) !== chunk)).toEqual([]);
  });
});
