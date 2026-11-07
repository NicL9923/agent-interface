// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { expect, it, vi } from "vitest";
import { CommandPalette } from "../src/app/CommandPalette";
import { FindBar } from "../src/app/FindBar";
import { defaultPreferences, type Bootstrap } from "../src/shared/types";
import { mountRoot, stubMatchMedia, typeInto } from "./ui-harness";

const key = (element: Element, key: string, options: KeyboardEventInit = {}) => act(async () => {
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...options }));
});

it("navigates the palette, selects a command and restores focus", async () => {
  stubMatchMedia();
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  Object.assign(SVGElement.prototype, { getTotalLength: () => 100, getPointAtLength: (length: number) => ({ x: length, y: 0 }) });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  const select = vi.fn();
  const boot = { preferences: defaultPreferences, bots: [
    { id: "one", name: "One", activity: "idle" }, { id: "two", name: "Two", activity: "idle" },
  ] } as Bootstrap;
  function Host() {
    const [open, setOpen] = useState(false);
    return h("div", null, h("button", { onClick: () => setOpen(true) }, "Open palette"), open && h(CommandPalette, { boot, botId: "one", readThrough: {}, connectionLost: false,
      onClose: () => setOpen(false), onSelectBot: select, onView: () => {}, onSearch: () => {}, onSettings: () => {}, onNewBot: () => {}, onTheme: () => {}, onShortcuts: () => {} }));
  }
  const mount = mountRoot();
  await mount.render(h(Host));
  const opener = mount.container.querySelector("button")!;
  opener.focus();
  await act(async () => opener.click());
  let input = mount.container.querySelector<HTMLInputElement>("[role=combobox]")!;
  expect(document.activeElement).toBe(input);
  await key(input, "ArrowDown");
  expect(mount.container.querySelector('[role=option][aria-selected=true]')?.textContent).toContain("Two");
  await key(input, "Enter");
  expect(select).toHaveBeenCalledWith("two");
  expect(mount.container.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
  await act(async () => opener.click());
  input = mount.container.querySelector<HTMLInputElement>("[role=combobox]")!;
  await key(input, "k", { ctrlKey: true });
  expect(mount.container.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
  await act(async () => opener.click());
  await act(async () => { mount.container.querySelector("dialog")!.dispatchEvent(new Event("cancel", { bubbles: false, cancelable: true })); });
  expect(mount.container.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it("finds loaded messages and navigates older and newer matches with Enter", async () => {
  vi.useFakeTimers();
  const scroll = document.createElement("div");
  scroll.innerHTML = '<article data-message-id="a"><div class="message-text">Fence one</div></article><article data-message-id="b"><div class="message-text">Fence two</div></article>';
  document.body.append(scroll);
  const open = vi.fn(), close = vi.fn();
  const mount = mountRoot();
  await mount.render(h(FindBar, { botId: "one", conversation: null, scroll: { current: scroll }, openMessage: open, onClose: close }));
  const input = mount.container.querySelector<HTMLInputElement>("input")!;
  expect(document.activeElement).toBe(input);
  await typeInto(input, "fence");
  expect(mount.container.querySelector('[role=status]')?.textContent).toBe("2 of 2");
  await key(input, "Enter");
  expect(open).toHaveBeenCalledWith("a", true, "fence");
  await key(input, "Enter", { shiftKey: true });
  expect(open).toHaveBeenCalledWith("b", true, "fence");
  await key(input, "Escape");
  expect(close).toHaveBeenCalledOnce();
});
