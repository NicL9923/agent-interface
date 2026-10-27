// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BotSettings } from "../src/BotSettings";
import { api, ApiError, write } from "../src/client-api";
import { defaultPreferences } from "../src/shared/types";
import type { Bootstrap, Bot } from "../src/shared/types";
import { click, mountRoot, typeInto } from "./ui-harness";

// SVG geometry is a browser concern; these tests cover the form around the avatar.
vi.mock("../src/components/Avatar", async (original) => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  Avatar: () => createElement("span", { "data-avatar": "" }),
}));
vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async (original) => ({
  ...await original<typeof import("../src/client-api")>(),
  api: vi.fn().mockResolvedValue({}),
  write: vi.fn().mockResolvedValue({}),
}))(original)));

const bot: Bot = { instructions: "", id: "shared", name: "Shared", shared: true, model: "test", activity: "idle" };
const bootstrap: Bootstrap = {
  user: { id: "one", name: "One", email: "one@example.test" },
  household: [],
  preferences: defaultPreferences,
  bots: [bot],
  capabilities: {
    botConfiguration: { supported: true },
    tools: { supported: true },
    skills: { supported: true },
    routines: { supported: true },
  } as Bootstrap["capabilities"],
  connection: { connected: true },
  csrfToken: "test",
};
let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const onSaved = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(api).mockReset().mockResolvedValue({ providers: [], provider: "", model: "" });
  // Like a browser, closing queues a close event that arrives after the current work.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true, value: vi.fn(function (this: HTMLDialogElement) {
      if (!this.open) return;
      this.open = false;
      queueMicrotask(() => this.dispatchEvent(new Event("close")));
    }),
  });
  ({ container, root } = mountRoot());
  await act(async () => root.render(createElement(BotSettings, { bot, bootstrap, onClose, onSaved })));
  vi.mocked(api).mockClear();
});

describe.each(["tools", "skills"])("%s configuration", (tab) => {
  const saveButton = () => Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent === `Save ${tab}`)!;

  it("cannot save until the authoritative catalog arrives", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await click(tab);
    expect(saveButton().disabled).toBe(true);
    expect(container.textContent).toContain(`Loading ${tab}`);
    expect(container.textContent).not.toContain(`No ${tab} were reported`);
    await click(`Save ${tab}`);
    expect(write).not.toHaveBeenCalled();
    await act(async () => finish([{ id: "enabled", name: "Available", description: "", enabled: true }]));
    expect(saveButton().disabled).toBe(false);
    await click(`Save ${tab}`);
    expect(write).toHaveBeenCalledExactlyOnceWith(`/bots/shared/${tab}`, { ids: ["enabled"] }, "PUT");
  });

  it("keeps saving disabled after a failed read and allows an explicit retry", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Gateway unavailable"));
    await click(tab);
    expect(container.textContent).toContain("Gateway unavailable");
    expect(saveButton().disabled).toBe(true);
    await click(`Save ${tab}`);
    expect(write).not.toHaveBeenCalled();
    vi.mocked(api).mockResolvedValueOnce([]);
    await click(`Retry loading ${tab}`);
    expect(saveButton().disabled).toBe(false);
    expect(container.textContent).toContain(`No ${tab} were reported by Hermes`);
    expect(container.textContent).not.toContain("Gateway unavailable");
  });
});


describe("assistant deletion", () => {
  it("opens and cancels confirmation without submitting the settings form", async () => {
    await click("Delete assistant");
    expect(container.textContent).toContain("Delete Shared?");
    expect(write).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    await click("Keep assistant");
    expect(container.textContent).not.toContain("Delete Shared?");
    expect(write).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("confirmed deletion sends only DELETE and never saves the form", async () => {
    await click("Delete assistant");
    await click("Yes, delete");
    // The route map's DELETE reaches the mocked write; nothing else is sent.
    expect(write).toHaveBeenCalledExactlyOnceWith("/bots/shared", {}, "DELETE");
    expect(api).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

describe("making an assistant personal", () => {
  const submit = () => act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const uncheckShared = () => act(async () => container.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());

  it("asks before hiding a shared assistant from the household, and sends nothing until confirmed", async () => {
    await uncheckShared();
    expect(container.textContent).toContain("Only you see a personal assistant in WildBots. Anyone with Hermes dashboard access can still reach its memory and logins.");
    await submit();
    expect(container.textContent).toContain("It will disappear for the rest of the household");
    expect(write).not.toHaveBeenCalled();
    await click("Keep editing");
    expect(write).not.toHaveBeenCalled();
    await submit();
    await click("Make it personal");
    expect(write).toHaveBeenCalledExactlyOnceWith("/bots/shared", expect.objectContaining({ shared: false, confirmPrivate: true }), "PATCH");
    expect(container.textContent).toContain("Assistant saved.");
    expect(container.textContent).not.toContain("Changes saved for both household members.");
  });

  it("asks when the server reports the assistant is still visible to others", async () => {
    // The roster said it was already this person's, but another member shared it meanwhile.
    await act(async () => root.unmount());
    await act(async () => root.render(createElement(BotSettings, { bot: { ...bot, id: "mine", shared: false, ownerId: "one" }, bootstrap, onClose, onSaved })));
    vi.mocked(write).mockRejectedValueOnce(new ApiError("Confirm making this assistant personal.", 409, "private_confirmation_required"));
    await submit();
    expect(write).toHaveBeenCalledExactlyOnceWith("/bots/mine", expect.not.objectContaining({ confirmPrivate: true }), "PATCH");
    await click("Make it personal");
    expect(write).toHaveBeenLastCalledWith("/bots/mine", expect.objectContaining({ shared: false, confirmPrivate: true }), "PATCH");
  });

  it("asks again after the assistant is re-shared instead of reusing old consent", async () => {
    await uncheckShared(); await submit(); await click("Make it personal");
    await uncheckShared(); await submit();
    expect(write).toHaveBeenLastCalledWith("/bots/shared", expect.objectContaining({ shared: true }), "PATCH");
    expect(vi.mocked(write).mock.calls.at(-1)?.[1]).not.toHaveProperty("confirmPrivate");
    vi.mocked(write).mockClear();
    await uncheckShared(); await submit();
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain("Make Shared personal?");
    expect(write).not.toHaveBeenCalled();
  });
});

describe("settings confirmations", () => {
  const prompt = () => container.querySelector<HTMLDialogElement>('[role="alertdialog"]')!;
  const save = () => container.querySelector<HTMLButtonElement>("[data-settings-save]")!;
  const askPersonal = async () => {
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    save().focus();
    await click("Save changes");
  };

  it("focuses the safe choice and keeps Escape inside the confirmation", async () => {
    await askPersonal();
    expect(prompt().textContent).toContain("It will disappear for the rest of the household");
    expect(document.activeElement?.textContent).toBe("Keep editing");
    await act(async () => prompt().dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true })));
    expect(prompt()).toBeNull();
    expect(container.querySelector(".settings-dialog")?.hasAttribute("open")).toBe(true);
    expect(container.textContent).not.toContain("Discard your unsaved changes?");
    expect(document.activeElement).toBe(save());
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps a confirmation close event away from the unsaved editor guard", async () => {
    await askPersonal();
    await act(async () => { prompt().open = false; prompt().dispatchEvent(new Event("close", { bubbles: true })); });
    expect(prompt()).toBeNull();
    expect(container.querySelector<HTMLDialogElement>(".settings-dialog")!.open).toBe(true);
    expect(container.textContent).not.toContain("Discard your unsaved changes?");
    expect(write).not.toHaveBeenCalled();
  });

  it("puts the server's model warning inside the confirmation without a second banner", async () => {
    vi.mocked(write).mockRejectedValueOnce(new ApiError("This model has a higher price", 409, "MODEL_CONFIRMATION_REQUIRED", true));
    await click("Save changes");
    expect(prompt().textContent).toContain("This model has a higher price");
    expect(container.querySelector('[data-slot="form-message"]')).toBeNull();
    expect(document.activeElement?.textContent).toBe("Keep editing");
    await click("Keep editing");
    expect(document.activeElement).toBe(save());
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("returns focus to Delete assistant after keeping it", async () => {
    const trigger = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Delete assistant")!;
    trigger.focus();
    await click("Delete assistant");
    expect(document.activeElement?.textContent).toBe("Keep assistant");
    await click("Keep assistant");
    expect(document.activeElement).toBe(trigger);
    expect(write).not.toHaveBeenCalled();
  });

  it("confirms a model only after the explicit action", async () => {
    vi.mocked(write).mockRejectedValueOnce(new ApiError("This model has a higher price", 409, "MODEL_CONFIRMATION_REQUIRED", true));
    await click("Save changes");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith("/bots/shared", expect.objectContaining({confirmModel:false}), "PATCH");
    await click("Confirm this model");
    expect(prompt()).toBeNull();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith("/bots/shared", expect.objectContaining({confirmModel:true}), "PATCH");
  });
});

it("clears expensive-model confirmation when a different model is selected", async () => {
  vi.mocked(api).mockResolvedValueOnce([]).mockResolvedValueOnce({ provider: "provider", model: "test", providers: [
    { id: "provider", name: "Provider", authenticated: true, models: [{ id: "other", name: "Other model", available: true }] },
  ] });
  // Reload only the selector by visiting another section and returning to details.
  await click("tools");
  await click("details");
  vi.mocked(write).mockRejectedValueOnce(new ApiError("This model has a higher price", 409, "MODEL_CONFIRMATION_REQUIRED", true));
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(container.textContent).toContain("Confirm this model");
  await click("Keep editing");
  await click("Other model");
  expect(container.textContent).not.toContain("Confirm this model");
  expect(container.textContent).not.toContain("This model has a higher price");
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(write).toHaveBeenLastCalledWith("/bots/shared", expect.objectContaining({ provider: "provider", model: "other", shared: true, confirmModel: false }), "PATCH");
});

describe("closing with unsaved edits", () => {
  const dialog = () => container.querySelector("dialog")!;
  const instructions = () => container.querySelector<HTMLTextAreaElement>("#assistant-instructions")!;
  const escape = async () => {
    const event = new Event("cancel", { cancelable: true });
    await act(async () => dialog().dispatchEvent(event));
    return event;
  };
  const edit = (value = "Rewritten from scratch") => typeInto(instructions(), value);

  it("closes on Escape without asking when nothing changed", async () => {
    const event = await escape();
    expect(event.defaultPrevented).toBe(false);
    expect(container.textContent).not.toContain("Discard your unsaved changes?");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks on Escape after an edit and keeps the edit when told to keep editing", async () => {
    await edit();
    const event = await escape();
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Discard your unsaved changes?");
    expect(document.activeElement?.textContent).toBe("Keep editing");
    await click("Keep editing");
    expect(container.textContent).not.toContain("Discard your unsaved changes?");
    expect(instructions().value).toBe("Rewritten from scratch");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("discards only after confirmation, from either way of closing", async () => {
    await edit();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close assistant settings"]')!.click());
    expect(onClose).not.toHaveBeenCalled();
    await click("Discard changes");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stops asking once an edit is reverted", async () => {
    await edit();
    await edit("");
    await escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("treats saved details as the new baseline", async () => {
    await edit();
    await click("Save changes");
    expect(write).toHaveBeenCalledWith("/bots/shared", expect.objectContaining({ instructions: "Rewritten from scratch" }), "PATCH");
    await escape();
    expect(container.textContent).not.toContain("Discard your unsaved changes?");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses the saved name in the heading and confirmations after a rename", async () => {
    const heading = () => container.querySelector("#assistant-settings-title")!.textContent;
    await typeInto(container.querySelector<HTMLInputElement>('form input[maxlength="100"]')!, "Garden companion");
    expect(heading()).toBe("Shared");
    vi.mocked(write).mockRejectedValueOnce(new Error("Gateway unavailable"));
    await click("Save changes");
    expect(heading()).toBe("Shared");
    await click("Save changes");
    expect(heading()).toBe("Garden companion");
    await click("Delete assistant");
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain("Delete Garden companion?");
  });

  it("keeps the baseline when a save fails", async () => {
    await edit();
    vi.mocked(write).mockRejectedValueOnce(new Error("Gateway unavailable"));
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await escape();
    expect(container.textContent).toContain("Discard your unsaved changes?");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("treats an unsaved avatar change as an edit until it is saved", async () => {
    await click("avatar");
    await act(async () => container.querySelector<HTMLInputElement>('input[type="radio"]:not(:checked)')!.click());
    await escape();
    expect(container.textContent).toContain("Discard your unsaved changes?");
    await click("Keep editing");
    await click("Save avatar");
    expect(write).toHaveBeenCalledWith("/bots/shared/avatar", expect.anything(), "PUT");
    await escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reopens the dialog when the browser closes it without a cancelable Escape", async () => {
    await edit();
    vi.mocked(HTMLDialogElement.prototype.showModal).mockClear();
    dialog().open = false;
    await act(async () => dialog().dispatchEvent(new Event("close")));
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Discard your unsaved changes?");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("preserves the original opener after recovering from a noncancelable close", async () => {
    await act(async () => root.unmount());
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    await act(async () => root.render(createElement(BotSettings, { bot, bootstrap, onClose, onSaved })));
    await edit();
    instructions().focus();
    dialog().open = false;
    await act(async () => dialog().dispatchEvent(new Event("close")));
    expect(dialog().open).toBe(true);
    expect(document.activeElement?.textContent).toBe("Keep editing");
    await click("Keep editing");
    expect(document.activeElement).toBe(instructions());
    await act(async () => root.unmount());
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("returns focus to the control that was focused before the prompt", async () => {
    await edit();
    instructions().focus();
    await escape();
    expect(document.activeElement?.textContent).toBe("Keep editing");
    await click("Keep editing");
    expect(document.activeElement).toBe(instructions());
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close assistant settings"]')!;
    close.focus();
    await act(async () => close.click());
    await click("Keep editing");
    expect(document.activeElement).toBe(close);
  });

  it("falls back to the heading when nothing in the dialog held focus", async () => {
    await edit();
    (document.activeElement as HTMLElement).blur();
    await escape();
    await click("Keep editing");
    expect(document.activeElement).toBe(container.querySelector("#assistant-settings-title"));
  });

  it.each(["tools", "skills"])("asks about %s toggled but not yet saved", async (tab) => {
    vi.mocked(api).mockResolvedValueOnce([{ id: "one", name: "One", description: "", enabled: true }]);
    await click(tab);
    await escape();
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await escape();
    expect(container.textContent).toContain("Discard your unsaved changes?");
    expect(onClose).not.toHaveBeenCalled();
    await click("Keep editing");
    await click(`Save ${tab}`);
    expect(write).toHaveBeenCalledWith(`/bots/shared/${tab}`, { ids: [] }, "PUT");
    await escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("survives Strict Mode closing and reopening the dialog while it mounts", async () => {
    await act(async () => root.unmount());
    await act(async () => root.render(createElement(StrictMode, null, createElement(BotSettings, { bot, bootstrap, onClose, onSaved }))));
    await act(async () => { await Promise.resolve(); });
    expect(dialog().open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns focus to the rail when the opener was never focused, as in WebKit after a click", async () => {
    const rail = document.createElement("nav");
    rail.className = "bot-rail";
    rail.innerHTML = '<button aria-label="Settings"></button>';
    document.body.append(rail);
    await act(async () => root.unmount());
    (document.activeElement as HTMLElement).blur();
    await act(async () => root.render(createElement(BotSettings, { bot, bootstrap, onClose, onSaved })));
    await act(async () => root.unmount());
    expect(document.activeElement).toBe(rail.querySelector("button"));
    rail.remove();
  });

  it("prefers the conversation's assistant button when the opener was never focused", async () => {
    const rail = document.createElement("nav");
    rail.className = "bot-rail";
    rail.innerHTML = '<button aria-label="Settings"></button>';
    const header = document.createElement("header");
    header.innerHTML = '<button class="chat-identity"></button>';
    document.body.append(rail, header);
    await act(async () => root.unmount());
    (document.activeElement as HTMLElement).blur();
    await act(async () => root.render(createElement(BotSettings, { bot, bootstrap, onClose, onSaved })));
    await act(async () => root.unmount());
    expect(document.activeElement).toBe(header.querySelector("button"));
    rail.remove(); header.remove();
  });

  it("skips a fallback control on a screen the phone has made inert", async () => {
    const rail = document.createElement("nav");
    rail.className = "bot-rail";
    rail.innerHTML = '<button aria-label="Settings"></button>';
    const main = document.createElement("main");
    main.setAttribute("inert", "");
    main.innerHTML = '<button class="chat-identity"></button>';
    document.body.append(rail, main);
    await act(async () => root.unmount());
    (document.activeElement as HTMLElement).blur();
    await act(async () => root.render(createElement(BotSettings, { bot, bootstrap, onClose, onSaved })));
    await act(async () => root.unmount());
    expect(document.activeElement).toBe(rail.querySelector("button"));
    rail.remove(); main.remove();
  });

  it("keeps staged tool choices, and the prompt that protects them, across a visit to another section", async () => {
    vi.mocked(api).mockResolvedValueOnce([{ id: "one", name: "One", description: "", enabled: true }]);
    await click("tools");
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    vi.mocked(api).mockResolvedValueOnce([]);
    await click("skills");
    vi.mocked(api).mockClear();
    await click("tools");
    expect(vi.mocked(api).mock.calls.map(([path]) => path)).not.toContain("/bots/shared/tools");
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    await escape();
    expect(container.textContent).toContain("Discard your unsaved changes?");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns focus to the control that opened it", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    await act(async () => root.unmount());
    opener.focus();
    await act(async () => root.render(createElement(BotSettings, { bot, bootstrap, onClose, onSaved })));
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => root.unmount());
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe("compact settings navigation", () => {
  const compact = async () => {
    const media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    await act(async () => {
      root.unmount();
      root.render(createElement(BotSettings, { bot, bootstrap, onClose, onSaved }));
    });
    return media;
  };

  it("uses a single disclosure for secondary sections and keeps the selected section visible", async () => {
    await compact();
    const nav = container.querySelector<HTMLElement>('[aria-label="Settings sections"]')!;
    expect(Array.from(nav.children).map((child) => child.tagName)).toEqual(["BUTTON", "BUTTON", "DETAILS"]);
    const menu = nav.querySelector("details")!;
    const summary = nav.querySelector("summary")!;
    expect(summary.textContent).toBe("More");
    menu.open = true;
    const tools = Array.from(menu.querySelectorAll("button")).find((button) => button.textContent === "tools")!;
    vi.mocked(api).mockResolvedValueOnce([]);
    await act(async () => tools.click());
    expect(menu.open).toBe(false);
    expect(summary.textContent).toBe("tools");
    expect(summary.getAttribute("aria-current")).toBe("page");
    expect(document.activeElement).toBe(summary);
    expect(nav.querySelectorAll('button[aria-current="page"]')).toHaveLength(1);
    expect(container.textContent).toContain("Save tools");
  });

  it("Escape closes the overflow and restores focus without closing assistant settings", async () => {
    await compact();
    const menu = container.querySelector<HTMLDetailsElement>(".settings-tabs-overflow")!;
    const summary = menu.querySelector("summary")!;
    menu.open = true;
    menu.querySelector("button")!.focus();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => menu.querySelector("button")!.dispatchEvent(escape));
    expect(menu.open).toBe(false);
    expect(escape.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(summary);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("updates navigation on viewport changes and cleans up its media listener", async () => {
    const media = await compact();
    const changed = media.addEventListener.mock.calls[0][1] as () => void;
    expect(container.querySelector(".settings-tabs-overflow")).not.toBeNull();
    media.matches = false;
    await act(async () => changed());
    const nav = container.querySelector('[aria-label="Settings sections"]')!;
    expect(nav.querySelector("details")).toBeNull();
    expect(Array.from(nav.querySelectorAll("button")).map(button => button.textContent)).toContain("logins");
    expect(nav.querySelectorAll("button")).toHaveLength(10);
    await act(async () => root.unmount());
    expect(media.removeEventListener).toHaveBeenCalledWith("change", changed);
  });
});

it("shows saving and saved on the avatar button itself, then resets", async () => {
  vi.useFakeTimers();
  try {
    const avatarTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="Settings sections"] button')).find(button => button.textContent === "avatar")!;
    await act(async () => avatarTab.click());
    let finish!: () => void;
    vi.mocked(write).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({}); }));
    const save = () => container.querySelector<HTMLButtonElement>(".sticky-actions .primary")!;
    expect(save().textContent).toBe("Save avatar");
    await act(async () => save().click());
    expect(save().textContent).toBe("Saving…");
    expect(save().disabled).toBe(true);
    await act(async () => finish());
    expect(save().textContent).toBe("Saved");
    expect(write).toHaveBeenCalledWith("/bots/shared/avatar", expect.anything(), "PUT");
    await act(async () => vi.advanceTimersByTimeAsync(2600));
    expect(save().textContent).toBe("Save avatar");
  } finally { vi.useRealTimers(); }
});

it("offers only the owner as a recipient of a private assistant's routines", async () => {
  const household = [{ id: "one", name: "One", email: "one@example.test" }, { id: "two", name: "Two", email: "two@example.test" }];
  const recipients = async (assistant: Bot) => {
    await act(async () => root.unmount());
    vi.mocked(api).mockImplementation(async (path: string) => (path === "/routines" ? [] : { providers: [], provider: "", model: "" }) as never);
    await act(async () => root.render(createElement(BotSettings, { bot: assistant, bootstrap: { ...bootstrap, household, bots: [assistant] }, onClose, onSaved })));
    await click("routines");
    return Array.from(container.querySelectorAll("fieldset label")).map(label => label.textContent);
  };
  expect(await recipients({ ...bot, id: "mine", shared: false, ownerId: "one" })).toEqual(["One"]);
  expect(await recipients(bot)).toEqual(["One", "Two"]);
});

it("loads roster detail before showing a writable settings form", async () => {
  let finish!: (value: Bot) => void;
  vi.mocked(api).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  await act(async()=>root.render(createElement(BotSettings,{bot:{...bot,instructions:undefined},bootstrap,onClose,onSaved})));
  expect(container.querySelector("form")).toBeNull();
  await act(async()=>finish({...bot,instructions:"Saved instructions",enabledMcpServers:["calendar"]}));
  expect(container.querySelector<HTMLTextAreaElement>("#assistant-instructions")!.value).toBe("Saved instructions");
});


describe("lean roster settings", () => {
  it("keeps one dialog, retries detail, and PATCHes only loaded configuration without reloading on roster refresh", async () => {
    await act(async () => root.unmount());
    const { instructions, ...lean } = bot;
    let finish!: (value: Bot) => void;
    vi.mocked(api).mockRejectedValueOnce(new Error("Detail unavailable"));
    await act(async () => root.render(createElement(BotSettings, { bot: lean, bootstrap, onClose, onSaved })));
    const dialog = container.querySelector("dialog")!;
    const heading = dialog.querySelector("#assistant-settings-title")!;
    const close = dialog.querySelector('[aria-label="Close assistant settings"]')!;
    expect(container.textContent).toContain("Detail unavailable");
    expect(container.querySelector("form")).toBeNull();
    expect(write).not.toHaveBeenCalled();
    vi.mocked(api).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await click("Retry settings");
    expect(document.activeElement).toBe(heading);
    expect(container.querySelector("dialog")).toBe(dialog);
    expect(container.querySelector("form")).toBeNull();
    await act(async () => finish({ ...lean, instructions: "Keep this saved SOUL", enabledMcpServers: ["calendar"] }));
    expect(container.querySelector("dialog")).toBe(dialog);
    expect(dialog.querySelector("#assistant-settings-title")).toBe(heading);
    expect(dialog.querySelector('[aria-label="Close assistant settings"]')).toBe(close);
    expect(document.activeElement).toBe(heading);
    expect((container.querySelector("#assistant-instructions") as HTMLTextAreaElement).value).toBe("Keep this saved SOUL");
    vi.mocked(api).mockClear();
    await act(async () => root.render(createElement(BotSettings, { bot: { ...lean, activity: "working" }, bootstrap, onClose, onSaved })));
    expect(api).not.toHaveBeenCalled();
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(write).toHaveBeenCalledWith("/bots/shared", expect.objectContaining({ instructions: "Keep this saved SOUL", enabledMcpServers: ["calendar"] }), "PATCH");
    const payload = vi.mocked(write).mock.calls.at(-1)![1];
    expect(payload).not.toHaveProperty("enabledTools");
    expect(payload).not.toHaveProperty("enabledSkills");
  });
});

describe("creating an assistant", () => {
  const created: Bot = { id: "ranch-hand", name: "Ranch hand", shared: true, model: "test", activity: "idle", instructions: "" };
  // Unlike the shared button helper, a missing button is a valid answer here.
  const button = (text: string) => Array.from(container.querySelectorAll("button")).find(item => (item.getAttribute("aria-label") || item.textContent) === text);
  const title = () => container.querySelector("#assistant-settings-title")?.textContent;
  const type = (value: string) => typeInto(container.querySelector<HTMLInputElement>("#create-name")!, value);
  const choose = (label: string) => act(async () => Array.from(container.querySelectorAll("label"))
    .find(item => item.textContent?.trim() === label)!.querySelector("input")!.click());
  beforeEach(async () => {
    await act(async () => root.render(createElement(BotSettings, { bot: "new", bootstrap, onClose, onSaved })));
  });
  const toRole = async (name = "Ranch hand") => {
    await type(name);
    await choose("Mascot");
    await act(async () => button("Next: role and model")!.click());
  };

  it("starts with name and look, and hides sections that need an existing assistant", async () => {
    expect(title()).toBe("Name and look");
    expect(container.querySelector('[aria-label="Settings sections"]')).toBeNull();
    expect(container.textContent).not.toContain("Create the assistant before");
    await act(async () => button("Next: role and model")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Give your assistant a name.");
    await type(" shared ");
    await act(async () => button("Next: role and model")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("An assistant with this name already exists. Choose another name.");
    expect(title()).toBe("Name and look");
    await toRole();
    expect(title()).toBe("Role and model");
    await act(async () => button("Back")!.click());
    // Going back keeps every choice.
    expect(container.querySelector<HTMLInputElement>("#create-name")!.value).toBe("Ranch hand");
    expect(Array.from(container.querySelectorAll("label")).find(item => item.textContent?.trim() === "Mascot")!.querySelector("input")!.checked).toBe(true);
  });

  it("creates the assistant, then saves the chosen avatar, then closes", async () => {
    vi.mocked(write).mockImplementation(async <T,>(path: string) => (path === "/bots" ? created : {}) as T);
    await toRole();
    await act(async () => button("Create assistant")!.click());
    expect(vi.mocked(write).mock.calls.map(([path, , method]) => [path, method])).toEqual([["/bots", undefined], ["/bots/ranch-hand/avatar", "PUT"]]);
    expect(vi.mocked(write).mock.calls[0][1]).toMatchObject({ name: "Ranch hand", model: "test" });
    expect(vi.mocked(write).mock.calls[1][1]).toMatchObject({ mode: "mascot" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalled();
  });

  it("keeps the avatar to retry, editing the created assistant, when only the avatar fails", async () => {
    let avatarFails = true;
    vi.mocked(write).mockImplementation(async <T,>(path: string) => {
      if (path === "/bots") return created as T;
      if (avatarFails) throw new Error("Hermes is restarting.");
      return {} as T;
    });
    await toRole();
    await act(async () => button("Create assistant")!.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
    expect(title()).toBe("Ranch hand");
    expect(container.querySelector(".avatar-failure")?.textContent).toContain("Ranch hand was created, but its avatar didn't save: Hermes is restarting.");
    // Now it exists, so its sections appear, opened on the avatar it still needs.
    expect(container.querySelector('[aria-label="Settings sections"] [aria-current="page"]')?.textContent).toBe("avatar");
    avatarFails = false;
    await act(async () => button("Retry avatar")!.click());
    expect(vi.mocked(write).mock.calls.filter(([path]) => path === "/bots")).toHaveLength(1);
    expect(vi.mocked(write).mock.lastCall).toEqual(["/bots/ranch-hand/avatar", expect.objectContaining({ mode: "mascot" }), "PUT"]);
    expect(container.querySelector(".avatar-failure")).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Avatar saved");
  });
});


describe("existing assistant portraits", () => {
  const choose = async (name: string) => {
    const label = [...container.querySelectorAll("label")].find(item => item.textContent?.trim() === name)!;
    await act(async () => label.querySelector("input")!.click());
  };
  beforeEach(async () => {
    const supported = { ...bootstrap, capabilities: { ...bootstrap.capabilities, uploads: { supported: true }, portraitGeneration: { supported: true } } };
    await act(async () => root.render(createElement(BotSettings, { bot, bootstrap: supported, onClose, onSaved })));
    await click("avatar"); await choose("Portrait"); vi.mocked(api).mockClear();
  });
  const upload = async (file: File) => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    Object.defineProperty(input, "value", { configurable: true, writable: true, value: "C:\\fakepath\\portrait.png" });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    return input;
  };
  it.each([new File(["bad"], "portrait.txt", { type: "text/plain" }), new File([new Uint8Array(2_000_001)], "portrait.png", { type: "image/png" })])("rejects invalid files without submitting or enabling Save", async file => {
    await upload(file);
    expect(api).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Choose a PNG, JPEG, or WebP portrait no larger than 2 MB.");
    expect([...container.querySelectorAll("button")].find(button => button.textContent === "Save avatar")!.disabled).toBe(true);
  });
  it("clears the file input after failure so choosing the same file can retry", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Upload interrupted."));
    const file = new File(["png"], "portrait.png", { type: "image/png" });
    const input = await upload(file);
    expect(input.value).toBe("");
    expect(container.textContent).toContain("Upload interrupted.");
    vi.mocked(api).mockResolvedValueOnce({ id: "portrait-1" });
    await upload(file); await click("Save avatar");
    expect(write).toHaveBeenLastCalledWith("/bots/shared/avatar", { mode: "portrait", src: "/api/files/portrait-1", origin: "uploaded" }, "PUT");
  });
  it("generates from the prompt, shows progress and saves the resulting draft", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(write).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await typeInto(container.querySelector<HTMLTextAreaElement>('textarea')!, "A friendly ranch companion");
    await click("Generate portrait");
    expect([...container.querySelectorAll('.avatar-operation[role="status"]')].some(region => region.textContent?.includes("Generating portrait…"))).toBe(true);
    expect(write).toHaveBeenCalledWith("/bots/shared/portrait", { prompt: "A friendly ranch companion" });
    await act(async () => finish({ id: "generated-1" }));
    await click("Save avatar");
    expect(write).toHaveBeenLastCalledWith("/bots/shared/avatar", { mode: "portrait", src: "/api/files/generated-1", origin: "generated" }, "PUT");
  });
  it("explains unavailable portrait operations and disables them even with a prompt", async () => {
    const unsupported = { ...bootstrap, capabilities: { ...bootstrap.capabilities, uploads: { supported: false, reason: "Uploads unavailable." }, portraitGeneration: { supported: false, reason: "Generation unavailable." } } };
    await act(async () => root.render(createElement(BotSettings, { bot, bootstrap: unsupported, onClose, onSaved })));
    await typeInto(container.querySelector<HTMLTextAreaElement>('textarea')!, "A friendly ranch companion");
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(true);
    await click("Generate portrait");
    expect(write).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Uploads unavailable.");
    expect(container.textContent).toContain("Generation unavailable.");
    expect(container.textContent).toContain("Choose Geometric or Mascot.");
  });
  it("blocks a description over the server limit while keeping it editable", async () => {
    await typeInto(container.querySelector<HTMLTextAreaElement>('textarea')!, "x".repeat(2001));
    await click("Generate portrait");
    expect(api).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')?.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("The description is 1 character over the 2,000 limit. Shorten the text to generate a portrait.");
  });
});
