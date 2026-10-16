// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sidebar } from "../src/app/Sidebar";
import { defaultPreferences, type Bootstrap } from "../src/shared/types";
import type { ComponentProps } from "react";

vi.mock("../src/components/Avatar", async original => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  Avatar: () => null,
}));

let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof Sidebar>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
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
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
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
