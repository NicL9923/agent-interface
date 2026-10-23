import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, vi } from "vitest";

export type Mount = {
  container: HTMLDivElement;
  /**
   * Stays the same object for the whole test. Rendering after `unmount()` starts a fresh React
   * root in the same container, as a page reload would.
   */
  root: Root;
  render: (node: ReactNode) => Promise<void>;
};

const mounts: { container: HTMLDivElement; root: Root }[] = [];

/** Appends a container and a React root to the document. The shared teardown in setup-ui.ts unmounts them. */
export function mountRoot(): Mount {
  const container = document.createElement("div");
  document.body.append(container);
  let live: Root | undefined;
  const root: Root = {
    render: node => { (live ??= createRoot(container)).render(node); },
    unmount: () => { live?.unmount(); live = undefined; },
  };
  mounts.push({ container, root });
  return { container, root, render: node => act(async () => root.render(node)) };
}

/** The mount that click, button and typeInto act on by default. */
function current() {
  const mount = mounts.at(-1);
  if (!mount) throw new Error("Call mountRoot() before using the UI helpers.");
  return mount.container;
}

export async function unmountAll() {
  for (const { root } of mounts) await act(async () => root.unmount());
  for (const { container } of mounts) container.remove();
  mounts.length = 0;
}

/** The button whose text, ignoring surrounding space, is exactly `text`. */
export function button(text: string, scope: ParentNode = current()) {
  const found = Array.from(scope.querySelectorAll("button")).find(item => item.textContent?.trim() === text);
  expect(found, `a "${text}" button`).toBeDefined();
  return found!;
}

export function click(text: string, scope?: ParentNode) {
  const target = button(text, scope);
  return act(async () => target.click());
}

type TextField = HTMLInputElement | HTMLTextAreaElement;
/** Sets a field through the native value setter, which React's change tracking would otherwise swallow. */
export async function typeInto(field: TextField, value: string) {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Moves fake timers forward and lets the effects they trigger settle. */
export function advance(milliseconds: number) {
  return act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

/** Replaces matchMedia; `matches` may be fixed or decided per query. */
export function stubMatchMedia(matches: boolean | ((query: string) => boolean) = false) {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: typeof matches === "function" ? matches(query) : matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}
