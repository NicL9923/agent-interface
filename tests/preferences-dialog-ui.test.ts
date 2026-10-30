// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesDialog } from "../src/app/PreferencesDialog";
import { defaultPreferences, type Bootstrap, type Preferences } from "../src/shared/types";
import type { ComponentProps } from "react";
import { button, mountRoot, stubMatchMedia, typeInto } from "./ui-harness";

vi.mock("../src/components/Avatar", async original => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  Avatar: () => null,
}));
vi.mock("../src/components/DeviceNotifications", () => ({ NotificationSettings: () => null }));

let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof PreferencesDialog>;
let saved: Preferences[];
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  ({ container, root } = mountRoot());
  stubMatchMedia();
  saved = [];
  props = {
    boot: {
      user: { id: "one", name: "One", email: "one@example.test" },
      preferences: { ...defaultPreferences, followBots: ["ranch"], sections: [
        { id: "house", name: "Around the house", botIds: ["ranch", "kitchen"] },
        { id: "kids", name: "Kids", botIds: [] },
      ] },
      bots: [
        { id: "ranch", name: "Ranch hand", activity: "idle", shared: true, model: "m" },
        { id: "kitchen", name: "Kitchen", activity: "idle", shared: true, model: "m" },
        { id: "homework", name: "Homework helper", activity: "idle", shared: false, model: "m" },
      ],
      connection: { connected: true, version: "0123456789abcdef0123456789abcdef01234567" },
    } as Bootstrap,
    connectionLost: false, offline: false,
    // Saves resolve only when the test says so, like a slow network.
    // Like the session's queue, each edit applies to the newest value; saves resolve only
    // when the test says so, like a slow network.
    editPreferences: vi.fn((edit: (value: Preferences) => Preferences) => { saved.push(edit(saved.at(-1) ?? props.boot.preferences)); return new Promise<void>(() => {}); }),
    notifications: { busy: false } as ComponentProps<typeof PreferencesDialog>["notifications"],
    installEvent: null, notice: "",
    onClose: vi.fn(), onSignOut: vi.fn(), onComputer: vi.fn(), onIntegrations: vi.fn(), onUpgrade: vi.fn(), onShortcuts: vi.fn(),
  };
});
const render = () => act(async () => root.render(createElement(PreferencesDialog, props)));
const choice = (name: string) => Array.from(container.querySelectorAll<HTMLLabelElement>(".bot-choice"))
  .find(item => item.querySelector(".row-label")?.textContent === name)!.querySelector("input")!;
const title = () => container.querySelector("#settings-title")?.textContent;

describe("home sections", () => {
  it("keeps Add usable: an empty name explains itself, and a typed one adds the section", async () => {
    await render();
    const add = button("Add");
    expect(add.disabled).toBe(false);
    await act(async () => add.click());
    expect(props.editPreferences).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Enter a section name.");
    expect(document.activeElement).toBe(container.querySelector('[aria-label="New section name"]'));
    await typeInto(container.querySelector('[aria-label="New section name"]')!, "  Chores ");
    await act(async () => add.click());
    expect(saved.at(-1)!.sections.map(section => section.name)).toEqual(["Around the house", "Kids", "Chores"]);
    expect(container.querySelector<HTMLInputElement>('[aria-label="New section name"]')!.value).toBe("");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("lists sections with counts, reorders them, and opens one multi-select per section", async () => {
    await render();
    expect(Array.from(container.querySelectorAll(".section-open small")).map(item => item.textContent)).toEqual(["2 assistants in section", "No assistants yet"]);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Move Kids up"]')!.click());
    expect(saved.at(-1)!.sections.map(section => section.id)).toEqual(["kids", "house"]);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-opens="section:kids"]')!.click());
    expect(title()).toBe("Kids");
    expect(container.querySelectorAll(".bot-choice")).toHaveLength(3);
    expect(choice("Ranch hand").closest("label")!.textContent).toContain("In Around the house");
    await act(async () => choice("Ranch hand").click());
    // One section per assistant: choosing it here takes it out of the other.
    expect(saved.at(-1)!.sections).toEqual([{ id: "kids", name: "Kids", botIds: ["ranch"] }, { id: "house", name: "Around the house", botIds: ["kitchen"] }]);
    await act(async () => button("Delete section").click());
    const confirm = container.querySelector('[role="alertdialog"]')!;
    await act(async () => button("Delete section", confirm).click());
    expect(saved.at(-1)!.sections).toEqual([{ id: "house", name: "Around the house", botIds: ["kitchen"] }]);
    expect(title()).toBe("Settings");
  });

  it("keeps a section on cancel and only deletes after confirmation", async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-opens="section:kids"]')!.click());
    await act(async () => button("Delete section").click());
    expect(saved).toHaveLength(0);
    expect(document.activeElement?.textContent).toBe("Keep section");
    await act(async () => button("Keep section").click());
    expect(title()).toBe("Kids");
    expect(saved).toHaveLength(0);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it.each(["back", "escape"])("saves a typed rename on %s, but keeps an invalid name open", async method => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-opens="section:kids"]')!.click());
    const name = container.querySelector<HTMLInputElement>('[aria-label="Section name"]')!;
    const leave = () => act(async () => {
      if (method === "back") container.querySelector<HTMLButtonElement>('[aria-label="Back to settings"]')!.click();
      else container.querySelector('dialog')!.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    await typeInto(name, "Around the house");
    await leave();
    expect(title()).toBe("Kids");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("already have a section");
    expect(saved).toHaveLength(0);
    await typeInto(name, "Family");
    await leave();
    expect(title()).toBe("Settings");
    expect(saved.at(-1)!.sections[1].name).toBe("Family");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("explains pinned members and stops adding at the section limit", async () => {
    props.boot.preferences = { ...props.boot.preferences, favorites: ["ranch"], sections: Array.from({ length: 30 }, (_, n) => ({ id: `s${n}`, name: `Section ${n}`, botIds: n ? [] : ["ranch", "kitchen"] })) };
    await render();
    expect(container.querySelector(".section-open small")?.textContent).toBe("1 assistant in section · 1 pinned");
    expect(container.querySelector('[aria-label="New section name"]')).toBeNull();
    expect(container.textContent).toContain("most sections home can show (30)");
    expect(props.editPreferences).not.toHaveBeenCalled();
  });

  it("renames a section and refuses a duplicate name", async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-opens="section:kids"]')!.click());
    const name = container.querySelector<HTMLInputElement>('[aria-label="Section name"]')!;
    await typeInto(name, "around the HOUSE");
    await act(async () => button("Rename").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("You already have a section called around the HOUSE.");
    expect(props.editPreferences).not.toHaveBeenCalled();
    await typeInto(name, "Family");
    await act(async () => button("Rename").click());
    expect(saved.at(-1)!.sections[1]).toEqual({ id: "kids", name: "Family", botIds: [] });
    expect(title()).toBe("Family");
  });
});

describe("following", () => {
  it("summarizes followed assistants in one row and edits them in one list, without losing quick taps", async () => {
    await render();
    expect(container.textContent).not.toContain("Follow all activity");
    const row = button("Following 1 assistantAll their activity, not only shared tasks");
    await act(async () => row.click());
    expect(title()).toBe("Following");
    expect(choice("Ranch hand").checked).toBe(true);
    // Neither save has finished; the second tap must build on the first.
    await act(async () => choice("Kitchen").click());
    await act(async () => choice("Ranch hand").click());
    expect(saved.map(value => value.followBots)).toEqual([["ranch", "kitchen"], ["kitchen"]]);
    expect(choice("Kitchen").checked).toBe(true);
    expect(choice("Ranch hand").checked).toBe(false);
    // Escape goes back a page before it closes Settings.
    await act(async () => container.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(title()).toBe("Settings");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(container.querySelector('[data-opens="following"]'));
  });
});

it("names Hermes by its commit date, or a short hash without one", async () => {
  await render();
  expect(container.querySelector(".settings-footer small")?.textContent).toBe("Hermes 0123456");
  props.boot = { ...props.boot, connection: { ...props.boot.connection, revisionDate: "2026-10-20T15:00:00Z" } };
  await render();
  const date = new Date("2026-10-20T15:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  expect(container.querySelector(".settings-footer small")?.textContent).toBe(`Hermes released ${date}`);
  expect(container.textContent).toContain(`Connected · Hermes released ${date}`);
});

describe("keyboard shortcuts row", () => {
  const row = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button.settings-row"))
    .find(item => item.querySelector(".row-label")?.textContent === "Keyboard shortcuts")!;

  it("hints at the palette shortcut only where a mouse or trackpad suggests a keyboard, and stays reachable", async () => {
    await render();
    expect(row().querySelector("small")).toBeNull();
    await act(async () => row().click());
    expect(props.onShortcuts).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    ({ container, root } = mountRoot());
    stubMatchMedia(query => query === "(any-pointer: fine)");
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await render();
    expect(row().querySelector("small")?.textContent).toBe("Press ⌘K for the command palette");
  });

  it("names Ctrl rather than Command away from Apple platforms", async () => {
    stubMatchMedia(query => query === "(any-pointer: fine)");
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    await render();
    expect(row().querySelector("small")?.textContent).toBe("Press Ctrl+K for the command palette");
  });
});
