// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageMarkdown, StreamingMarkdown, streamingBlocks } from "../src/components/MessageMarkdown";
import { mountRoot, stubMatchMedia } from "./ui-harness";

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
    await render("Saved to [notes.md](/home/nicolas/.hermes/profiles/testbot/notes.md). See [docs](https://example.test) or [the file](/api/files/abc).");
    const links = [...container.querySelectorAll("a")].map(link => link.getAttribute("href"));
    expect(links).toEqual(["https://example.test", "/api/files/abc"]);
    expect(container.querySelector(".markdown-local-file")?.textContent).toBe("notes.md");
  });

  it("keeps links to this app's own destinations and protocol-relative web addresses", async () => {
    await render("[Today](/?view=today), [Chat](/?bot=ranch), [docs](//example.test/docs) and [notes](~/notes.md).");
    expect([...container.querySelectorAll("a")].map(link => link.getAttribute("href"))).toEqual(["/?view=today", "/?bot=ranch", "//example.test/docs"]);
    expect(container.querySelector(".markdown-local-file")?.textContent).toBe("notes");
  });

  it("renders only closed explicit UI fences when the caller enables assistant UI", async () => {
    stubMatchMedia();
    const payload = JSON.stringify({ version: 1, title: "Supply planner", html: "<button>Compare</button>" });
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
    const message = (data: unknown, source: MessageEventSource | null) => act(async () => window.dispatchEvent(new MessageEvent("message", { data, source })));
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
    expect([...container.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Copy as Markdown", "Copy as CSV"]);
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
    expect(container.querySelector("pre")?.getAttribute("aria-label")).toBe("typescript code block");
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
    expect(links[0].getAttribute("href")).toBe("https://other.example/collect?private=conversation");
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
    writeText.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
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
  const settle = () => act(async () => { await vi.dynamicImportSettled(); });
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
    await act(async () => root.render(createElement(StreamingMarkdown, { text: "Here:\n\n```python\nprint('hay')" })));
    await settle();
    expect(container.querySelector("pre code")?.textContent).toBe("print('hay')\n");
    expect(container.querySelector("pre code [class^=hljs-]")).toBeNull();
    await render("```brainfuck\n+++.\n```");
    await settle();
    expect(container.querySelector("pre code")?.innerHTML).toBe("+++.\n");
  });

  it("copies a table as Markdown or CSV and says so", async () => {
    await render("| Gate | Battery |\n| --- | --- |\n| Barn, west | 48% |");
    const button = (text: string) => [...container.querySelectorAll("button")].find(item => item.textContent === text)!;
    await act(async () => button("Copy as CSV").click());
    expect(writeText).toHaveBeenLastCalledWith('Gate,Battery\r\n"Barn, west",48%');
    expect(container.querySelector(".markdown-table [role=status]")?.textContent).toBe("Table copied as CSV.");
    await act(async () => button("Copy as Markdown").click());
    expect(writeText).toHaveBeenLastCalledWith("| Gate | Battery |\n| --- | --- |\n| Barn, west | 48% |");
    writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => button("Copy as CSV").click());
    expect(container.querySelector(".markdown-table [role=status]")?.textContent).toContain("copy it manually");
  });
});

describe("streaming Markdown", () => {
  const renderAs = async (component: typeof MessageMarkdown, text: string) => {
    await act(async () => root.render(createElement(component, { text })));
    // Newlines between blocks are insignificant in the transcript's normal white-space.
    return container.innerHTML.replace(/>\n</g, "><");
  };

  it("splits only at blank lines that start a new block outside code fences", () => {
    expect(streamingBlocks("# Plan\n\nFirst part.\n\n```sh\necho one\n\necho two\n```\n\nDone")).toEqual(
      ["# Plan", "First part.", "```sh\necho one\n\necho two\n```", "Done"]);
    // An indented line continues the list item above it, so it stays with it.
    expect(streamingBlocks("1. Feed\n\n   the horses\n\nNext")).toEqual(["1. Feed\n\n   the horses", "Next"]);
    expect(streamingBlocks("Still typing\n\n")).toEqual(["Still typing\n\n"]);
    expect(streamingBlocks("Open fence\n\n```\ncode\n\nmore")).toEqual(["Open fence", "```\ncode\n\nmore"]);
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
    expect(streamingBlocks("Match `/[^a-z]/` once.\n\nThen [^b] again.")).toEqual(["Match `/[^a-z]/` once.", "Then [^b] again."]);
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
    ]) expect(await renderAs(StreamingMarkdown, text)).toBe(await renderAs(MessageMarkdown, text));
  });

  // Each case is a fence or definition the per-line splitter cannot follow, so it must parse whole.
  it.each([
    ["a fence opened behind a list marker hides a later footnote", "Note[^a]\n\nHere:\n\n- ```\n  code\n  ```\n\n[^a]: footnote"],
    ["a list item's fence closes on a line that the tracker reads as an opener", "See [docs][a].\n\nSteps:\n\n- ```\n  code\n  ```\n  [a]: https://example.test\n  ```"],
    ["a list item's fence ends at a line left of it", "See [docs][a].\n\nSteps:\n\n- Run:\n\n  ```\n[a]: https://example.test\n  ```"],
    ["an HTML block holds a fence-shaped line", "See [docs][a].\n\n<div>\n```\n</div>\n\n[a]: https://example.test"],
    ["a definition label spans two lines", "See [docs][a b].\n\n[a\nb]: https://example.test"],
    ["a definition label holds an escaped bracket", "See [docs][a\\]b].\n\n[a\\]b]: https://example.test"],
    ["a list item's fence sits four spaces in and the item ends at a quote", "- Code:\n\n    ```\n    x\n\n> Next"],
  ])("renders the same as the saved reply when %s", async (_case, text) => {
    expect(await renderAs(StreamingMarkdown, text)).toBe(await renderAs(MessageMarkdown, text));
    expect(streamingBlocks(text)).toBeNull();
  });

  // Seeded replies built from lines the splitter must follow: fences in and out of containers,
  // definitions, multi-line labels, HTML blocks and tables. Live and saved must render alike.
  it("renders seeded random replies the same live and saved", async () => {
    const lines = ["See [docs][a].", "Note[^a] here.", "[a]: https://example.test", "[^a]: foot", "[a", "b]: https://example.test/b",
      "- ```", "  ```", "```", "~~~", "   ```", "    ```", "\t```", "> ```", "  code", "code", "    indented", "> text", ">", "- item", "1. item",
      "  - nested", "- [ ] task", "<div>", "</div>", "<!--", "-->", "| a | b |", "| - | - |", "Text **bold**", "Title", "===", "* * *", "", ""];
    let seed = 7;
    const pick = (count: number) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8) % count;
    const diverged: string[] = [];
    for (let run = 0; run < 1500 && diverged.length < 3; run++) {
      const body = Array.from({ length: 3 + pick(12) }, () => lines[pick(lines.length)] + (pick(3) ? "\n" : "\n\n")).join("");
      const text = `See [docs][a] and [x][a b], note[^a].\n\nIntro.\n\n${body}`;
      if (await renderAs(StreamingMarkdown, text) !== await renderAs(MessageMarkdown, text)) diverged.push(text);
    }
    expect(diverged).toEqual([]);
  }, 60_000);

  // Three code-heavy replies of the kind assistants write. No prefix ending at a line break may fall
  // back to a whole parse; a later broadening of the fallbacks that costs ordinary replies their
  // blocks fails here.
  it.each([
    ["a tutorial with fenced code between paragraphs", [
      "## Set up the worker", "", "Install the queue client first:", "", "```bash", "npm install bullmq ioredis", "```", "",
      "Then create `worker.ts`:", "", "```ts", "import { Worker } from \"bullmq\";", "", "// One connection per process.",
      "const connection = { host: \"localhost\", port: 6379 };", "", "export const worker = new Worker(\"email\", async job => {",
      "  const { to, subject } = job.data;", "", "  await send(to, subject);", "}, { connection });", "```", "",
      "A few notes:", "", "- `concurrency` defaults to **1**.", "- Failed jobs retry with `attempts` and `backoff`.", "",
      "| Option | Default |", "| --- | --- |", "| `attempts` | 1 |", "| `backoff` | none |", "", "That is the whole worker.",
    ]],
    ["numbered steps with code in each item", [
      "Here is how to rotate the key:", "", "1. Create the new key:", "", "   ```sh", "   az keyvault key create --name app-key", "",
      "   az keyvault key show --name app-key", "   ```", "", "2. Update the app setting:", "", "   ```json", "   {", "     \"KeyName\": \"app-key\"",
      "   }", "   ```", "", "   - Restart the app after saving.", "   - Watch the logs for `KeyNotFound`.", "",
      "3. Delete the old key once traffic is clean.", "", "> **Note:** keep the old key for 24 hours in case you roll back.", "", "Done.",
    ]],
    ["a fix with a diff, Python and a Markdown sample", [
      "The error comes from the decorator:", "", "> TypeError: wrapper() got an unexpected keyword argument 'retry'", "",
      "Pass the keyword arguments through:", "", "```diff", "-def wrapper(*args):", "-    return fn(*args)", "+def wrapper(*args, **kwargs):",
      "+    return fn(*args, **kwargs)", "```", "", "The full decorator:", "", "```python", "def logged(fn):", "    @wraps(fn)",
      "    def wrapper(*args, **kwargs):", "        log.info(\"calling %s\", fn.__name__)", "", "        return fn(*args, **kwargs)", "",
      "    return wrapper", "```", "", "If the docs use reference links, keep the definitions at the bottom:", "", "```md",
      "See [the guide][g].", "", "[g]: https://example.test/guide", "<!-- end -->", "```", "", "That should clear it.",
    ]],
  ])("keeps blocks at every line of %s", (_reply, lines) => {
    const prefixes = lines.map((_line, index) => lines.slice(0, index + 1).join("\n"));
    expect(prefixes.filter(prefix => streamingBlocks(prefix) === null)).toEqual([]);
  });

  it("keeps blocks for a fence in a list item whose lines stay indented", () => {
    const item = "1. Install:\n\n   ```sh\n   npm i\n\n   npm test\n   ```";
    expect(streamingBlocks(`${item}\n\nDone`)).toEqual([item, "Done"]);
    // With no list above it, a fence indented four spaces is indented code and splits as usual.
    expect(streamingBlocks("Example:\n\n    ```\n    code\n\nDone")).toEqual(["Example:\n\n    ```\n    code", "Done"]);
  });
});
