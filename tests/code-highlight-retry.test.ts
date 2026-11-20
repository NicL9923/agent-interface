// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { MessageMarkdown, resetHighlighterForTest } from "../src/components/MessageMarkdown";
import { mountRoot } from "./ui-harness";

// A transient chunk fetch failure cannot happen from disk, so reject the first dynamic import
// through a thenable namespace and succeed on the retry.
let failHighlightImport = true;
vi.mock("../src/components/code-highlight", async (original) => {
  const real = await original<typeof import("../src/components/code-highlight")>();
  const mod: Record<string, unknown> = {};
  // oxlint-disable-next-line unicorn/no-thenable -- ESM dynamic import rejects once via a thenable module namespace.
  Object.defineProperty(mod, "then", {
    value(
      resolve: (value: { highlight: typeof real.highlight }) => void,
      reject: (reason: unknown) => void,
    ) {
      if (failHighlightImport) {
        failHighlightImport = false;
        reject(new TypeError("Failed to fetch dynamically imported module: code-highlight.js"));
        return;
      }
      resolve({ highlight: real.highlight });
    },
  });
  return mod;
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetHighlighterForTest();
  failHighlightImport = true;
  ({ container, root } = mountRoot());
});

const settle = () =>
  act(async () => {
    await vi.dynamicImportSettled();
  });

it("retries loading the syntax highlighter chunk after a transient import failure", async () => {
  await act(async () =>
    root.render(createElement(MessageMarkdown, { text: "```ts\nconst answer = 42;\n```" })),
  );
  await settle();
  // First block falls back to plain code without crashing when the chunk fails.
  expect(container.querySelector("code")?.textContent).toContain("const answer = 42;");
  expect(container.querySelector(".hljs-keyword")).toBeNull();

  // A subsequent code block retries the dynamic import and receives syntax highlighting.
  await act(async () =>
    root.render(createElement(MessageMarkdown, { text: "```ts\nconst retry = 99;\n```" })),
  );
  await settle();
  expect(container.querySelector(".hljs-keyword")?.textContent).toBe("const");
});
