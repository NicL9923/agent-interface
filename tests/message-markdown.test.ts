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
    for (const text of ["Cards\n\n```agent-ui\n{}\n```", "See [docs][1].\n\n[1]: https://example.test",
      "Note[^1]\n\n[^1]: Footnote", "<!--\n\nhidden\n-->"]) expect(streamingBlocks(text)).toBeNull();
  });

  it("renders a growing reply the same as the saved reply", async () => {
    for (const text of [
      "## Supper\n\nBeans, **cornbread** and greens.\n\n> Soak the beans tonight.\n\n```txt\nsoak\n\nsimmer\n```\n\n| Day | Meal |\n| --- | --- |\n| Sat | Chili |",
      // Loose lists continue across blank lines, so their numbering and spacing hold.
      "Steps:\n\n1. Soak\n\n1. Rinse\n\n1. Simmer\n\nEnjoy.",
      "- Beans\n\n- Cornbread\n\n* Greens",
      "- [ ] Feed the horses\n\n- [x] Check the gate\n\nThat is all.",
    ]) expect(await renderAs(StreamingMarkdown, text)).toBe(await renderAs(MessageMarkdown, text));
  });
});
