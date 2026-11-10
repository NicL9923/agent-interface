import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { describe, expect, it } from "vitest";
import { BLOCK_LIMIT, HOLD_LIMIT, streamingHoldBack } from "../src/components/streaming-hold-back";

interface Node { type: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } }
// The micromark stack React Markdown uses, so "code" means what the transcript renders as a code block.
const parse = (text: string) => fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as Node;
function codeRanges(node: Node, ranges: Array<[number, number]> = []) {
  if (node.type === "code") ranges.push([node.position!.start.offset!, node.position!.end.offset!]);
  for (const child of node.children ?? []) codeRanges(child, ranges);
  return ranges;
}

/** Seeded strings built from fragments, so a failure always reproduces. */
function samples(fragments: string[], count: number, length: number, seed = 7): string[] {
  const pick = (range: number) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8) % range;
  return Array.from({ length: count }, () => Array.from({ length: 1 + pick(length) }, () => fragments[pick(fragments.length)]).join(""));
}

const fence = "```";
const replies = [
  "**Bold** start, then *italic*, `code` and ~~struck~~ text.",
  "Use *.ts files and **/*.js globs; pass *args through.",
  "The _private field, __init__ and max_retry_count stay as typed.",
  "Home is ~user and ~/notes; it takes about ~5 minutes.",
  "Math: a*b*c and 2 * 3 * 4. Prices are estimates.*",
  "A [link](https://example.test/a_b_c), https://example.test/x_y and <https://example.test/z_>.",
  "**[Docs](https://example.test/docs)** and **more `npm ci` here**. ![Logo](https://example.test/logo.png \"Logo\")",
  "## **Plan** for today\n\n- **Soak** the beans\n- Rinse them *well*\n  - [ ] Check the pot\n\n> **Note:** keep the ~~lid~~ pot covered.",
  "| Day | Meal |\n| --- | :---: |\n| **Sat** | `chili` |\n| Sun | ~~beans~~ stew |\n\nEnjoy.",
  `Run this:\n\n${fence}py\nx = a**b\nprint(*args, **kwargs)\n[r]: not a link\n${fence}\n\nThen **check** it.`,
  "See [the docs][r] and **this**.\n\n[r]: https://example.test/_private",
  `Set up\n=====\n\nInstall:\n\n${fence}bash\nnpm install bullmq\n${fence}\n\n1. Create the key:\n\n   ${fence}sh\n   az keyvault key create --name \`app\`\n   ${fence}\n\n2. Restart the app.\n\n---\n\nDone.`,
  "The error:\n\n> TypeError: wrapper() got an unexpected keyword argument 'retry'\n\nIndented sample:\n\n    def wrapper(*args, **kwargs):\n        return fn(*args, **kwargs)\n\nThat **should** clear it.",
  "Windows line endings\r\nwith **bold**\r\n\r\n    `code` **here**\r\nand `more`.",
];
const fragments = ["*", "**", "_", "__", "~", "~~", "`", "``", fence, "~~~", "[", "]", "(", ")", "![", "](", "|", "| --- ", "-", "#", ">", "=",
  " ", " ", " ", "word", "a", "1", "\t", "\r", "\n", "\n", "\n\n", "    ", "\\", "!", ":", "https://x.test/", "1. ", "- ", "\"", "'"];
const prefixes = (text: string) => Array.from({ length: text.length + 1 }, (_, end) => text.slice(0, end));

describe("holding back a streaming reply's unfinished tail", () => {
  // The contract is mechanical, so it is checked on every prefix rather than by sampling formatting.
  it("returns a prefix, holds at most the bound on the last line, and never cuts code", () => {
    const faults: string[] = [];
    let cuts = 0;
    for (const text of [...replies, ...samples(fragments, 400, 40)]) for (const prefix of prefixes(text)) {
      const shown = streamingHoldBack(prefix), held = prefix.slice(shown.length);
      if (!prefix.startsWith(shown)) faults.push(`not a prefix: ${JSON.stringify([prefix, shown])}`);
      else if (held.length > HOLD_LIMIT) faults.push(`over the bound: ${JSON.stringify(prefix)}`);
      else if (/[\r\n]/.test(held)) faults.push(`crossed a line break: ${JSON.stringify([prefix, shown])}`);
      else if (held && codeRanges(parse(prefix)).some(([start, end]) => start < prefix.length && end > shown.length)) faults.push(`cut code: ${JSON.stringify([prefix, shown])}`);
      if (held) cuts++;
      if (faults.length > 4) break;
    }
    expect(faults).toEqual([]);
    // An identity function passes everything above; this is what the hold-back is for.
    expect(cuts).toBeGreaterThan(1000);
  });

  it("returns within a fixed time however long the block is", () => {
    const blocks = {
      "100,000 characters": "![".repeat(20000) + "[a](b)".repeat(10000),
      "a block at the read limit full of openers": "**a [b `c _d ~~e ".repeat(400).slice(0, BLOCK_LIMIT),
      "a block at the read limit full of backtick runs": "` `` ```` `````".repeat(400).slice(0, BLOCK_LIMIT),
      "a block at the read limit full of brackets": "[a](".repeat(1000).slice(0, BLOCK_LIMIT),
      // Once a minute for 20 repeats, when two space quantifiers could split the same run.
      "a line of list markers and spaces": "-   ".repeat(999) + "x",
    };
    for (const [name, text] of Object.entries(blocks)) {
      const times = Array.from({ length: 21 }, () => {
        const start = performance.now();
        streamingHoldBack(text);
        return performance.now() - start;
      }).sort((a, b) => a - b);
      // The median of 21 runs, so one garbage-collection pause cannot fail it.
      expect(times[10], name).toBeLessThan(1);
    }
  });

  // One case per rule: the construct is held while unfinished and shown whole once finished.
  it.each([
    ["an inline code span", "Run `npm c", "Run ", "Run `npm ci` now"],
    ["a strong opener", "Feed the **hor", "Feed the ", "Feed the **horses** now"],
    ["a strong opener with underscores", "Feed the __hor", "Feed the ", "Feed the __horses__ now"],
    ["a strikethrough opener", "Not ~~that", "Not ", "Not ~~that~~ one"],
    ["an emphasis opener", "Feed the *hor", "Feed the ", "Feed the *horses* now"],
    ["an emphasis opener with an underscore", "Feed the _hor", "Feed the ", "Feed the _horses_ now"],
    ["a strong closer still being typed", "Feed the **horses*", "Feed the ", "Feed the **horses**"],
    ["a link's text", "See [the do", "See ", "See [the docs](https://example.test) now"],
    ["a link's destination", "See [the docs](https://exa", "See ", "See [the docs](https://example.test) now"],
    ["an image", "Logo: ![logo](https://exa", "Logo: ", "Logo: ![logo](https://example.test/logo.png)"],
    ["a reference link's label", "See [the docs][r", "See ", "See [the docs][r] now"],
    ["link text that may still gain a destination", "See [the docs]", "See ", "See [the docs] now"],
    ["a table header", "Intro\n\n| Day | Me", "Intro\n\n", "Intro\n\n| Day | Meal |\n"],
    ["a line of markers", "Title\n--", "Title\n", "Title\n-- and more"],
    ["a trailing marker run after a space", "Feed the **", "Feed the ", "Feed the ** now"],
    ["a lone pipe at the end", "Pick a |", "Pick a ", "Pick a | b"],
    // A word's inner underscore cannot close emphasis, so the opener before it stays open.
    ["an emphasis opener past a word with an underscore", "Use _the snake_case na", "Use ", "Use _the snake_case name_ now"],
    // An unclosed opener further back than the bound shows as typed; a later one is still held.
    ["a strong opener after one beyond the bound", `Pass **kwargs ${"a ".repeat(60)}then **bo`, `Pass **kwargs ${"a ".repeat(60)}then `, `Pass **kwargs ${"a ".repeat(60)}then **bold**`],
    ["a link after an open bracket beyond the bound", `Read [1 ${"a ".repeat(60)}then [the do`, `Read [1 ${"a ".repeat(60)}then `, `Read [1 ${"a ".repeat(60)}then [the docs](https://example.test)`],
    ["a single tilde at the end", "Not ~", "Not ", "Not ~5 minutes"],
  ])("holds %s while unfinished and shows it once finished", (_rule, unfinished, held, finished) => {
    expect(streamingHoldBack(unfinished)).toBe(held);
    expect(streamingHoldBack(finished)).toBe(finished);
  });

  // What assistants write that is not an unfinished construct, and every place that is code.
  it.each([
    ["a glob", "Use *.ts files"],
    ["a recursive glob", "Match **/*.js"],
    ["multiplication", "a * b and a*b*c"],
    ["a power in prose", "x = a**b"],
    ["a footnote star", "Prices are estimates.*"],
    ["a name with underscores", "Set max_retry_count"],
    ["an approximate number", "About ~5 minutes"],
    ["an index", "Read arr[0"],
    ["a URL holding markers", "See https://example.test/a_b/*c/[d"],
    ["a bullet", "* item"],
    ["an escaped backtick", "Type \\`x"],
    ["a link title holding a backtick", "See [docs](https://example.test \"Run `x\") now"],
    ["a table header longer than the bound", `| ${"Day | ".repeat(25)}`],
    ["a line of markers longer than the bound", "-".repeat(HOLD_LIMIT + 1)],
    ["a fenced code line", `${fence}py\nx = **kw`],
    ["a code line in a list item's fence", `- Code:\n\n    ${fence}\n\n  **literal`],
    ["a code line in a quoted fence", "> ~~~\n> **literal"],
    ["an indented code line", "Intro\n\n    `code"],
    ["an indented code line after bare carriage returns", "Intro\r\r    **code"],
    ["a tab-indented code line", "Intro\n\n\t**code"],
    ["an opener further back than the bound", `Feed the **${"a".repeat(HOLD_LIMIT)}`],
    ["a code span opened further back than the bound", `Run \`${"a".repeat(HOLD_LIMIT)} **b`],
    ["an opener on an earlier line", "Feed the **horses\nand"],
    ["a block longer than the read limit", `${"a ".repeat(BLOCK_LIMIT / 2)}**b`],
  ])("shows %s as typed", (_case, text) => {
    expect(streamingHoldBack(text)).toBe(text);
  });
});
