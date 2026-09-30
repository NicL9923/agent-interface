// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageMarkdown } from "../src/components/MessageMarkdown";

let container: HTMLDivElement;
let root: Root;
const writeText = vi.fn<(value: string) => Promise<void>>();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  writeText.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(text: string) {
  await act(async () => root.render(createElement(MessageMarkdown, { text })));
}

async function copy() {
  const button = container.querySelector("button");
  expect(button?.textContent).toBe("Copy code");
  await act(async () => button!.click());
}

describe("assistant Markdown", () => {
  it("renders semantic headings, emphasis, lists, links, and GFM tables", async () => {
    await render(
      "## Plan\n\nUse **care** and *patience*.\n\n1. Read the `config`.\n2. Follow [the docs](https://example.test/docs).\n\n| Step | State |\n| --- | --- |\n| Review | Done |",
    );
    expect(container.querySelector("h2")?.textContent).toBe("Plan");
    expect(container.querySelector("strong")?.textContent).toBe("care");
    expect(container.querySelector("em")?.textContent).toBe("patience");
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelector("code")?.textContent).toBe("config");
    expect(container.querySelector("button")).toBeNull();
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
