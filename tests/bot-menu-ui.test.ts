// @vitest-environment jsdom
import { act, createElement } from "react";
import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { defaultPreferences, type Bootstrap } from "../src/shared/types";
import { mountRoot } from "./ui-harness";

// The menu code is held back to play a slow network, so these are gestures that beat it.
const gate = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined }));
vi.mock("../src/app/BotMenuPopup", async original => { await gate.hold; return original(); });
vi.mock("../src/components/Avatar", async original => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  Avatar: () => null,
}));

type SidebarProps = ComponentProps<typeof import("../src/app/Sidebar").Sidebar>;
let root: Root;
let container: HTMLDivElement;
let props: SidebarProps;
let release: () => void;
let Sidebar: typeof import("../src/app/Sidebar").Sidebar;

beforeEach(async () => {
  ({ container, root } = mountRoot());
  // A fresh copy of the menu loader, which otherwise remembers having loaded.
  vi.resetModules();
  gate.hold = new Promise<void>(resolve => { release = resolve; });
  ({ Sidebar } = await import("../src/app/Sidebar"));
  props = {
    boot: {
      user: { id: "one", name: "One" },
      preferences: { ...defaultPreferences, favorites: ["ranch", "garden"] },
      bots: [
        { id: "ranch", name: "Ranch hand", activity: "idle" },
        { id: "garden", name: "Garden planner", activity: "idle" },
      ],
    } as Bootstrap,
    botId: "ranch", readThrough: {}, view: "conversation", state: "idle",
    connectionLost: false, offline: false, mobile: false, open: true, update: null,
    onSelectBot: vi.fn(), onView: vi.fn(), onNewBot: vi.fn(),
    onSettings: vi.fn(), onPin: vi.fn(), onBotSettings: vi.fn(),
    onMoveToSection: vi.fn(), onNewSection: vi.fn(),
  };
});

const render = () => act(async () => root.render(createElement(Sidebar, props)));
const rows = () => [...container.querySelectorAll<HTMLButtonElement>(".pinned-bot")];
const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]');
const items = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const wait = (milliseconds: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, milliseconds)); });
/** Lets the held menu code arrive, as the network eventually delivers it. */
const arrive = async () => { release(); await act(async () => { await vi.dynamicImportSettled(); }); };
const opened = (name: string) => vi.waitFor(() => expect(menu()?.getAttribute("aria-label")).toBe(name), { timeout: 5000 });
const touch = (row: Element, type: string, x = 30, y = 40) => act(async () => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y }] });
  row.dispatchEvent(event);
});

it("opens the first right-click menu once the code arrives, without ever showing the browser's menu", async () => {
  await render();
  const event = new MouseEvent("contextmenu", { clientX: 100, clientY: 180, button: 2, bubbles: true, cancelable: true });
  await act(async () => rows()[1].dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(menu()).toBeNull();
  await arrive();
  await opened("Garden planner");
  // Where the real trigger puts the same right-click is where the replayed one must have put it.
  const placement = () => menu()!.parentElement!.getAttribute("style");
  const replayed = placement();
  expect(replayed).toContain("--transform-origin: 1px 168px");
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await wait(30);
  expect(menu()).toBeNull();
  await act(async () => rows()[1].dispatchEvent(new MouseEvent("contextmenu", { clientX: 100, clientY: 180, button: 2, bubbles: true, cancelable: true })));
  await wait(30);
  expect(placement()).toBe(replayed);
  await act(async () => rows()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await act(async () => rows()[1].dispatchEvent(new MouseEvent("contextmenu", { clientX: 300, clientY: 400, button: 2, bubbles: true, cancelable: true })));
  await wait(30);
  expect(placement()).not.toBe(replayed);
  await act(async () => items()[0].click());
  expect(props.onPin).toHaveBeenCalledExactlyOnceWith(props.boot.bots[1]);
  expect(props.onSelectBot).not.toHaveBeenCalled();
});

it("opens the first menu-key press once the code arrives, anchored to its row", async () => {
  await render();
  rows()[0].focus();
  const event = new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true });
  await act(async () => rows()[0].dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  await arrive();
  await opened("Ranch hand");
  expect(items().map(item => item.textContent)).toEqual(["Unpin", "Move to section", "Assistant settings"]);
});

it("opens the first long press once the finger lifts and the code has arrived, without selecting the row", async () => {
  await render();
  const row = rows()[0];
  await touch(row, "touchstart");
  await wait(520);
  expect(menu()).toBeNull();
  await touch(row, "touchend");
  await act(async () => row.click());
  expect(props.onSelectBot).not.toHaveBeenCalled();
  await arrive();
  await opened("Ranch hand");
  expect(props.onSelectBot).not.toHaveBeenCalled();
});

it("treats a quick tap or a scroll as a tap or a scroll, never as a long press", async () => {
  await render();
  const row = rows()[0];
  await touch(row, "touchstart");
  await touch(row, "touchmove", 30, 70);
  await wait(520);
  await touch(row, "touchend");
  await arrive();
  await vi.waitFor(() => expect(rows()[0]).not.toBe(row), { timeout: 5000 });
  expect(menu()).toBeNull();
  await touch(row, "touchstart");
  await touch(row, "touchend");
  await act(async () => rows()[0].click());
  expect(props.onSelectBot).toHaveBeenCalledExactlyOnceWith("ranch");
});

it("keeps focus on a row when the real menu replaces it, but not under a finger", async () => {
  await render();
  const [first, second] = rows();
  first.focus();
  await touch(second, "touchstart");
  await arrive();
  await wait(100);
  // The menu code is here, but the row being touched stays until the finger lifts.
  expect(rows()[1]).toBe(second);
  expect(rows()[0]).toBe(first);
  await touch(second, "touchend");
  await vi.waitFor(() => expect(rows()[1]).not.toBe(second), { timeout: 5000 });
  expect(document.activeElement).toBe(rows()[0]);
  expect(rows()[0].matches(":focus")).toBe(true);
});
