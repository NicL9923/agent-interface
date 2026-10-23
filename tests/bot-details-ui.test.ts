// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { BotDetails } from "../src/app/BotDetails";
import { defaultPreferences, type Bootstrap, type Preferences } from "../src/shared/types";
import type { ComponentProps } from "react";
import { mountRoot, typeInto } from "./ui-harness";

vi.mock("../src/components/Avatar", async original => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  Avatar: (props: { reducedMotion?: boolean; size?: number }) => createElement("span", { "data-avatar-size": props.size, "data-still": props.reducedMotion ? "" : undefined }),
}));

let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof BotDetails>;
let saved: Preferences[];
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  ({ container, root } = mountRoot());
  saved = [];
  const bot = { id: "ranch", name: "Ranch hand", activity: "idle" as const, shared: true, model: "m", provider: "p" };
  props = {
    boot: {
      user: { id: "one", name: "One", email: "one@example.test" },
      preferences: { ...defaultPreferences, sections: [{ id: "house", name: "Around the house", botIds: ["ranch"] }] },
      bots: [bot],
    } as Bootstrap,
    bot, avatarState: "working", conversation: null, connectionLost: false,
    // Like the session's queue: each edit applies to the newest value.
    editPreferences: vi.fn(async (edit: (value: Preferences) => Preferences) => { saved.push(edit(saved.at(-1) ?? props.boot.preferences)); }),
    onSettings: vi.fn(), onClose: vi.fn(),
  };
});
const render = () => act(async () => root.render(createElement(BotDetails, props)));
const select = () => container.querySelector<HTMLSelectElement>(".bot-details select")!;
const pick = (value: string) => act(async () => {
  select().value = value;
  select().dispatchEvent(new Event("change", { bubbles: true }));
});

it("shows a live avatar, who it is, and the per-assistant choices", async () => {
  await render();
  expect(container.querySelector("[data-avatar-size='112']")?.hasAttribute("data-still")).toBe(false);
  expect(container.querySelector("h2")?.textContent).toBe("Ranch hand");
  expect(container.textContent).toContain("Shared with your household · p / m");
  // Artifacts come from this assistant's open conversation, so another one's sheet leaves them out.
  expect(container.textContent).not.toContain("Artifacts");
  await act(async () => container.querySelector<HTMLInputElement>('[role="switch"]')!.click());
  expect(saved.at(-1)!.followBots).toEqual(["ranch"]);
  await act(async () => Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Settings")!.click());
  expect(props.onSettings).toHaveBeenCalledWith(props.bot);
});

it("moves the assistant between sections, and into a new one named here", async () => {
  await render();
  expect(select().value).toBe("house");
  await pick("");
  expect(saved.at(-1)!.sections).toEqual([{ id: "house", name: "Around the house", botIds: [] }]);
  await pick(Array.from(select().options).find(option => option.textContent === "New section…")!.value);
  const name = container.querySelector<HTMLInputElement>('[aria-label="New section name"]')!;
  expect(document.activeElement).toBe(name);
  await typeInto(name, "Outdoors");
  await act(async () => container.querySelector<HTMLFormElement>(".section-add")!.requestSubmit());
  const sections = saved.at(-1)!.sections;
  expect(sections.map(section => [section.name, section.botIds])).toEqual([["Around the house", []], ["Outdoors", ["ranch"]]]);
});

it("opens ready to name a new section when the home menu asks for one", async () => {
  props.startNewSection = true;
  await render();
  expect(document.activeElement).toBe(container.querySelector('[aria-label="New section name"]'));
  await act(async () => container.querySelector<HTMLFormElement>(".section-add")!.requestSubmit());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Enter a section name.");
  expect(props.editPreferences).not.toHaveBeenCalled();
});
