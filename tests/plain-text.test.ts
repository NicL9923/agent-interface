import { expect, it } from "vitest";
import { markdownPlain, replyTitle, snippetPlain } from "../src/shared/plain-text";

it("reads Markdown as the words a person sees", () => {
  expect(markdownPlain("## Grocery Demo\n\n| Item | Aisle |\n|---|---|\n| Milk | Dairy |\n\nSaved to [notes.md](/home/nicolas/notes.md).")).toBe("Grocery Demo Item · Aisle · Milk · Dairy Saved to notes.md.");
  expect(markdownPlain("- **Check** the gate\n- then the *fence*")).toBe("Check the gate then the fence");
  expect(markdownPlain("Done.\n\n```agent-ui\n{\"version\":1}\n```")).toBe("Done.");
  // A message of only code keeps that code rather than reading as empty.
  expect(markdownPlain("```\nls -la\n```")).toBe("ls -la");
});

it("keeps code, identifiers and literal punctuation exactly as written", () => {
  expect(markdownPlain("Call ``__init__`` and ``**kwargs``.")).toBe("Call __init__ and **kwargs.");
  expect(markdownPlain("Use `[docs](https://example.test)` and `|---|` literally.")).toBe("Use [docs](https://example.test) and |---| literally.");
  expect(markdownPlain("Use # for comments and ## for token pasting.")).toBe("Use # for comments and ## for token pasting.");
  expect(markdownPlain("Call café__init__ and foo__bar today.")).toBe("Call café__init__ and foo__bar today.");
  expect(markdownPlain("Run ls | sort, then see issue #42.")).toBe("Run ls | sort, then see issue #42.");
});

it("reads links by their words, whatever their destination holds", () => {
  expect(markdownPlain("See [docs](https://example.test/foo_(bar)) now.")).toBe("See docs now.");
  expect(markdownPlain(`[Docs](https://example.test "Reference")`)).toBe("Docs");
  // A paragraph the read limit would cut mid-link is left out rather than shown as raw Markdown.
  expect(markdownPlain(`Summary first.\n\n[Docs](https://example.test "${"x".repeat(4000)}")`)).toBe("Summary first.");
  // CRLF and whitespace-only blank lines count as paragraph breaks too.
  expect(markdownPlain(`First.\r\n\r\n[Docs](https://example.test "${"x".repeat(3000)}")`)).toBe("First.");
  expect(markdownPlain(`First.\n  \n[Docs](https://example.test "${"x".repeat(3000)}")`)).toBe("First.");
});

it("keeps code-only replies readable however the code is written", () => {
  expect(markdownPlain("    ls -la")).toBe("ls -la");
  expect(markdownPlain("> ```\n> ls -la\n> ```")).toBe("ls -la");
});

it("reads fences inside lists and HTML comments by Markdown's own rules", () => {
  expect(replyTitle("- ```js\n  code\n  ```\n\nActual summary.")).toBe("Actual summary.");
  expect(markdownPlain("<!--\n```\n-->\nActual summary.")).toBe("Actual summary.");
});

it("keeps search markers through flattening, and escaped line breaks become spaces", () => {
  // A snippet's own private-use characters never become markers.
  expect(snippetPlain("\uE000literal\uE001 and >>>real<<<")).toBe("literal and >>>real<<<");
  expect(snippetPlain(`First.\n\n[Docs](https://example.test "${"x".repeat(3000)}")`)).toBe("First.");
  expect(snippetPlain("## >>>Grocery<<< Demo\\n* Free >>>Grocery<<< Coupons")).toBe(">>>Grocery<<< Demo Free >>>Grocery<<< Coupons");
  // A match at the start of a line is never read as a quote.
  expect(snippetPlain(">>>Gate<<< battery\n>>>gate<<< code")).toBe(">>>Gate<<< battery >>>gate<<< code");
});

it("reads adversarial text in one pass", () => {
  const started = performance.now();
  for (const text of ["-".repeat(50_000) + " status", "|".repeat(50_000), "*_".repeat(25_000), "#".repeat(50_000), "`".repeat(50_000), "[".repeat(50_000), "](".repeat(25_000), " ".repeat(50_000) + "x"]) {
    markdownPlain(text); replyTitle(text);
  }
  snippetPlain("\\".repeat(50_000) + "!");
  expect(performance.now() - started).toBeLessThan(2000);
});

it("skips a horizontal rule when titling a reply", () => {
  expect(replyTitle("---\nActual summary.")).toBe("Actual summary.");
});

it('makes readable saved titles without changing identifiers inside them',()=>{
  expect(replyTitle('## **Gate**')).toBe('Gate');
  expect(replyTitle('`binary_sensor.north_gate`')).toBe('binary_sensor.north_gate');
  expect(replyTitle('```\nls\n```')).toBe('Saved reply');expect(replyTitle('a'.repeat(200))).toHaveLength(80);
});

it('makes saved reply titles from the first line without markdown or broken words',()=>{
  expect(replyTitle('\n - **Check** `binary_sensor.north_gate`.\n- A second item')).toBe('Check binary_sensor.north_gate.');
  expect(replyTitle('1. `freezer_door` is ready\nNext steps')).toBe('freezer_door is ready');
  const title = replyTitle('A useful gate maintenance plan '.repeat(8));
  expect(title.length).toBeLessThanOrEqual(80);expect(title).toMatch(/(?:plan|gate|maintenance|useful|A)…$/);
});

it('titles a saved reply by the words a person reads first, never a code fence or a table divider',()=>{
  expect(replyTitle('```agent-ui\n{"version":1}\n```\nGrocery run is ready.')).toBe('Grocery run is ready.');
  expect(replyTitle('| Item | Aisle |\n|---|---|\n| Milk | Dairy |')).toBe('Item · Aisle');
  expect(replyTitle('Call `__init__` first')).toBe('Call __init__ first');
  // A long line of dashes is read once.
  const started=performance.now();replyTitle('-'.repeat(5_000)+' status');
  expect(performance.now()-started).toBeLessThan(200);
});

