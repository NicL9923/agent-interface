// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { Sidebar } from "../src/app/Sidebar";
import { defaultPreferences, type Bootstrap } from "../src/shared/types";
import type { ComponentProps } from "react";
import { mountRoot } from "./ui-harness";

vi.mock("../src/components/Avatar", async original => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  Avatar: () => null,
}));

let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof Sidebar>;
beforeEach(() => {
  ({ container, root } = mountRoot());
  props = {
    boot: {
      user: { id: "one", name: "One" },
      preferences: { ...defaultPreferences, favorites: ["ranch", "garden"] },
      bots: [
        { id: "ranch", name: "Ranch hand", activity: "idle" },
        { id: "garden", name: "Garden planner", activity: "thinking" },
      ],
    } as Bootstrap,
    botId: "ranch", view: "conversation", state: "working",
    connectionLost: false, offline: false, mobile: false, open: true, update: null,
    onSelectBot: vi.fn(), onView: vi.fn(), onNewBot: vi.fn(),
    onSettings: vi.fn(), onPin: vi.fn(), onBotSettings: vi.fn(),
    onMoveToSection: vi.fn(), onNewSection: vi.fn(),
  };
});
const render = () => act(async () => root.render(createElement(Sidebar, props)));
const statuses = () => [...container.querySelectorAll(".pinned-activity")].map(node => node.textContent);

it("updates pinned activity from the selected conversation and other bots' live summaries", async () => {
  await render();
  expect(statuses()).toEqual(["Working", "Thinking"]);
  props = { ...props, state: "done", boot: { ...props.boot, bots: props.boot.bots.map(bot => ({ ...bot, activity: "waiting" })) } };
  await render();
  expect(statuses()).toEqual(["", "Waiting"]);
  props = { ...props, state: "thinking" };
  await render();
  expect(statuses()).toEqual(["Thinking", "Waiting"]);
  await act(async () => container.querySelector<HTMLButtonElement>(".pinned-bot")!.click());
  expect(props.onSelectBot).toHaveBeenCalledWith("ranch");
});

it("shows attention and failure states without calling them working", async () => {
  props = { ...props, state: "blocked" };
  await render();
  expect(statuses()[0]).toBe("Needs your help");
  props = { ...props, state: "failed" };
  await render();
  expect(statuses()[0]).toBe("Failed");
  props = { ...props, state: "idle" };
  await render();
  expect(statuses()[0]).toBe("");
});

it("replaces stale working indicators during connection loss and restores them on reconnect", async () => {
  await render();
  props = { ...props, connectionLost: true, offline: true };
  await render();
  expect(statuses()).toEqual(["Connection lost", "Connection lost"]);
  expect(container.querySelector(".pinned-activity.state-working")).toBeNull();
  props = { ...props, connectionLost: false, offline: false };
  await render();
  expect(statuses()).toEqual(["Working", "Thinking"]);
});

const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const key = async (target: Element, value: string, shiftKey = false) => act(async () => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }));
});
const settleFocus = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });

it("opens the assistant menu by keyboard, navigates its actions, and restores row focus on Escape", async () => {
  await render();
  const row = container.querySelector<HTMLButtonElement>(".pinned-bot")!;
  row.focus();
  await key(row, "F10", true);
  await settleFocus();
  expect(document.body.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Ranch hand");
  const [unpin, move, settings] = menuItems();
  expect(move.textContent).toBe("Move to section");
  await key(document.activeElement!, "ArrowDown");
  expect(document.activeElement).toBe(unpin);
  await key(unpin, "End");
  expect(document.activeElement).toBe(settings);
  await key(settings, "Home");
  expect(document.activeElement).toBe(unpin);
  await key(unpin, "a");
  expect(document.activeElement).toBe(settings);
  await key(settings, "Escape");
  await settleFocus();
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(row);
  expect(props.onSelectBot).not.toHaveBeenCalled();
});

it("opens a right-click menu for its own assistant and invokes its settings", async () => {
  await render();
  const row = container.querySelectorAll<HTMLButtonElement>(".pinned-bot")[1];
  await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { clientX: 100, clientY: 180, button: 2, bubbles: true, cancelable: true })));
  await settleFocus();
  await act(async () => menuItems()[2].click());
  expect(props.onBotSettings).toHaveBeenCalledExactlyOnceWith(props.boot.bots[1]);
  expect(props.onSelectBot).not.toHaveBeenCalled();
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
});

it("opens on a held touch, cancels a scrolling touch, and suppresses selection after a long press", async () => {
  await render();
  const row = container.querySelector<HTMLButtonElement>(".pinned-bot")!;
  const touch = async (type: string, x: number, y: number) => act(async () => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientX: x, clientY: y }] });
    row.dispatchEvent(event);
  });
  await touch("touchstart", 30, 40);
  await touch("touchmove", 30, 60);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 520)); });
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
  await touch("touchend", 30, 60);
  await touch("touchstart", 30, 40);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 520)); });
  await settleFocus();
  expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
  await touch("touchend", 30, 40);
  await act(async () => row.click());
  expect(props.onSelectBot).not.toHaveBeenCalled();
});

it("moves an assistant to one home section from its menu, or starts a new section for it", async () => {
  props.boot.preferences = { ...props.boot.preferences, sections: [{ id: "house", name: "Around the house", botIds: ["garden"] }] };
  await render();
  const openSubmenu = async () => {
    const row = container.querySelectorAll<HTMLButtonElement>(".pinned-bot")[1];
    await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { clientX: 100, clientY: 180, button: 2, bubbles: true, cancelable: true })));
    await settleFocus();
    await act(async () => menuItems().find(item => item.textContent === "Move to section")!.click());
    await settleFocus();
  };
  await openSubmenu();
  const choices = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  expect(choices.map(item => [item.textContent, item.getAttribute("aria-checked")])).toEqual([["None", "false"], ["✓Around the house", "true"]]);
  await act(async () => choices[0].click());
  expect(props.onMoveToSection).toHaveBeenCalledExactlyOnceWith(props.boot.bots[1], null);
  await settleFocus();
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
  await openSubmenu();
  await act(async () => menuItems().find(item => item.textContent === "New section…")!.click());
  expect(props.onNewSection).toHaveBeenCalledExactlyOnceWith(props.boot.bots[1]);
  expect(props.onSelectBot).not.toHaveBeenCalled();
});
