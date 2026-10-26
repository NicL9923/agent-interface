// @vitest-environment jsdom
import { act, createElement } from "react";
import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { defaultPreferences, type Bootstrap } from "../src/shared/types";
import { mountRoot } from "./ui-harness";

// The menu code is held back to play a slow network, so these are gestures that beat it.
const gate = { hold: undefined as Promise<void> | undefined };
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
  // Registered afresh each time, because a mock factory's module is remembered once it has resolved.
  vi.doMock("../src/app/BotMenuPopup", async () => {
    await gate.hold;
    return vi.importActual<typeof import("../src/app/BotMenuPopup")>("../src/app/BotMenuPopup");
  });
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
  const origin = () => /--transform-origin: ([^;]+)/.exec(menu()?.parentElement?.getAttribute("style") ?? "")?.[1];
  const closeMenu = async () => {
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await vi.waitFor(() => expect(menu()).toBeNull());
  };
  const rightClick = (x: number, y: number) => act(async () => rows()[1].dispatchEvent(new MouseEvent("contextmenu", { clientX: x, clientY: y, button: 2, bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(origin()).toBe("1px 168px"));
  await closeMenu();
  await rightClick(100, 180);
  await vi.waitFor(() => expect(origin()).toBe("1px 168px"));
  await closeMenu();
  await rightClick(300, 400);
  await vi.waitFor(() => expect(origin()).toBeDefined());
  await wait(30);
  expect(origin()).not.toBe("1px 168px");
  await act(async () => items()[0].click());
  expect(props.onPin).toHaveBeenCalledExactlyOnceWith(props.boot.bots[1]);
  expect(props.onSelectBot).not.toHaveBeenCalled();
});

it("opens one menu, for the last row right-clicked, when several rows are right-clicked while the code loads", async () => {
  await render();
  const rightClick = (row: Element, x: number, y: number) => act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { clientX: x, clientY: y, button: 2, bubbles: true, cancelable: true })));
  await rightClick(rows()[0], 50, 60);
  await rightClick(rows()[1], 100, 180);
  expect(menu()).toBeNull();
  await arrive();
  await opened("Garden planner");
  await wait(50);
  expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(1);
  expect(menu()?.getAttribute("aria-label")).toBe("Garden planner");
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
