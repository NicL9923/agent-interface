// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { preparePortrait } from "../src/portrait-upload";
import { BotSettings } from "../src/BotSettings";
import { api, ApiError, write } from "../src/client-api";
import { defaultPreferences } from "../src/shared/types";
import type { Bootstrap, Bot } from "../src/shared/types";
import { button, click, mountRoot, stubImmediateFrames, typeInto } from "./ui-harness";

// jsdom decodes no image and has no canvas, so the real resize and PNG encode cannot run; the upload and error paths around it do.
vi.mock("../src/portrait-upload", () => ({ preparePortrait: vi.fn(async (file: File) => file) }));

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async (original) => ({
  ...await original<typeof import("../src/client-api")>(),
  api: vi.fn().mockResolvedValue({}),
  write: vi.fn().mockResolvedValue({}),
}))(original)));

const bot: Bot = { instructions: "", id: "shared", name: "Shared", shared: true, model: "test", activity: "idle", enabledMcpServers: [] };
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
const onCreated = vi.fn();

/**
 * GET responses by path, so each section can load in any order. A value that is a function is
 * called for every read; tests replace entries for what they cover.
 */
let routes: Map<string, unknown>;
const serve = (path: string, value: unknown) => routes.set(path, value);
// What an installation with nothing configured answers, for any assistant.
const unsupported = { supported: false };
const empty: [RegExp, unknown][] = [
  [/^\/models$/, { providers: [], provider: "", model: "" }],
  [/^\/bots\/[^/]+\/(tools|skills)$/, []],
  [/^\/bots\/[^/]+\/automation$/, { owner: "Hermes", goals: { ...unsupported, goal: null }, tasks: { ...unsupported, items: [] },
    triggers: { ...unsupported, items: [], platformEnabled: false }, skills: { ...unsupported, installed: [], pending: [], approvalRequired: false } }],
  [/^\/bots\/[^/]+\/vault$/, { scope: "profile", owner: "Hermes", notice: "", items: [], sources: [] }],
  [/^\/integrations$/, { canManage: false, connections: [] }],
  [/^\/routines$/, []],
];
function answer(path: string) {
  const key = path.split("?")[0];
  const value = routes.has(path) ? routes.get(path) : routes.has(key) ? routes.get(key) : empty.find(([pattern]) => pattern.test(key))?.[1] ?? {};
  return typeof value === "function" ? (value as () => unknown)() : value;
}
const paths = () => vi.mocked(api).mock.calls.map(([path]) => String(path).split("?")[0]);
const saveButton = () => container.querySelector<HTMLButtonElement>("[data-settings-save]")!;
const checkbox = (label: string) => Array.from(container.querySelectorAll("label"))
  .find(item => item.textContent?.trim().startsWith(label))!.querySelector<HTMLInputElement>("input")!;
const submit = () => act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
const editInstructions = async (value = "Rewritten from scratch") => {
  if (!container.querySelector("#assistant-instructions")) await click("Behavior");
  await typeInto(container.querySelector<HTMLTextAreaElement>("#assistant-instructions")!, value);
};
const render = (props: Partial<Parameters<typeof BotSettings>[0]> = {}) =>
  act(async () => root.render(createElement(BotSettings, { bot, bootstrap, onClose, onSaved, ...props })));

beforeEach(async () => {
  vi.clearAllMocks();
  routes = new Map<string, unknown>();
  vi.mocked(api).mockReset().mockImplementation(async (path: string) => answer(path) as never);
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


describe("sections", () => {
  it("offers five sections and opens on Profile", () => {
    const nav = container.querySelector('[aria-label="Settings sections"]')!;
    expect(Array.from(nav.querySelectorAll("button")).map(item => item.textContent)).toEqual(["Profile", "Behavior", "Access", "Automation", "Memory & learning"]);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Profile");
    expect(container.querySelector<HTMLInputElement>('form input[maxlength="100"]')!.value).toBe("Shared");
    expect(container.textContent).toContain("Delete assistant");
  });

  it("disables Save changes until something changes", async () => {
    expect(saveButton().disabled).toBe(true);
    await click("Save changes");
    expect(write).not.toHaveBeenCalled();
    await editInstructions();
    expect(saveButton().disabled).toBe(false);
  });
});

describe.each(["tools", "skills"])("%s in Behavior", (kind) => {
  const row = (name: string) => Array.from(container.querySelectorAll<HTMLElement>(`.catalog-editor[aria-label="${kind === "tools" ? "Tools" : "Skills"}"] .capability-item`))
    .find(item => item.textContent?.includes(name))!;

  it("cannot change choices until the authoritative catalog arrives, then saves them with Save changes", async () => {
    let finish!: (value: unknown) => void;
    serve(`/bots/shared/${kind}`, new Promise(resolve => { finish = resolve; }));
    await click("Behavior");
    expect(container.textContent).toContain(`Loading ${kind}`);
    expect(container.textContent).not.toContain(`No ${kind} were reported`);
    await act(async () => finish([{ id: "enabled", name: "Available", description: "", enabled: true }]));
    expect(saveButton().disabled).toBe(true);
    await act(async () => row("Available").querySelector("input")!.click());
    await click("Save changes");
    expect(write).toHaveBeenCalledExactlyOnceWith(`/bots/shared/${kind}`, { ids: [] }, "PUT");
  });

  it("explains a failed read and allows an explicit retry", async () => {
    serve(`/bots/shared/${kind}`, () => Promise.reject(new Error("Gateway unavailable")));
    await click("Behavior");
    expect(container.textContent).toContain("Gateway unavailable");
    serve(`/bots/shared/${kind}`, []);
    await click(`Retry loading ${kind}`);
    expect(container.textContent).toContain(`No ${kind} were reported by Hermes`);
    expect(container.textContent).not.toContain("Gateway unavailable");
  });
});

it("keeps required skills enabled when Hermes reports them disabled", async () => {
  serve("/bots/shared/skills", [
    { id: "required", name: "required", description: "Required by Hermes", required: true, enabled: false },
    { id: "optional", name: "optional", description: "Hermes profile skill", enabled: false },
  ]);
  await click("Behavior");
  const required = checkbox("required");
  expect(required.checked).toBe(true);
  expect(required.disabled).toBe(true);
  expect(container.textContent?.match(/Required by Hermes/g)).toHaveLength(1);
  await act(async () => checkbox("optional").click());
  await click("Save changes");
  expect(write).toHaveBeenCalledExactlyOnceWith("/bots/shared/skills", { ids: ["required", "optional"] }, "PUT");
});

describe("one Save changes", () => {
  it("saves each changed part in order and, after a failure, sends only what is still unsaved", async () => {
    serve("/bots/shared/tools", [{ id: "web", name: "Web search", description: "", enabled: true }]);
    await act(async () => container.querySelector<HTMLInputElement>('input[type="radio"]:not(:checked)')!.click());
    await editInstructions("New instructions");
    await act(async () => checkbox("Web search").click());
    vi.mocked(write).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Hermes is restarting."));
    await click("Save changes");
    expect(vi.mocked(write).mock.calls.map(([path, , method]) => [path, method])).toEqual([["/bots/shared", "PATCH"], ["/bots/shared/avatar", "PUT"]]);
    expect(container.textContent).toContain("Hermes is restarting.");
    vi.mocked(write).mockClear();
    await click("Save changes");
    expect(vi.mocked(write).mock.calls.map(([path, , method]) => [path, method])).toEqual([["/bots/shared/avatar", "PUT"], ["/bots/shared/tools", "PUT"]]);
    expect(saveButton().disabled).toBe(true);
  });

  it("shows saving and saved on the button itself, then resets", async () => {
    await editInstructions();
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      vi.mocked(write).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({}); }));
      await act(async () => saveButton().click());
      expect(saveButton().textContent).toBe("Saving…");
      expect(saveButton().disabled).toBe(true);
      await act(async () => finish());
      expect(saveButton().textContent).toBe("Saved");
      await act(async () => vi.advanceTimersByTimeAsync(2600));
      expect(saveButton().textContent).toBe("Save changes");
    } finally { vi.useRealTimers(); }
  });

  it("appears on other sections only while changes are unsaved", async () => {
    await click("Automation");
    expect(saveButton()).toBeNull();
    await editInstructions();
    await click("Automation");
    expect(saveButton().disabled).toBe(false);
  });
});

it("refuses to save an empty name from any section and takes you to it", async () => {
  await typeInto(container.querySelector<HTMLInputElement>("#assistant-name")!, "  ");
  await editInstructions();
  await click("Save changes");
  expect(write).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Settings sections"] [aria-current="page"]')?.textContent).toBe("Profile");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Give your assistant a name.");
  expect(document.activeElement).toBe(container.querySelector("#assistant-name"));
});

describe("assistant deletion", () => {
  it("opens and cancels confirmation without submitting the settings form", async () => {
    await click("Delete assistant");
    expect(container.textContent).toContain("Delete Shared?");
    await click("Keep assistant");
    expect(container.textContent).not.toContain("Delete Shared?");
    expect(write).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("confirmed deletion sends only DELETE and never saves the form", async () => {
    await click("Delete assistant");
    await click("Yes, delete");
    expect(write).toHaveBeenCalledExactlyOnceWith("/bots/shared", {}, "DELETE");
    expect(api).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

describe("making an assistant personal", () => {
  const uncheckShared = () => act(async () => checkbox("Shared with your household").click());

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
    ({ container, root } = mountRoot());
    await render({ bot: { ...bot, id: "mine", shared: false, ownerId: "one" } });
    vi.mocked(write).mockRejectedValueOnce(new ApiError("Confirm making this assistant personal.", 409, "private_confirmation_required"));
    await editInstructions("Updated");
    await click("Save changes");
    expect(write).toHaveBeenCalledExactlyOnceWith("/bots/mine", expect.not.objectContaining({ confirmPrivate: true }), "PATCH");
    await click("Make it personal");
    expect(write).toHaveBeenLastCalledWith("/bots/mine", expect.objectContaining({ shared: false, confirmPrivate: true }), "PATCH");
  });

  it("reloads what the server saved when sharing ended main but Hermes kept the check-in, and says why", async () => {
    await act(async () => root.unmount());
    ({ container, root } = mountRoot());
    await render({ bot: { ...bot, id: "mine", shared: false, ownerId: "one" }, bootstrap: { ...bootstrap, preferences: { ...bootstrap.preferences, mainBotId: "mine" } } });
    vi.mocked(write).mockRejectedValueOnce(new ApiError("Hermes hasn't removed this assistant's check-ins yet, so it stays personal.", 502, "check_in_removal_pending", undefined,
      { code: "check_in_removal_pending", preferences: { ...bootstrap.preferences, mainBotId: undefined } }));
    await act(async () => checkbox("Shared with your household").click());
    await click("Save changes");
    await click("Share it");
    expect(write).toHaveBeenLastCalledWith("/bots/mine", expect.objectContaining({ shared: true, confirmMainCleared: true }), "PATCH");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("so it stays personal");
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
  const askPersonal = async () => {
    await act(async () => checkbox("Shared with your household").click());
    saveButton().focus();
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
    expect(document.activeElement).toBe(saveButton());
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
    await editInstructions();
    vi.mocked(write).mockRejectedValueOnce(new ApiError("This model has a higher price", 409, "MODEL_CONFIRMATION_REQUIRED", true));
    await click("Save changes");
    expect(prompt().textContent).toContain("This model has a higher price");
    expect(container.querySelector('[data-slot="form-message"]')).toBeNull();
    expect(document.activeElement?.textContent).toBe("Keep editing");
    await click("Keep editing");
    expect(document.activeElement).toBe(saveButton());
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

  it("confirms a model only after the explicit action, then finishes the whole save", async () => {
    serve("/bots/shared/tools", [{ id: "web", name: "Web search", description: "", enabled: true }]);
    await editInstructions();
    await act(async () => checkbox("Web search").click());
    vi.mocked(write).mockRejectedValueOnce(new ApiError("This model has a higher price", 409, "MODEL_CONFIRMATION_REQUIRED", true));
    await click("Save changes");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith("/bots/shared", expect.objectContaining({ confirmModel: false }), "PATCH");
    await click("Confirm this model");
    expect(prompt()).toBeNull();
    expect(vi.mocked(write).mock.calls.slice(1).map(([path, body]) => [path, (body as { confirmModel?: boolean }).confirmModel])).toEqual([["/bots/shared", true], ["/bots/shared/tools", undefined]]);
  });
});

it("clears expensive-model confirmation when a different model is selected", async () => {
  serve("/models", { provider: "provider", model: "test", providers: [
    { id: "provider", name: "Provider", authenticated: true, models: [{ id: "other", name: "Other model", available: true }] },
  ] });
  await editInstructions();
  vi.mocked(write).mockRejectedValueOnce(new ApiError("This model has a higher price", 409, "MODEL_CONFIRMATION_REQUIRED", true));
  await submit();
  expect(container.textContent).toContain("Confirm this model");
  await click("Keep editing");
  await click("Other model");
  expect(container.textContent).not.toContain("Confirm this model");
  expect(container.textContent).not.toContain("This model has a higher price");
  await submit();
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

  it("closes on Escape without asking when nothing changed", async () => {
    const event = await escape();
    expect(event.defaultPrevented).toBe(false);
    expect(container.textContent).not.toContain("Discard your unsaved changes?");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks on Escape after an edit and keeps the edit when told to keep editing", async () => {
    await editInstructions();
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
    await editInstructions();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close assistant settings"]')!.click());
    expect(onClose).not.toHaveBeenCalled();
    await click("Discard changes");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stops asking once an edit is reverted", async () => {
    await editInstructions();
    await editInstructions("");
    await escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("treats saved changes as the new baseline", async () => {
    await editInstructions();
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
    await editInstructions();
    vi.mocked(write).mockRejectedValueOnce(new Error("Gateway unavailable"));
    await submit();
    await escape();
    expect(container.textContent).toContain("Discard your unsaved changes?");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("treats an unsaved avatar change as an edit until it is saved", async () => {
    await act(async () => container.querySelector<HTMLInputElement>('input[type="radio"]:not(:checked)')!.click());
    await escape();
    expect(container.textContent).toContain("Discard your unsaved changes?");
    await click("Keep editing");
    await click("Save changes");
    expect(write).toHaveBeenCalledExactlyOnceWith("/bots/shared/avatar", expect.anything(), "PUT");
    await escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reopens the dialog when the browser closes it without a cancelable Escape", async () => {
    await editInstructions();
    vi.mocked(HTMLDialogElement.prototype.showModal).mockClear();
    dialog().open = false;
    await act(async () => dialog().dispatchEvent(new Event("close")));
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Discard your unsaved changes?");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("preserves the original opener after recovering from a noncancelable close", async () => {
    await act(async () => root.unmount());
    ({ container, root } = mountRoot());
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    await render();
    await editInstructions();
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
    await editInstructions();
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
    await editInstructions();
    (document.activeElement as HTMLElement).blur();
    await escape();
    await click("Keep editing");
    expect(document.activeElement).toBe(container.querySelector("#assistant-settings-title"));
  });

  it.each(["tools", "skills"])("asks about %s toggled but not yet saved", async (kind) => {
    serve(`/bots/shared/${kind}`, [{ id: "one", name: "One", description: "", enabled: true }]);
    await click("Behavior");
    await escape();
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();
    await act(async () => checkbox("One").click());
    await escape();
    expect(container.textContent).toContain("Discard your unsaved changes?");
    expect(onClose).not.toHaveBeenCalled();
    await click("Keep editing");
    await click("Save changes");
    expect(write).toHaveBeenCalledWith(`/bots/shared/${kind}`, { ids: [] }, "PUT");
    await escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("survives Strict Mode closing and reopening the dialog while it mounts", async () => {
    await act(async () => root.unmount());
    ({ container, root } = mountRoot());
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
    ({ container, root } = mountRoot());
    (document.activeElement as HTMLElement).blur();
    await render();
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
    ({ container, root } = mountRoot());
    (document.activeElement as HTMLElement).blur();
    await render();
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
    ({ container, root } = mountRoot());
    (document.activeElement as HTMLElement).blur();
    await render();
    await act(async () => root.unmount());
    expect(document.activeElement).toBe(rail.querySelector("button"));
    rail.remove(); main.remove();
  });

  it("keeps staged tool choices, and the prompt that protects them, across a visit to another section", async () => {
    serve("/bots/shared/tools", [{ id: "one", name: "One", description: "", enabled: true }]);
    await click("Behavior");
    await act(async () => checkbox("One").click());
    await click("Access");
    vi.mocked(api).mockClear();
    await click("Behavior");
    expect(paths()).not.toContain("/bots/shared/tools");
    expect(checkbox("One").checked).toBe(false);
    await escape();
    expect(container.textContent).toContain("Discard your unsaved changes?");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns focus to the control that opened it", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    await act(async () => root.unmount());
    ({ container, root } = mountRoot());
    opener.focus();
    await render();
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => root.unmount());
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe("phone navigation", () => {
  const compact = async () => {
    const media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    stubImmediateFrames();
    await act(async () => root.unmount());
    ({ container, root } = mountRoot());
    await render();
    return media;
  };
  const rows = () => Array.from(container.querySelectorAll<HTMLButtonElement>(".settings-index .settings-row"));
  const title = () => container.querySelector("#assistant-settings-title")!;

  it("opens on the section list with summaries, pushes into a section, and comes back", async () => {
    await compact();
    expect(saveButton()).toBeNull();
    expect(container.querySelector(".settings-tabs")).toBeNull();
    expect(rows().map(row => [row.querySelector(".row-label")?.textContent, row.querySelector("small")?.textContent])).toEqual([
      ["Profile", "Shared with your household"], ["Behavior", "test"], ["Access", "Connections and logins"],
      ["Automation", "Routines, goals, tasks and triggers"], ["Memory & learning", "What it remembers and learns"],
    ]);
    expect(title().textContent).toBe("Shared");
    await act(async () => rows()[1].click());
    expect(title().textContent).toBe("Behavior");
    expect(document.activeElement).toBe(title());
    expect(container.querySelector("#assistant-instructions")).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="All settings"]')!.click());
    expect(rows()).toHaveLength(5);
    expect(container.querySelector('[aria-label="All settings"]')).toBeNull();
  });

  it("keeps unsaved changes and Save across the list", async () => {
    await compact();
    await act(async () => rows()[1].click());
    await typeInto(container.querySelector<HTMLTextAreaElement>("#assistant-instructions")!, "Phone edit");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="All settings"]')!.click());
    expect(saveButton().disabled).toBe(false);
    await act(async () => rows()[1].click());
    expect(container.querySelector<HTMLTextAreaElement>("#assistant-instructions")!.value).toBe("Phone edit");
  });

  it("switches layouts on viewport changes and cleans up its media listener", async () => {
    const media = await compact();
    const changed = media.addEventListener.mock.calls[0][1] as () => void;
    media.matches = false;
    await act(async () => changed());
    expect(Array.from(container.querySelectorAll(".settings-tabs button")).map(button => button.textContent)).toHaveLength(5);
    expect(container.querySelector(".settings-index")).toBeNull();
    await act(async () => root.unmount());
    expect(media.removeEventListener).toHaveBeenCalledWith("change", changed);
  });
});

describe("MCP servers in Access", () => {
  const advanced = { ...bootstrap, preferences: { ...bootstrap.preferences, presentation: "advanced" as const } };
  const remount = async (props: Partial<Parameters<typeof BotSettings>[0]>) => {
    await act(async () => root.unmount());
    ({ container, root } = mountRoot());
    await render(props);
    await click("Access");
  };

  it("offers every configured server as a switch and saves the choice with Save changes", async () => {
    await remount({ bootstrap: advanced, bot: { ...bot, availableMcpServers: ["notes", "calendar"], enabledMcpServers: ["calendar", "retired"] } });
    const group = container.querySelector('[aria-labelledby="settings-mcp-heading"]')!;
    expect(Array.from(group.querySelectorAll("label")).map(label => [label.querySelector("strong")?.textContent, label.querySelector("input")!.checked])).toEqual([
      ["calendar", true], ["notes", false], ["retired", true]]);
    expect(group.textContent).toContain("Saved, but Hermes no longer reports it");
    await act(async () => checkbox("notes").click());
    await click("Save changes");
    expect(write).toHaveBeenCalledExactlyOnceWith("/bots/shared", expect.objectContaining({ enabledMcpServers: ["calendar", "retired", "notes"] }), "PATCH");
  });

  it("is hidden in Simple presentation, which still sends saved servers unchanged", async () => {
    await remount({ bot: { ...bot, availableMcpServers: ["calendar"], enabledMcpServers: ["calendar"] } });
    expect(container.textContent).not.toContain("MCP servers");
    await editInstructions();
    await click("Save changes");
    expect(write).toHaveBeenCalledWith("/bots/shared", expect.objectContaining({ enabledMcpServers: ["calendar"] }), "PATCH");
  });
});

describe("skill locks in Behavior", () => {
  const overview = (locked: boolean, canManageLearningPolicy = true) => ({
    botId: "shared", owner: "Hermes", canManageLearningPolicy,
    goals: { supported: true, goal: null }, tasks: { supported: true, items: [] }, triggers: { supported: true, items: [], platformEnabled: true },
    skills: { supported: true, lockSupported: true, approvalRequired: true, pending: [], installed: [{ name: "ranch-plan", description: "Seasonal planning", locked }] },
  });

  it("puts lock and read controls on the matching skill row and saves a lock at once", async () => {
    serve("/bots/shared/skills", [{ id: "ranch-plan", name: "ranch-plan", description: "Seasonal planning", enabled: true }, { id: "plain", name: "plain", description: "", enabled: true }]);
    serve("/bots/shared/automation", overview(false));
    await click("Behavior");
    const rowFor = (name: string) => Array.from(container.querySelectorAll(".capability-row")).find(row => row.querySelector("strong")?.textContent === name)!;
    expect(rowFor("plain").querySelector(".capability-extras")).toBeNull();
    serve("/bots/shared/automation/skills/content", { name: "ranch-plan", content: "# Plan", truncated: false });
    await click("Read skill", rowFor("ranch-plan"));
    expect(rowFor("ranch-plan").textContent).toContain("# Plan");
    vi.mocked(write).mockResolvedValueOnce({ ok: true, name: "ranch-plan", locked: true });
    serve("/bots/shared/automation", overview(true));
    await click("Lock skill", rowFor("ranch-plan"));
    expect(write).toHaveBeenCalledExactlyOnceWith("/bots/shared/automation/skills/lock", { name: "ranch-plan", locked: true }, "PUT");
    expect(rowFor("ranch-plan").textContent).toContain("Locked");
    expect(saveButton().disabled).toBe(true);
  });

  it("offers a retry when skill status fails to load, then shows the lock controls", async () => {
    serve("/bots/shared/skills", [{ id: "ranch-plan", name: "ranch-plan", description: "", enabled: true }]);
    serve("/bots/shared/automation", () => Promise.reject(new Error("Hermes is restarting.")));
    await click("Behavior");
    expect(container.textContent).toContain("Hermes is restarting.");
    expect(Array.from(container.querySelectorAll("button")).map(item => item.textContent)).not.toContain("Lock skill");
    serve("/bots/shared/automation", overview(false));
    await click("Refresh skill status");
    expect(container.textContent).not.toContain("Hermes is restarting.");
    expect(Array.from(container.querySelectorAll("button")).map(item => item.textContent)).toContain("Lock skill");
  });

  it("explains who can lock skills instead of offering the button", async () => {
    serve("/bots/shared/skills", [{ id: "ranch-plan", name: "ranch-plan", description: "", enabled: true }]);
    serve("/bots/shared/automation", overview(false, false));
    await click("Behavior");
    expect(container.textContent).toContain("Only an integration administrator can lock or unlock skills.");
    expect(Array.from(container.querySelectorAll("button")).map(item => item.textContent)).not.toContain("Lock skill");
  });
});

it("loads roster detail before showing a writable settings form", async () => {
  let finish!: (value: Bot) => void;
  vi.mocked(api).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await render({ bot: { ...bot, instructions: undefined } });
  expect(container.querySelector("form")).toBeNull();
  await act(async () => finish({ ...bot, instructions: "Saved instructions", enabledMcpServers: ["calendar"] }));
  await click("Behavior");
  expect(container.querySelector<HTMLTextAreaElement>("#assistant-instructions")!.value).toBe("Saved instructions");
});

describe("lean roster settings", () => {
  it("keeps one dialog, retries detail, and PATCHes only loaded configuration without reloading on roster refresh", async () => {
    await act(async () => root.unmount());
    ({ container, root } = mountRoot());
    const { instructions, ...lean } = bot;
    let finish!: (value: Bot) => void;
    vi.mocked(api).mockRejectedValueOnce(new Error("Detail unavailable"));
    await render({ bot: lean });
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
    vi.mocked(api).mockClear();
    await render({ bot: { ...lean, activity: "working" } });
    expect(api).not.toHaveBeenCalled();
    await typeInto(container.querySelector<HTMLTextAreaElement>("#assistant-description")!, "Now described");
    await submit();
    expect(write).toHaveBeenCalledWith("/bots/shared", expect.objectContaining({ instructions: "Keep this saved SOUL", enabledMcpServers: ["calendar"], description: "Now described" }), "PATCH");
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
    await render({ bot: "new", onCreated });
  });
  const toRole = async (name = "Ranch hand") => {
    await type(name);
    await choose("Mascot");
    await act(async () => button("Next: role and model")!.click());
  };

  it("starts with name and look, and hides sections that need an existing assistant", async () => {
    expect(title()).toBe("Name and look");
    expect(container.querySelector('[aria-label="Settings sections"]')).toBeNull();
    await act(async () => button("Next: role and model")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Give your assistant a name.");
    await type(" shared ");
    await act(async () => button("Next: role and model")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("An assistant with this name already exists. Choose another name.");
    expect(title()).toBe("Name and look");
    await toRole();
    expect(title()).toBe("Role and model");
    expect(container.textContent).not.toContain("MCP");
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
    // The new assistant's chat opens, rather than leaving the person where they were.
    expect(onCreated).toHaveBeenCalledWith("ranch-hand");
    expect(onSaved).toHaveBeenCalled();
  });

  it("retries a failed default avatar instead of treating it as already saved", async () => {
    let avatarFails = true;
    vi.mocked(write).mockImplementation(async <T,>(path: string) => {
      if (path === "/bots") return created as T;
      if (avatarFails) throw new Error("Hermes is restarting.");
      return {} as T;
    });
    await type("Ranch hand");
    await act(async () => button("Next: role and model")!.click());
    await act(async () => button("Create assistant")!.click());
    expect(container.querySelector(".avatar-failure")).not.toBeNull();
    avatarFails = false;
    vi.mocked(write).mockClear();
    await act(async () => button("Retry avatar")!.click());
    expect(vi.mocked(write).mock.calls.map(([path, , method]) => [path, method])).toEqual([["/bots/ranch-hand/avatar", "PUT"]]);
    expect(container.querySelector(".avatar-failure")).toBeNull();
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
    // Now it exists, so its sections appear, opened on the Profile that holds its avatar.
    expect(container.querySelector('[aria-label="Settings sections"] [aria-current="page"]')?.textContent).toBe("Profile");
    avatarFails = false;
    await act(async () => button("Retry avatar")!.click());
    expect(vi.mocked(write).mock.calls.filter(([path]) => path === "/bots")).toHaveLength(1);
    expect(vi.mocked(write).mock.lastCall).toEqual(["/bots/ranch-hand/avatar", expect.objectContaining({ mode: "mascot" }), "PUT"]);
    expect(container.querySelector(".avatar-failure")).toBeNull();
    expect(container.querySelector('[data-slot="form-message"][role="status"]')?.textContent).toBe("Saved");
  });
});

describe("existing assistant portraits", () => {
  const choose = async (name: string) => {
    const label = [...container.querySelectorAll("label")].find(item => item.textContent?.trim() === name)!;
    await act(async () => label.querySelector("input")!.click());
  };
  const supported = { ...bootstrap, capabilities: { ...bootstrap.capabilities, uploads: { supported: true }, portraitGeneration: { supported: true } } };
  const promptField = () => container.querySelector<HTMLTextAreaElement>(".avatar-portrait-group textarea")!;
  beforeEach(async () => {
    await render({ bootstrap: supported });
    await choose("Portrait"); vi.mocked(api).mockClear();
  });
  const upload = async (file: File) => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    Object.defineProperty(input, "value", { configurable: true, writable: true, value: "C:\\fakepath\\portrait.png" });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    return input;
  };
  it("blocks Save changes until the portrait has an image, and says why", async () => {
    expect(saveButton().disabled).toBe(true);
    expect(container.querySelector(".settings-save-actions")?.textContent).toContain("Upload or generate a portrait before saving.");
  });
  it("shows compression failures without submitting or enabling Save", async () => {
    const file = new File(["bad"], "portrait.png", { type: "image/png" });
    vi.mocked(preparePortrait).mockRejectedValueOnce(new Error("Choose a PNG, JPEG, or WebP portrait no larger than 15 MB."));
    await upload(file);
    expect(api).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Choose a PNG, JPEG, or WebP portrait no larger than 15 MB.");
    expect(saveButton().disabled).toBe(true);
  });
  it("uploads the prepared portrait rather than the original photo", async () => {
    const compressed = new File(["compressed"], "portrait.png", { type: "image/png" });
    vi.mocked(preparePortrait).mockResolvedValueOnce(compressed);
    await upload(new File(["original"], "photo.jpg", { type: "image/jpeg" }));
    const options = vi.mocked(api).mock.calls.at(-1)![1]!;
    const uploaded = (options.body as FormData).get("file") as File;
    expect(uploaded.name).toBe("portrait.png");
    expect(uploaded.type).toBe("image/png");
    expect(uploaded.size).toBe(compressed.size);
  });
  it("clears the file input after failure so choosing the same file can retry", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Upload interrupted."));
    const file = new File(["png"], "portrait.png", { type: "image/png" });
    const input = await upload(file);
    expect(input.value).toBe("");
    expect(container.textContent).toContain("Upload interrupted.");
    vi.mocked(api).mockResolvedValueOnce({ id: "portrait-1" });
    await upload(file); await click("Save changes");
    expect(write).toHaveBeenLastCalledWith("/bots/shared/avatar", { mode: "portrait", src: "/api/files/portrait-1", origin: "uploaded" }, "PUT");
  });
  it("generates from the prompt, shows progress and saves the resulting draft", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(write).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await typeInto(promptField(), "A friendly ranch companion");
    await click("Generate portrait");
    expect([...container.querySelectorAll('.avatar-operation[role="status"]')].some(region => region.textContent?.includes("Generating portrait…"))).toBe(true);
    expect(write).toHaveBeenCalledWith("/bots/shared/portrait", { prompt: "A friendly ranch companion" });
    await act(async () => finish({ id: "generated-1" }));
    await click("Save changes");
    expect(write).toHaveBeenLastCalledWith("/bots/shared/avatar", { mode: "portrait", src: "/api/files/generated-1", origin: "generated" }, "PUT");
  });
  it("explains unavailable portrait operations and disables them even with a prompt", async () => {
    const unsupported = { ...bootstrap, capabilities: { ...bootstrap.capabilities, uploads: { supported: false, reason: "Uploads unavailable." }, portraitGeneration: { supported: false, reason: "Generation unavailable." } } };
    await render({ bootstrap: unsupported });
    await typeInto(promptField(), "A friendly ranch companion");
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(true);
    await click("Generate portrait");
    expect(write).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Uploads unavailable.");
    expect(container.textContent).toContain("Generation unavailable.");
    expect(container.textContent).toContain("Choose Geometric or Mascot.");
  });
  it("blocks a description over the server limit while keeping it editable", async () => {
    await typeInto(promptField(), "x".repeat(2001));
    await click("Generate portrait");
    expect(api).not.toHaveBeenCalled();
    expect(promptField().getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("The description is 1 character over the 2,000 limit. Shorten the text to generate a portrait.");
  });
});

async function openMemoryForEditing() {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  stubImmediateFrames();
  const memory = { botId: "shared", profile: "shared", scope: "profile" as const, owner: "Hermes", notice: "Shared profile.", documents: [
    { target: "memory" as const, label: "Assistant notes", revision: "a".repeat(64), enabled: true, charLimit: 2200, charCount: 5, entries: [{ id: "1", text: "First" }] },
  ] };
  serve("/bots/shared/memory", memory); await click("Memory & learning");
  await typeInto(container.querySelector<HTMLTextAreaElement>(".memory-panel textarea")!, "Edited fact");
  return memory;
}
it("keeps Memory drafts on Close and section changes, and leaves only after explicit discard", async () => {
  await openMemoryForEditing();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close assistant settings"]')!.click());
  expect(onClose).not.toHaveBeenCalled(); expect(container.textContent).toContain("Discard your unsaved changes?");
  await click("Keep editing"); expect(container.querySelector<HTMLTextAreaElement>(".memory-panel textarea")!.value).toBe("Edited fact");
  await click("Profile"); expect(container.textContent).toContain("Leave memory without saving?");
  await click("Keep editing"); expect(container.querySelector<HTMLTextAreaElement>(".memory-panel textarea")!.value).toBe("Edited fact");
  await click("Profile"); await click("Discard edits and leave");
  expect(container.querySelector(".memory-panel")).toBeNull(); expect(onClose).not.toHaveBeenCalled();
});
it("holds Memory navigation and Close while an accepted save is in flight", async () => {
  const memory = await openMemoryForEditing();
  let finish!: (value: typeof memory) => void;
  vi.mocked(write).mockReturnValueOnce(new Promise<typeof memory>(resolve => { finish = resolve; }));
  await click("Save memories");
  const close = container.querySelector<HTMLButtonElement>('[aria-label="Close assistant settings"]')!;
  expect(close.disabled).toBe(true); await click("Profile"); expect(container.querySelector(".memory-panel")).not.toBeNull();
  expect(container.textContent).not.toContain("Leave memory without saving?");
  const cancel = new Event("cancel", { cancelable: true, bubbles: true });
  await act(async () => { container.querySelector(".settings-dialog")!.dispatchEvent(cancel); });
  expect(cancel.defaultPrevented).toBe(true); expect(onClose).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Discard your unsaved changes?");
  await act(async () => finish({ ...memory, documents: [{ ...memory.documents[0], revision: "b".repeat(64), entries: [{ id: "2", text: "Edited fact" }] }] }));
  expect(close.disabled).toBe(false); await act(async () => close.click()); expect(onClose).toHaveBeenCalledTimes(1);
});

describe("routines in Automation", () => {
  const morning = { id: "r1", botId: bot.id, name: "Morning", prompt: "Check the gate", schedule: "0 7 * * *", enabled: true };
  const preview = { botId: bot.id, schedule: "0 7 * * *", kind: "cron", timezone: "UTC", nextRuns: [] };
  beforeEach(() => { Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() }); });

  it("offers only the owner as a recipient of a private assistant's routines", async () => {
    const household = [{ id: "one", name: "One", email: "one@example.test" }, { id: "two", name: "Two", email: "two@example.test" }];
    const recipients = async (assistant: Bot) => {
      await act(async () => root.unmount());
      ({ container, root } = mountRoot());
      await render({ bot: assistant, bootstrap: { ...bootstrap, household, bots: [assistant] } });
      await click("Automation");
      return Array.from(container.querySelectorAll(".routine-manager fieldset label")).map(label => label.textContent);
    };
    expect(await recipients({ ...bot, id: "mine", shared: false, ownerId: "one" })).toEqual(["One"]);
    expect(await recipients(bot)).toEqual(["One", "Two"]);
  });

  it("hides per-routine overrides in Simple presentation and offers them in Advanced", async () => {
    await click("Automation");
    expect(container.querySelector(".routine-manager summary")).toBeNull();
    await render({ bootstrap: { ...bootstrap, preferences: { ...bootstrap.preferences, presentation: "advanced" } } });
    expect(container.querySelector(".routine-manager summary")?.textContent).toBe("Advanced");
  });

  it("keeps one schedule preview and focuses the editor when editing or choosing a recipe", async () => {
    const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView);
    serve("/routines", [morning]);
    await click("Automation");
    const editor = () => container.querySelector<HTMLFormElement>(".routine-manager > form")!;
    const name = () => editor().querySelector<HTMLInputElement>("input")!;
    expect(editor().querySelectorAll(".routine-preview-control")).toHaveLength(1);
    await click("Edit", container.querySelector(".routine-card")!);
    expect(name().value).toBe("Morning");
    expect(document.activeElement).toBe(name());
    expect(editor().querySelectorAll(".routine-preview-control")).toHaveLength(1);
    await click("Cancel edit");
    expect(document.activeElement?.textContent).toBe("Edit");
    expect(container.querySelector(".routine-card")!.contains(document.activeElement)).toBe(true);
    await click("Edit", container.querySelector(".routine-card")!);
    await act(async () => container.querySelector<HTMLButtonElement>(".routine-preset")!.click());
    expect(name().value).toBe("Morning brief");
    expect(document.activeElement).toBe(name());
    expect(editor().querySelectorAll(".routine-preview-control")).toHaveLength(1);
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(write).not.toHaveBeenCalled();
  });

  it("shares one routine list with event triggers, so a new routine is ready for a trigger at once", async () => {
    serve("/bots/shared/automation", { owner: "Hermes", canManageTriggers: true, goals: { supported: false, goal: null }, tasks: { supported: false, items: [] },
      triggers: { supported: true, items: [], platformEnabled: true }, skills: { supported: false, installed: [], pending: [], approvalRequired: false } });
    await click("Automation");
    expect(paths().filter(path => path === "/routines")).toHaveLength(1);
    expect(container.textContent).toContain("Add a routine above first.");
    expect(button("New event trigger").disabled).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>(".routine-preset")!.click());
    const editor = container.querySelector(".routine-manager > form")!;
    vi.mocked(write).mockResolvedValueOnce({ ...preview, schedule: "0 7 * * *" });
    await act(async () => { const field = editor.querySelector<HTMLInputElement>(".routine-schedule")!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "0 7 * * *"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await click("Preview schedule", editor);
    vi.mocked(write).mockResolvedValueOnce({});
    serve("/routines", [morning]);
    await click("Add routine", editor);
    expect(container.textContent).not.toContain("Add a routine above first.");
    expect(button("New event trigger").disabled).toBe(false);
    expect(paths().filter(path => path === "/routines")).toHaveLength(2);
  });

  it("returns focus to the edited routine after saving the previewed schedule", async () => {
    serve("/routines", [morning]);
    await click("Automation");
    const card = container.querySelector(".routine-card")!;
    await click("Edit", card);
    const editor = container.querySelector(".routine-manager > form")!;
    vi.mocked(write).mockResolvedValueOnce(preview);
    await click("Preview schedule", editor);
    vi.mocked(write).mockResolvedValueOnce({});
    vi.mocked(api).mockClear();
    await click("Save routine", editor);
    expect(write).toHaveBeenLastCalledWith("/routines/r1", expect.objectContaining({ name: "Morning", schedule: "0 7 * * *" }), "PUT");
    expect(document.activeElement?.textContent).toBe("Edit");
    expect(card.contains(document.activeElement)).toBe(true);
    expect(editor.querySelector("h3")?.textContent).toBe("New routine");
  });

  it("offers Show runs in chat per routine as this person's preference, not a routine change", async () => {
    serve("/routines", [{ id: "r1", botId: bot.id, name: "Certificates", prompt: "", schedule: "every 6h", enabled: true }]);
    const edits: ((value: typeof bootstrap.preferences) => typeof bootstrap.preferences)[] = [];
    // Saves stay on their way, so the switch shows the edit as it would until the server answers.
    const editPreferences = vi.fn((edit: (value: typeof bootstrap.preferences) => typeof bootstrap.preferences) => { edits.push(edit); return new Promise<void>(() => {}); });
    await render({ editPreferences });
    await click("Automation");
    const toggle = () => container.querySelector<HTMLInputElement>(".routine-chat-toggle input")!;
    expect(toggle().checked).toBe(true);
    await act(async () => toggle().click());
    expect(toggle().checked).toBe(false);
    expect(edits.at(-1)!(bootstrap.preferences).hiddenRoutineRuns).toEqual([{ botId: bot.id, routineId: "r1" }]);
    await act(async () => toggle().click());
    expect(toggle().checked).toBe(true);
    expect(edits.at(-1)!({ ...bootstrap.preferences, hiddenRoutineRuns: [{ botId: bot.id, routineId: "r1" }] }).hiddenRoutineRuns).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });

  it("posts a routine's results in chosen group chats, and never sends rooms it could not read", async () => {
    const member = { member_id: "shared", profile: "shared", handle: "shared" };
    serve("/groups", { supported: true, canSend: true, routineDelivery: true, rooms: [
      { room_id: "team", name: "Weekend plans", members: [member] }, { room_id: "barn", name: "Barn crew", members: [member] }] });
    const routine = { botId: bot.id, prompt: "Check the gate", schedule: "0 7 * * *", enabled: true };
    serve("/routines", [{ ...routine, id: "r1", name: "Morning", roomIds: ["team"] }, { ...routine, id: "r2", name: "Evening" }]);
    await click("Automation");
    const [first, second] = container.querySelectorAll(".routine-card");
    expect(first.textContent).toContain("Posts inWeekend plans");
    // Pausing never touches where a routine posts.
    await click("Pause", first);
    expect((vi.mocked(write).mock.calls.at(-1)![1] as { roomIds?: string[] }).roomIds).toBeUndefined();
    const editor = container.querySelector(".routine-manager > form")!;
    const rooms = () => Array.from(editor.querySelectorAll("fieldset")).find(set => set.querySelector("legend")?.textContent === "Also post results in these group chats");
    await click("Edit", first);
    expect(Array.from(rooms()!.querySelectorAll("label")).map(label => [label.textContent, label.querySelector("input")!.checked])).toEqual([["Weekend plans", true], ["Barn crew", false]]);
    await act(async () => rooms()!.querySelectorAll("input")[1].click());
    vi.mocked(write).mockResolvedValueOnce(preview);
    await click("Preview schedule", editor);
    vi.mocked(write).mockResolvedValueOnce({});
    await click("Save routine", editor);
    expect(write).toHaveBeenLastCalledWith("/routines/r1", expect.objectContaining({ roomIds: ["team", "barn"] }), "PUT");
    // The server could not say where Evening posts, so its editor offers no rooms and sends none.
    await click("Edit", second);
    expect(rooms()).toBeUndefined();
    vi.mocked(write).mockResolvedValueOnce(preview);
    await click("Preview schedule", editor);
    vi.mocked(write).mockResolvedValueOnce({});
    await click("Save routine", editor);
    expect(vi.mocked(write).mock.calls.at(-1)![0]).toBe("/routines/r2");
    expect((vi.mocked(write).mock.calls.at(-1)![1] as { roomIds?: string[] }).roomIds).toBeUndefined();
  });
});
