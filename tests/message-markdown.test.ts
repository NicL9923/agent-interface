// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CHECKED_REPLY,
  MessageMarkdown,
  ReplyMarkdown,
  StreamingMarkdown,
  blocksAgree,
  bubbleRuns,
  fadeSides,
  parseBlock,
  sameBlock,
  streamingBlocks,
} from "../src/components/MessageMarkdown";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { HOLD_LIMIT, streamingHoldBack } from "../src/components/streaming-hold-back";
import { mountRoot, stubMatchMedia } from "./ui-harness";

type MdastNode = {
  type: string;
  children?: MdastNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

let container: HTMLDivElement;
let root: Root;
const writeText = vi.fn<(value: string) => Promise<void>>();

beforeEach(() => {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  writeText.mockReset().mockResolvedValue(undefined);
  ({ container, root } = mountRoot());
});

async function render(text: string, inlineUi = false) {
  await act(async () => root.render(createElement(MessageMarkdown, { text, inlineUi })));
}

async function copy() {
  const button = container.querySelector("button");
  expect(button?.textContent).toBe("Copy code");
  await act(async () => button!.click());
}

describe("assistant Markdown", () => {
  it("opens web links but shows a file path on the Hermes computer as plain text", async () => {
    await render(
      "Saved to [notes.md](/home/nicolas/.hermes/profiles/testbot/notes.md). See [docs](https://example.test) or [the file](/api/files/abc).",
    );
    const links = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(links).toEqual(["https://example.test", "/api/files/abc"]);
    expect(container.querySelector(".markdown-local-file")?.textContent).toBe("notes.md");
  });

  it("keeps links to this app's own destinations and protocol-relative web addresses", async () => {
    await render(
      "[Today](/?view=today), [Chat](/?bot=ranch), [docs](//example.test/docs) and [notes](~/notes.md).",
    );
    expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "/?view=today",
      "/?bot=ranch",
      "//example.test/docs",
    ]);
    expect(container.querySelector(".markdown-local-file")?.textContent).toBe("notes");
  });

  it("renders only closed explicit UI fences when the caller enables assistant UI", async () => {
    stubMatchMedia();
    const payload = JSON.stringify({
      version: 1,
      title: "Supply planner",
      html: "<button>Compare</button>",
    });
    const fence = "```wildbots-html\n" + payload + "\n```";
    await render(fence);
    expect(container.querySelector("iframe")).toBeNull();
    await render("```wildbots-html\n" + payload, true);
    expect(container.querySelector("iframe")).toBeNull();
    await render("````text\n" + fence + "\n````", true);
    expect(container.querySelector("iframe")).toBeNull();
    await render(fence, true);
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("title")).toBe("Supply planner");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.src).toContain("/inline-ui");
    const message = (data: unknown, source: MessageEventSource | null) =>
      act(async () => window.dispatchEvent(new MessageEvent("message", { data, source })));
    await message({ type: "wildbots-size", height: 900 }, window);
    expect(frame.style.height).toBe("240px");
    await message({ type: "wildbots-size", height: 99999 }, frame.contentWindow);
    expect(frame.style.height).toBe("1600px");
    await message({ type: "wildbots-size", height: NaN }, frame.contentWindow);
    expect(frame.style.height).toBe("1600px");
    await message({ type: "wildbots-size", height: 1 }, frame.contentWindow);
    expect(frame.style.height).toBe("80px");
    await message({ type: "wildbots-loaded" }, frame.contentWindow);
    expect(container.textContent).not.toContain("Loading interactive view");
    await render(fence + "\n\nMore explanation.", true);
    expect(container.querySelector("iframe")).toBe(frame);
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("iframe")).not.toBe(frame);
    await render("```wildbots-html\n{}\n```", true);
    expect(container.querySelector("iframe")).toBeNull();
  });
  it("renders semantic headings, emphasis, lists, links, and GFM tables", async () => {
    await render(
      "## Plan\n\nUse **care** and *patience*.\n\n1. Read the `config`.\n2. Follow [the docs](https://example.test/docs).\n\n| Step | State |\n| --- | --- |\n| Review | Done |",
    );
    expect(container.querySelector("h2")?.textContent).toBe("Plan");
    expect(container.querySelector("strong")?.textContent).toBe("care");
    expect(container.querySelector("em")?.textContent).toBe("patience");
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelector("code")?.textContent).toBe("config");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Copy as Markdown",
      "Copy as CSV",
    ]);
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://example.test/docs");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.querySelector("table tbody td")?.textContent).toBe("Review");
    const tableRegion = container.querySelector('[role="region"]')!;
    expect(tableRegion.getAttribute("aria-label")).toBe("Table");
    expect(tableRegion.getAttribute("tabindex")).toBe("0");
  });

  it("ignores raw HTML and leaves unsafe links as plain text", async () => {
    await render(
      'Visible **answer**.\n\n<script>alert("unsafe")</script>\n\n<img src="x" onerror="alert(1)">\n\n[script](javascript:alert%281%29) [data](data:text/html,unsafe) [vb](vbscript:unsafe) [encoded](javascript&#58;unsafe)\n\n[safe](https://example.test) [file](/api/files/safe) [mail](mailto:hello@example.test)',
    );
    expect(container.querySelector("script, img, iframe")).toBeNull();
    expect(container.textContent).toContain("Visible answer.");
    expect(container.textContent).toContain("script data vb encoded");
    expect(Array.from(container.querySelectorAll("a"), (a) => a.getAttribute("href"))).toEqual([
      "https://example.test",
      "/api/files/safe",
      "mailto:hello@example.test",
    ]);
  });

  it("keeps code literal and copies exactly its whitespace and characters", async () => {
    const code = 'const html = "<img src=x onerror=alert(1)>";\n  spaces & < > ✓\n\n';
    await render(`\`\`\`typescript\n${code}\`\`\``);
    expect(container.querySelector("pre code")?.textContent).toBe(code);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("pre")?.getAttribute("aria-label")).toBe(
      "typescript code block",
    );
    await copy();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(code);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Code copied.");
  });

  it("requires a click to open Markdown images and blocks unsafe image URLs", async () => {
    await render(
      "![Reference](https://other.example/collect?private=conversation) ![Unsafe](javascript:alert%281%29) ![Embedded](data:image/svg+xml,unsafe)",
    );
    expect(container.querySelector("img, picture, source")).toBeNull();
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe("Open image: Reference");
    expect(links[0].getAttribute("href")).toBe(
      "https://other.example/collect?private=conversation",
    );
    expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.textContent).toContain("Unsafe");
    expect(container.textContent).toContain("Embedded");
  });

  it("copies an unlabelled block and resets feedback when its content changes", async () => {
    await render("```\nfirst\n```");
    await copy();
    expect(writeText).toHaveBeenLastCalledWith("first\n");
    await render("```\nsecond\n```");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
    await copy();
    expect(writeText).toHaveBeenLastCalledWith("second\n");
  });

  it("reports a denied clipboard operation and allows retry", async () => {
    writeText.mockRejectedValueOnce(new Error("Clipboard permission denied"));
    await render("```sh\necho hello\n```");
    await copy();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Couldn't copy. Select the code and copy it manually.",
    );
    expect(container.querySelector("button")?.disabled).toBe(false);
    await copy();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Code copied.");
  });

  it("explains copying when the browser has no clipboard API", async () => {
    vi.stubGlobal("navigator", {});
    await render("```\nhello\n```");
    await copy();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("copy it manually");
  });

  it("prevents a second copy while the clipboard operation is pending", async () => {
    let finish!: () => void;
    writeText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render("```\nhello\n```");
    await copy();
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Copying…");
    await act(async () => button.click());
    expect(writeText).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(button.disabled).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Code copied.");
  });
});

describe("code highlighting and tables", () => {
  const settle = () =>
    act(async () => {
      await vi.dynamicImportSettled();
    });
  it("colors a finished fence once its grammar loads, keeping the code text and Copy code", async () => {
    await render("```ts\nconst gate: number = 1; // north\n```");
    await settle();
    const code = container.querySelector("pre code")!;
    expect(code.textContent).toBe("const gate: number = 1; // north\n");
    expect(code.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(code.querySelector(".hljs-comment")?.textContent).toBe("// north");
    await copy();
    expect(writeText).toHaveBeenCalledWith("const gate: number = 1; // north\n");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Code copied.");
  });

  it("escapes markup in highlighted code", async () => {
    await render("```html\n<img src=x onerror=alert(1)>\n```");
    await settle();
    expect(container.querySelector("pre code img")).toBeNull();
    expect(container.querySelector("pre code")?.textContent).toBe("<img src=x onerror=alert(1)>\n");
  });

  it("leaves a fence still streaming in, and unknown languages, plain", async () => {
    await act(async () =>
      root.render(createElement(StreamingMarkdown, { text: "Here:\n\n```python\nprint('hay')" })),
    );
    await settle();
    expect(container.querySelector("pre code")?.textContent).toBe("print('hay')\n");
    expect(container.querySelector("pre code [class^=hljs-]")).toBeNull();
    await render("```brainfuck\n+++.\n```");
    await settle();
    expect(container.querySelector("pre code")?.innerHTML).toBe("+++.\n");
  });

  it("copies a table as Markdown or CSV and says so", async () => {
    await render("| Gate | Battery |\n| --- | --- |\n| Barn, west | 48% |");
    const button = (text: string) =>
      [...container.querySelectorAll("button")].find((item) => item.textContent === text)!;
    await act(async () => button("Copy as CSV").click());
    expect(writeText).toHaveBeenLastCalledWith('Gate,Battery\r\n"Barn, west",48%');
    expect(container.querySelector(".markdown-table [role=status]")?.textContent).toBe(
      "Table copied as CSV.",
    );
    await act(async () => button("Copy as Markdown").click());
    expect(writeText).toHaveBeenLastCalledWith(
      "| Gate | Battery |\n| --- | --- |\n| Barn, west | 48% |",
    );
    writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => button("Copy as CSV").click());
    expect(container.querySelector(".markdown-table [role=status]")?.textContent).toContain(
      "copy it manually",
    );
  });
});

describe("streaming Markdown", () => {
  const renderAs = async (component: typeof MessageMarkdown, text: string) => {
    await act(async () => root.render(createElement(component, { text })));
    // Newlines between blocks are insignificant in the transcript's normal white-space.
    return container.innerHTML.replace(/>\n</g, "><");
  };

  it("splits only at blank lines that start a new block outside code fences", () => {
    expect(
      streamingBlocks("# Plan\n\nFirst part.\n\n```sh\necho one\n\necho two\n```\n\nDone"),
    ).toEqual(["# Plan", "First part.", "```sh\necho one\n\necho two\n```", "Done"]);
    // An indented line continues the list item above it, so it stays with it.
    expect(streamingBlocks("1. Feed\n\n   the horses\n\nNext")).toEqual([
      "1. Feed\n\n   the horses",
      "Next",
    ]);
    expect(streamingBlocks("Still typing\n\n")).toEqual(["Still typing\n\n"]);
    expect(streamingBlocks("Open fence\n\n```\ncode\n\nmore")).toEqual([
      "Open fence",
      "```\ncode\n\nmore",
    ]);
  });

  it("parses the whole reply when a rule spans it", () => {
    expect(streamingBlocks("Cards\n\n```agent-ui\n{}\n```")).toBeNull();
  });

  // Outside a fence each line ties blocks together; inside one it is code and the blocks hold.
  it.each([
    ["a reference-link definition", "[1]: https://example.test"],
    ["a footnote definition", "[^1]: Footnote"],
    ["a footnote definition in a quote", "> [^1]: Footnote"],
    ["an HTML comment", "<!--\n\nhidden\n-->"],
    ["a raw script block", "<script>\n\nlet x = 1;\n</script>"],
  ])("keeps blocks for %s inside a fence and parses whole outside one", (_rule, line) => {
    expect(streamingBlocks(`See [docs][1].\n\n${line}`)).toBeNull();
    const code = "```\n" + line + "\n```";
    expect(streamingBlocks(`Sample:\n\n${code}\n\nDone`)).toEqual(["Sample:", code, "Done"]);
    // A fence still open at the end holds the rest of the reply.
    expect(streamingBlocks(`Sample:\n\n~~~\n${line}`)).toEqual(["Sample:", `~~~\n${line}`]);
  });

  it("keeps blocks for a footnote-shaped regex with no definition, and treats an inline ``` line as prose", () => {
    expect(streamingBlocks("Match `/[^a-z]/` once.\n\nThen [^b] again.")).toEqual([
      "Match `/[^a-z]/` once.",
      "Then [^b] again.",
    ]);
    expect(streamingBlocks("```js``` is inline.\n\n[1]: https://example.test")).toBeNull();
  });

  it("renders a growing reply the same as the saved reply", async () => {
    for (const text of [
      "## Supper\n\nBeans, **cornbread** and greens.\n\n> Soak the beans tonight.\n\n```txt\nsoak\n\nsimmer\n```\n\n| Day | Meal |\n| --- | --- |\n| Sat | Chili |",
      // Loose lists continue across blank lines, so their numbering and spacing hold.
      "Steps:\n\n1. Soak\n\n1. Rinse\n\n1. Simmer\n\nEnjoy.",
      "- Beans\n\n- Cornbread\n\n* Greens",
      "- [ ] Feed the horses\n\n- [x] Check the gate\n\nThat is all.",
      // Code that looks like a definition, comment or footnote keeps its blocks and renders the same.
      "Strip it with `/[^a-z]/g`[^1].\n\n```html\n<!-- note -->\n\n<script>\n[1]: https://example.test\n[^1]: Footnote\n```\n\nDone.",
    ])
      expect(await renderAs(StreamingMarkdown, text)).toBe(await renderAs(MessageMarkdown, text));
  });

  it("holds a half-written strong marker back until it closes, while the saved reply shows it as typed", async () => {
    await renderAs(StreamingMarkdown, "Feed the **bo");
    expect(container.textContent).toBe("Feed the");
    await renderAs(StreamingMarkdown, "Feed the **bold**");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    await renderAs(MessageMarkdown, "Feed the **bo");
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toBe("Feed the **bo");
  });

  /** What the live view shows: the reply less what the hold-back keeps from its last block. */
  const shownPrefix = (text: string) => {
    const last = streamingBlocks(text)?.at(-1) ?? text;
    return text.slice(0, text.length - last.length + streamingHoldBack(last).length);
  };
  // React Markdown took about 80 seconds to render this live and saved in jsdom, so only its prefix is checked.
  const slowToRender = "*a ".repeat(16000) + "b_ ".repeat(16000);
  // Inputs from both review rounds where the old repair invented content. The live view must now be
  // exactly what the reply's own prefix renders.
  it.each([
    "![".repeat(20000) + "[a](b)".repeat(10000),
    "- Code:\n\n    ```\n\n  **literal",
    "[---](https://x.test",
    "[# Heading](https://x.test",
    "[r]: https://x.test\n\nRun `[r]",
    "Intro\r\r    **code",
    "Compute 2 **3",
    "Pass **kwargs",
    "Exclude **test.ts",
    "[a ".repeat(8000),
    "See [docs][r].\n\n[r]: https://example.test/_private",
    "https://example.test/a_[b",
    "- ```\n  **literal",
    "> ~~~\n> **literal",
    "| this is a paragraph",
    "    | literal code",
    "Use *.ts files",
    slowToRender,
    // The same shape, short enough for the hold-back to read and for React Markdown to render.
    "*a ".repeat(200) + "b_ ".repeat(200),
  ])("renders a reviewed input live as its own prefix: %#", async (text) => {
    const shown = shownPrefix(text);
    expect(text.startsWith(shown)).toBe(true);
    expect(text.length - shown.length).toBeLessThanOrEqual(HOLD_LIMIT);
    if (text !== slowToRender)
      expect(await renderAs(StreamingMarkdown, text)).toBe(await renderAs(MessageMarkdown, shown));
  });

  it("clears copy feedback when a growing code block changes, even mid-copy", async () => {
    const status = () => container.querySelector('[role="status"]')?.textContent;
    await renderAs(StreamingMarkdown, "```ts\nconst x = 1;");
    await copy();
    expect(writeText).toHaveBeenLastCalledWith("const x = 1;\n");
    expect(status()).toBe("Code copied.");
    await renderAs(StreamingMarkdown, "```ts\nconst x = 123;");
    expect(status()).toBe("");
    // A copy still pending when the code changes copied the older text, so it must not claim
    // success, nor end a newer copy's wait.
    const finish: Array<() => void> = [];
    writeText.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish.push(resolve);
        }),
    );
    await copy();
    await renderAs(StreamingMarkdown, "```ts\nconst x = 1234;");
    expect(status()).toBe("");
    await copy();
    expect(writeText).toHaveBeenLastCalledWith("const x = 1234;\n");
    await act(async () => finish[0]());
    expect(container.querySelector("button")?.textContent).toBe("Copying…");
    await act(async () => finish[1]());
    expect(status()).toBe("Code copied.");
  });

  it("keeps an unfinished code block's node across updates", async () => {
    await renderAs(StreamingMarkdown, "Here:\n\n```python\nprint('hay')");
    const code = container.querySelector("pre code")!;
    await renderAs(StreamingMarkdown, "Here:\n\n```python\nprint('hay')\nprint('oats')");
    expect(container.querySelector("pre code")).toBe(code);
    expect(code.textContent).toBe("print('hay')\nprint('oats')\n");
  });

  // Each case is a fence or definition the per-line splitter cannot follow, so it must parse whole.
  it.each([
    [
      "a fence opened behind a list marker hides a later footnote",
      "Note[^a]\n\nHere:\n\n- ```\n  code\n  ```\n\n[^a]: footnote",
    ],
    [
      "a list item's fence closes on a line that the tracker reads as an opener",
      "See [docs][a].\n\nSteps:\n\n- ```\n  code\n  ```\n  [a]: https://example.test\n  ```",
    ],
    [
      "a list item's fence ends at a line left of it",
      "See [docs][a].\n\nSteps:\n\n- Run:\n\n  ```\n[a]: https://example.test\n  ```",
    ],
    [
      "an HTML block holds a fence-shaped line",
      "See [docs][a].\n\n<div>\n```\n</div>\n\n[a]: https://example.test",
    ],
    ["a definition label spans two lines", "See [docs][a b].\n\n[a\nb]: https://example.test"],
    [
      "a definition label holds an escaped bracket",
      "See [docs][a\\]b].\n\n[a\\]b]: https://example.test",
    ],
    [
      "a list item's fence sits four spaces in and the item ends at a quote",
      "- Code:\n\n    ```\n    x\n\n> Next",
    ],
  ])("renders the same as the saved reply when %s", async (_case, text) => {
    expect(await renderAs(StreamingMarkdown, text)).toBe(await renderAs(MessageMarkdown, text));
    expect(streamingBlocks(text)).toBeNull();
  });

  // Seeded replies built from lines the splitter must follow: fences in and out of containers,
  // definitions, multi-line labels, HTML blocks and tables. Live and saved must render alike.
  it("renders seeded random replies the same live and saved", async () => {
    const lines = [
      "See [docs][a].",
      "Note[^a] here.",
      "[a]: https://example.test",
      "[^a]: foot",
      "[a",
      "b]: https://example.test/b",
      "- ```",
      "  ```",
      "```",
      "~~~",
      "   ```",
      "    ```",
      "\t```",
      "> ```",
      "  code",
      "code",
      "    indented",
      "> text",
      ">",
      "- item",
      "1. item",
      "  - nested",
      "- [ ] task",
      "<div>",
      "</div>",
      "<!--",
      "-->",
      "| a | b |",
      "| - | - |",
      "Text **bold**",
      "Title",
      "===",
      "* * *",
      "",
      "",
    ];
    let seed = 7;
    const pick = (count: number) =>
      ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8) % count;
    const diverged: string[] = [];
    for (let run = 0; run < 1500 && diverged.length < 3; run++) {
      const body = Array.from(
        { length: 3 + pick(12) },
        () => lines[pick(lines.length)] + (pick(3) ? "\n" : "\n\n"),
      ).join("");
      const text = `See [docs][a] and [x][a b], note[^a].\n\nIntro.\n\n${body}`;
      const live = await renderAs(StreamingMarkdown, text);
      if (live === (await renderAs(MessageMarkdown, text))) continue;
      // The one difference allowed: the hold-back held the reply's last line as a table header waiting for its
      // delimiter row. That line starts with a pipe, ends the reply, sits under a line with no pipe, and the
      // saved reply reads it as paragraph text, not code or a table.
      const last = streamingBlocks(text)?.at(-1) ?? text;
      const held = last.slice(streamingHoldBack(last).length);
      const before = text.slice(0, text.length - held.length);
      const above = before.slice(before.lastIndexOf("\n", before.length - 2) + 1);
      // The kinds of node from the document down to the held line's first character.
      const path: string[] = [];
      for (
        let node: MdastNode | undefined = fromMarkdown(text, {
          extensions: [gfm()],
          mdastExtensions: [gfmFromMarkdown()],
        });
        node;
        node = node.children?.find(
          ({ position }) =>
            (position?.start.offset ?? Infinity) <= before.length &&
            (position?.end.offset ?? -1) > before.length,
        )
      )
        path.push(node.type);
      const header =
        before.endsWith("\n") &&
        /^\|[^\n]*\n$/.test(held) &&
        !above.includes("|") &&
        path.includes("paragraph") &&
        !path.some((type) => /^(code|table)/.test(type));
      if (!header || live !== (await renderAs(MessageMarkdown, before))) diverged.push(text);
    }
    expect(diverged).toEqual([]);
  }, 60_000);

  // Three code-heavy replies of the kind assistants write. No prefix ending at a line break may fall
  // back to a whole parse; a later broadening of the fallbacks that costs ordinary replies their
  // blocks fails here.
  it.each([
    [
      "a tutorial with fenced code between paragraphs",
      [
        "## Set up the worker",
        "",
        "Install the queue client first:",
        "",
        "```bash",
        "npm install bullmq ioredis",
        "```",
        "",
        "Then create `worker.ts`:",
        "",
        "```ts",
        'import { Worker } from "bullmq";',
        "",
        "// One connection per process.",
        'const connection = { host: "localhost", port: 6379 };',
        "",
        'export const worker = new Worker("email", async job => {',
        "  const { to, subject } = job.data;",
        "",
        "  await send(to, subject);",
        "}, { connection });",
        "```",
        "",
        "A few notes:",
        "",
        "- `concurrency` defaults to **1**.",
        "- Failed jobs retry with `attempts` and `backoff`.",
        "",
        "| Option | Default |",
        "| --- | --- |",
        "| `attempts` | 1 |",
        "| `backoff` | none |",
        "",
        "That is the whole worker.",
      ],
    ],
    [
      "numbered steps with code in each item",
      [
        "Here is how to rotate the key:",
        "",
        "1. Create the new key:",
        "",
        "   ```sh",
        "   az keyvault key create --name app-key",
        "",
        "   az keyvault key show --name app-key",
        "   ```",
        "",
        "2. Update the app setting:",
        "",
        "   ```json",
        "   {",
        '     "KeyName": "app-key"',
        "   }",
        "   ```",
        "",
        "   - Restart the app after saving.",
        "   - Watch the logs for `KeyNotFound`.",
        "",
        "3. Delete the old key once traffic is clean.",
        "",
        "> **Note:** keep the old key for 24 hours in case you roll back.",
        "",
        "Done.",
      ],
    ],
    [
      "a fix with a diff, Python and a Markdown sample",
      [
        "The error comes from the decorator:",
        "",
        "> TypeError: wrapper() got an unexpected keyword argument 'retry'",
        "",
        "Pass the keyword arguments through:",
        "",
        "```diff",
        "-def wrapper(*args):",
        "-    return fn(*args)",
        "+def wrapper(*args, **kwargs):",
        "+    return fn(*args, **kwargs)",
        "```",
        "",
        "The full decorator:",
        "",
        "```python",
        "def logged(fn):",
        "    @wraps(fn)",
        "    def wrapper(*args, **kwargs):",
        '        log.info("calling %s", fn.__name__)',
        "",
        "        return fn(*args, **kwargs)",
        "",
        "    return wrapper",
        "```",
        "",
        "If the docs use reference links, keep the definitions at the bottom:",
        "",
        "```md",
        "See [the guide][g].",
        "",
        "[g]: https://example.test/guide",
        "<!-- end -->",
        "```",
        "",
        "That should clear it.",
      ],
    ],
  ])("keeps blocks at every line of %s", (_reply, lines) => {
    const prefixes = lines.map((_line, index) => lines.slice(0, index + 1).join("\n"));
    expect(prefixes.filter((prefix) => streamingBlocks(prefix) === null)).toEqual([]);
  });

  it("keeps blocks for a fence in a list item whose lines stay indented", () => {
    const item = "1. Install:\n\n   ```sh\n   npm i\n\n   npm test\n   ```";
    expect(streamingBlocks(`${item}\n\nDone`)).toEqual([item, "Done"]);
    // With no list above it, a fence indented four spaces is indented code and splits as usual.
    expect(streamingBlocks("Example:\n\n    ```\n    code\n\nDone")).toEqual([
      "Example:\n\n    ```\n    code",
      "Done",
    ]);
  });
});

describe("a streamed reply once saved", () => {
  const renderAs = async (element: ReturnType<typeof createElement>) => {
    await act(async () => root.render(element));
    // Newlines between blocks are insignificant in the transcript's normal white-space.
    return container.innerHTML.replace(/>\n</g, "><");
  };
  /** The reply streamed in its row, then saved: what the row shows. The hold-back plays no part in a saved reply. */
  const streamedThenSaved = async (text: string) => {
    await act(async () => root.render(createElement("div")));
    await renderAs(createElement(ReplyMarkdown, { text, live: true }));
    return renderAs(createElement(ReplyMarkdown, { text, live: false }));
  };
  const openedFresh = async (text: string) => {
    await act(async () => root.render(createElement("div")));
    return renderAs(createElement(MessageMarkdown, { text }));
  };

  // CommonMark: a line of only spaces and tabs is blank, a no-break space is not, and a lone \r
  // ends a line as \r\n does.
  it.each([
    [
      "a line holding only a no-break space, which is not blank",
      "First\n\u00a0\nSecond",
      ["First\n\u00a0\nSecond"],
    ],
    ["a line of spaces and a tab, which is blank", "First\n \t\nSecond", ["First", "Second"]],
    ["bare carriage returns", "First\r\rSecond", ["First", "Second"]],
    ["carriage return and line feed pairs", "First\r\n\r\nSecond", ["First", "Second"]],
    [
      "a definition after bare carriage returns",
      "See [docs][a].\n\nMore.\r\r[a]: https://example.test",
      null,
    ],
    [
      "a fence closed by a line that ends in a no-break space",
      "```\ncode\n```\u00a0\n\nAfter",
      ["```\ncode\n```\u00a0\n\nAfter"],
    ],
  ])("splits as CommonMark reads %s", (_case, text, blocks) => {
    expect(streamingBlocks(text)).toEqual(blocks);
  });

  // Every input the reviewers of this file have reported, and the two this round found.
  const reported = [
    "See [docs][a].\n\nMore.\r\r[a]: https://example.test",
    "First\n\u00a0\nSecond",
    "## Supper\n\nBeans, **cornbread** and greens.\n\n> Soak the beans tonight.\n\n```txt\nsoak\n\nsimmer\n```\n\n| Day | Meal |\n| --- | --- |\n| Sat | Chili |",
    "Steps:\n\n1. Soak\n\n1. Rinse\n\n1. Simmer\n\nEnjoy.",
    "- Beans\n\n- Cornbread\n\n* Greens",
    "- [ ] Feed the horses\n\n- [x] Check the gate\n\nThat is all.",
    "Strip it with `/[^a-z]/g`[^1].\n\n```html\n<!-- note -->\n\n<script>\n[1]: https://example.test\n[^1]: Footnote\n```\n\nDone.",
    "- Code:\n\n    ```\n\n  **literal",
    "[---](https://x.test",
    "[# Heading](https://x.test",
    "[r]: https://x.test\n\nRun `[r]",
    "Intro\r\r    **code",
    "Compute 2 **3",
    "Pass **kwargs",
    "Exclude **test.ts",
    "See [docs][r].\n\n[r]: https://example.test/_private",
    "https://example.test/a_[b",
    "- ```\n  **literal",
    "> ~~~\n> **literal",
    "| this is a paragraph",
    "    | literal code",
    "Use *.ts files",
    "*a ".repeat(200) + "b_ ".repeat(200),
    "Note[^a]\n\nHere:\n\n- ```\n  code\n  ```\n\n[^a]: footnote",
    "See [docs][a].\n\nSteps:\n\n- ```\n  code\n  ```\n  [a]: https://example.test\n  ```",
    "See [docs][a].\n\nSteps:\n\n- Run:\n\n  ```\n[a]: https://example.test\n  ```",
    "See [docs][a].\n\n<div>\n```\n</div>\n\n[a]: https://example.test",
    "See [docs][a b].\n\n[a\nb]: https://example.test",
    "See [docs][a\\]b].\n\n[a\\]b]: https://example.test",
    "- Code:\n\n    ```\n    x\n\n> Next",
    "1. Install:\n\n   ```sh\n   npm i\n\n   npm test\n   ```\n\nDone",
    "Example:\n\n    ```\n    code\n\nDone",
    "Match `/[^a-z]/` once.\n\nThen [^b] again.",
    "```js``` is inline.\n\n[1]: https://example.test",
    "Cards\n\n```agent-ui\n{}\n```",
    ...[
      "[1]: https://example.test",
      "[^1]: Footnote",
      "> [^1]: Footnote",
      "<!--\n\nhidden\n-->",
      "<script>\n\nlet x = 1;\n</script>",
    ].flatMap((line) => [
      `See [docs][1].\n\n${line}`,
      `Sample:\n\n\`\`\`\n${line}\n\`\`\`\n\nDone`,
      `Sample:\n\n~~~\n${line}`,
    ]),
  ];
  it.each(reported)("shows a reported input as it shows opened fresh: %#", async (text) => {
    expect(await streamedThenSaved(text)).toBe(await openedFresh(text));
  });

  it("shows a table header whose delimiter row never came once the reply is saved", async () => {
    const text = "The schedule:\n\n| Day | Meal |\n";
    // While it streams, the header waits for a delimiter row.
    expect(await renderAs(createElement(StreamingMarkdown, { text }))).not.toContain("Day");
    expect(await streamedThenSaved(text)).toContain("| Day | Meal |");
  });

  it("shows the two inputs this round found in blocks as the whole parse does", async () => {
    for (const text of reported.slice(0, 2))
      expect(await renderAs(createElement(StreamingMarkdown, { text, holdBack: false }))).toBe(
        await openedFresh(text),
      );
  });

  // Seeded replies from lines that test blank lines, line endings, containers, fences and definitions.
  it("shows seeded random replies streamed and saved as they show opened fresh", async () => {
    const lines = [
      "See [docs][a].",
      "Note[^a] here.",
      "[a]: https://example.test",
      "[^a]: foot",
      "- ```",
      "  ```",
      "```",
      "~~~",
      "    ```",
      "> ```",
      "  code",
      "code",
      "    indented",
      "> text",
      "- item",
      "1. item",
      "  - nested",
      "<div>",
      "</div>",
      "| a | b |",
      "| - | - |",
      "Text **bold**",
      "Title",
      "===",
      "\u00a0",
      " \t",
      "\t",
      "",
      "",
    ];
    const endings = ["\n", "\r", "\r\n", "\n\n", "\r\r"];
    let seed = 23;
    const pick = (count: number) =>
      ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8) % count;
    const diverged: string[] = [];
    for (let run = 0; run < 400 && diverged.length < 3; run++) {
      const text = Array.from(
        { length: 3 + pick(12) },
        () => lines[pick(lines.length)] + endings[pick(endings.length)],
      ).join("");
      if ((await streamedThenSaved(text)) !== (await openedFresh(text))) diverged.push(text);
    }
    expect(diverged).toEqual([]);
  }, 60_000);

  // The check parses the reply twice, which costs more than a person should wait at the save past
  // MAX_CHECKED_REPLY characters, so a longer reply parses whole, as a rebuilt row does.
  it.each([
    ["at the longest checked length keeps its nodes", MAX_CHECKED_REPLY, true],
    ["one character longer parses whole", MAX_CHECKED_REPLY + 1, false],
  ])(
    "a saved reply %s, and shows as it does opened fresh",
    async (_case, length, kept) => {
      const paragraph = "The north gate is **latched** and the east gate is open.\n\n";
      const body = paragraph.repeat(Math.floor((length - 20) / paragraph.length));
      // Padded to exactly `length` characters.
      const text = body + "Done".padEnd(length - body.length, ".");
      await act(async () => root.render(createElement("div")));
      await renderAs(createElement(ReplyMarkdown, { text, live: true }));
      const first = container.querySelector("p");
      const saved = await renderAs(createElement(ReplyMarkdown, { text, live: false }));
      expect(container.querySelector("p") === first).toBe(kept);
      expect(saved).toBe(await openedFresh(text));
    },
    30_000,
  );

  it("finds where blocks and the whole parse disagree, so a saved reply parses whole there", () => {
    expect(blocksAgree("First\n\u00a0\nSecond", ["First", "Second"])).toBe(false);
    expect(
      blocksAgree("See [docs][a].\n\nMore.\r\r[a]: https://example.test", [
        "See [docs][a].",
        "More.\r\r[a]: https://example.test",
      ]),
    ).toBe(false);
    expect(blocksAgree("First\n\nSecond", ["First", "Second"])).toBe(true);
    expect(
      blocksAgree("```\ncode\n\nmore\n```\n\nAfter", ["```\ncode\n\nmore\n```", "After"]),
    ).toBe(true);
  });
});

describe("reply bubbles", () => {
  /** Each run of a reply as its blocks group: "bubble:" and the prose tags it holds, or the lone block's tag. */
  const layout = (blocks: string[]) =>
    bubbleRuns(blocks.flatMap((text) => parseBlock({ text })))
      .filter((run) => run.pieces.some((piece) => piece.kind !== "space"))
      .map((run) =>
        run.bubble
          ? `bubble:${run.pieces.flatMap((piece) => piece.tag ?? []).join(",")}`
          : run.pieces[0].tag,
      );

  it("puts a reply of only prose in one bubble", () => {
    expect(layout(["Hi.\n\n- Oats\n- Hay\n\n> Feed at dusk.\n\n## Then\n\n1. Water"])).toEqual([
      "bubble:p,ul,blockquote,h2,ol",
    ]);
  });
  it("keeps a table in the middle at full width, between two bubbles", () => {
    expect(
      layout(["Here:\n\n| Gate | Battery |\n| --- | --- |\n| North | 14% |\n\nDone."]),
    ).toEqual(["bubble:p", "table", "bubble:p"]);
  });
  it("starts with a code block when the reply does, and opens a bubble after it", () => {
    expect(layout(["```js\nlet x = 1;\n```\n\nThat sets it."])).toEqual(["pre", "bubble:p"]);
  });
  it("keeps media and a thematic break out of bubbles", () => {
    expect(
      layout(["Look:\n\n![Barn](https://example.test/barn.png)\n\n---\n\nThat is the barn."]),
    ).toEqual(["bubble:p", "p", "hr", "bubble:p"]);
  });
  // A list or quote that holds code, a table, media or a rule reads as one full-width block, as in Classic.
  it("keeps a list or quote that holds a full-width block out of bubbles, with prose around it in them", () => {
    expect(
      layout([
        "First:\n\n1. Open the gate\n2. Run this:\n\n   ```sh\n   gate open\n   ```\n\nThen wait.",
      ]),
    ).toEqual(["bubble:p", "ol", "bubble:p"]);
    expect(layout(["> | Gate | Battery |\n> | --- | --- |\n> | North | 14% |\n\nDone."])).toEqual([
      "blockquote",
      "bubble:p",
    ]);
    expect(layout(["- The barn: ![Barn](https://example.test/barn.png)\n- Hay"])).toEqual(["ul"]);
    expect(layout(["- One\n\n  ---\n\n- Two"])).toEqual(["ul"]);
    // Inline code and nested lists are still prose.
    expect(layout(["- Run `gate open`\n  - then wait\n\n> Quoted **words**"])).toEqual([
      "bubble:ul,blockquote",
    ]);
  });
  it("renders a list with nested code at full width, keeping it a list", async () => {
    const text = "Steps:\n\n- Run this:\n\n  ```sh\n  gate open\n  ```\n- Wait";
    await act(async () =>
      root.render(createElement(ReplyMarkdown, { text, live: false, bubbles: true })),
    );
    const list = container.querySelector(".message-markdown > ul")!;
    expect(list.closest(".reply-bubble")).toBeNull();
    expect(list.querySelectorAll(":scope > li")).toHaveLength(2);
    expect(list.querySelector("li pre")).not.toBeNull();
    expect(container.querySelector(".reply-bubble")!.textContent).toBe("Steps:");
  });
  it("splits a block where a fence interrupts its paragraph", () => {
    expect(layout(["Run:\n```sh\nls\n```\nThen look."])).toEqual(["bubble:p", "pre", "bubble:p"]);
  });
  it("joins prose from separate streaming blocks in one bubble while a fence is still open", () => {
    const blocks = streamingBlocks("One.\n\nTwo.\n\n```py\nprint(")!;
    expect(blocks).toHaveLength(3);
    expect(layout(blocks)).toEqual(["bubble:p,p", "pre"]);
  });
  it("has no runs for an empty reply", () => {
    expect(layout([""])).toEqual([]);
    expect(bubbleRuns([])).toEqual([]);
  });

  const mixed =
    "Intro with `code`.\n\nMore.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```txt\nx\n```\n\nDone.";
  const live = (text: string) =>
    act(async () => root.render(createElement(ReplyMarkdown, { text, live: true, bubbles: true })));
  it("keeps a bubble's node while the reply grows into it and once it is saved", async () => {
    await live("Intro with `code`.");
    const first = container.querySelector(".reply-bubble");
    await live("Intro with `code`.\n\nMore.");
    expect(container.querySelector(".reply-bubble")).toBe(first);
    expect(first!.querySelectorAll("p")).toHaveLength(2);
    await live(mixed);
    await act(async () =>
      root.render(createElement(ReplyMarkdown, { text: mixed, live: false, bubbles: true })),
    );
    expect(container.querySelector(".reply-bubble")).toBe(first);
    expect(
      [...container.querySelector(".message-markdown")!.children].map((child) =>
        child.classList.contains("reply-bubble") ? "bubble" : child.className,
      ),
    ).toEqual(["bubble", "markdown-table", "markdown-code-block", "bubble"]);
  });
  it("shows reported inputs streamed and saved as they show opened fresh", async () => {
    const shown = async (element: ReturnType<typeof createElement>) => {
      await act(async () => root.render(createElement("div")));
      await act(async () => root.render(element));
      // Newlines between blocks are insignificant in the transcript's normal white-space.
      return container.innerHTML.replace(/>\n</g, "><");
    };
    for (const text of [
      mixed,
      "Steps:\n\n1. Soak\n\n1. Rinse\n\nEnjoy.",
      "See [docs][a].\n\nMore.\r\r[a]: https://example.test",
      "Example:\n\n    ```\n    code\n\nDone",
    ]) {
      await shown(createElement(ReplyMarkdown, { text, live: true, bubbles: true }));
      await act(async () =>
        root.render(createElement(ReplyMarkdown, { text, live: false, bubbles: true })),
      );
      const saved = container.innerHTML.replace(/>\n</g, "><");
      expect(saved).toBe(await shown(createElement(MessageMarkdown, { text, bubbles: true })));
    }
  });
  it("keeps text order and every word whether or not prose sits in bubbles", async () => {
    await act(async () => root.render(createElement(MessageMarkdown, { text: mixed })));
    const flat = container.textContent;
    await act(async () =>
      root.render(createElement(MessageMarkdown, { text: mixed, bubbles: true })),
    );
    expect(container.textContent).toBe(flat);
  });
});

describe("a table wider than the reply", () => {
  it("fades each side that has more to scroll to, left to right and right to left", () => {
    expect(fadeSides(0, 0, "ltr")).toBe("");
    expect(fadeSides(0, 200, "ltr")).toBe("right");
    expect(fadeSides(100, 200, "ltr")).toBe("left right");
    expect(fadeSides(200, 200, "ltr")).toBe("left");
    // Right to left, the start is at scrollLeft 0 and the end at minus the overflow.
    expect(fadeSides(0, 200, "rtl")).toBe("left");
    expect(fadeSides(-200, 200, "rtl")).toBe("right");
    // Zoomed, a table scrolled to its end can stop a fraction of a pixel short; that is not more to see.
    expect(fadeSides(199.6, 200, "ltr")).toBe("left");
    expect(fadeSides(0.4, 200, "ltr")).toBe("right");
  });
  it("updates the fade as the reader scrolls the table", async () => {
    await act(async () =>
      root.render(createElement(MessageMarkdown, { text: "| a | b |\n| --- | --- |\n| 1 | 2 |" })),
    );
    const scroller = container.querySelector<HTMLElement>(".markdown-table-scroll")!;
    expect(scroller.dataset.fade).toBeUndefined();
    Object.defineProperties(scroller, {
      scrollWidth: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 300 },
    });
    scroller.dispatchEvent(new Event("scroll"));
    expect(scroller.dataset.fade).toBe("right");
    scroller.scrollLeft = 300;
    scroller.dispatchEvent(new Event("scroll"));
    expect(scroller.dataset.fade).toBe("left");
  });
});

describe("which blocks parse again", () => {
  const block = {
    text: "The gate is latched.",
    botId: "home",
    messageId: "m2",
    userId: "one",
    unavailable: false,
    inlineUi: true,
  };
  const cards = '```agent-ui\n{"cards":[]}\n```';
  it("keeps a block's parse when only the message ID changed, as when a live row is saved", () => {
    expect(sameBlock({ ...block, messageId: "s1-inflight" }, block)).toBe(true);
  });
  it("parses a block with reply cards again under a new ID, since its cards act on that message", () => {
    expect(
      sameBlock({ ...block, text: cards, messageId: "s1-inflight" }, { ...block, text: cards }),
    ).toBe(false);
  });
  it.each([
    ["text", { text: "The gate is open." }],
    ["inline UI", { inlineUi: false }],
    ["assistant", { botId: "trail" }],
    ["member", { userId: "two" }],
    ["connection", { unavailable: true }],
  ] as const)("parses a block again when its %s changes", (_what, change) => {
    expect(sameBlock(block, { ...block, ...change })).toBe(false);
  });
});
