// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { write } from "../src/client-api";
import { ApiError } from "../src/client-api";
import { BotDetails } from "../src/app/BotDetails";
import { Sidebar } from "../src/app/Sidebar";
import { MainAssistantPicker } from "../src/app/MainAssistantPicker";
import { CommandPalette } from "../src/app/CommandPalette";
import { AgentExchange, ExchangeBots, OPEN_CHAT_EVENT } from "../src/components/AgentExchange";
import { chooseMain, saveCheckIns } from "../src/app/main-assistant";
import { preloadBotMenu } from "../src/app/BotMenu";
import { defaultPreferences, type Bootstrap, type Bot, type Message, type Preferences } from "../src/shared/types";
import { mountRoot, typeInto } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn() }))(original)));

let root: Root, container: HTMLDivElement, boot: Bootstrap;
const sage: Bot = { id: "sage", name: "Sage", model: "m", shared: false, ownerId: "mom", activity: "idle", lastMessage: { text: "Dentist moved to 4 PM" } };
const notes: Bot = { id: "notes", name: "Notes", model: "m", shared: false, ownerId: "mom", activity: "idle" };
const ranch: Bot = { id: "ranch", name: "Ranch Hand", model: "m", shared: true, activity: "idle" };
const legacy: Bot = { id: "legacy", name: "Legacy", model: "m", shared: false, activity: "idle" };
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  ({ container, root } = mountRoot());
  boot = { user: { id: "mom", name: "Mom", email: "m@example.test" }, preferences: { ...defaultPreferences, favorites: ["ranch", "sage"] }, bots: [ranch, sage, notes, legacy],
    capabilities: { routines: { supported: true } } } as unknown as Bootstrap;
  vi.mocked(write).mockImplementation(async (path: string, body: unknown) => {
    if (path === "/preferences/main") return { ...boot.preferences, mainBotId: (body as { botId: string | null }).botId ?? undefined };
    if (path === "/preferences/check-ins") return { ...boot.preferences, checkIns: body };
    throw new Error(`Unexpected write ${path}`);
  });
});
const buttons = () => [...container.querySelectorAll("button")];
const button = (text: string) => buttons().find(item => item.textContent === text)!;
const sidebar = async (preferences: Partial<Preferences>, more: object = {}) => {
  const props = { boot: { ...boot, preferences: { ...boot.preferences, ...preferences } }, botId: "", readThrough: {}, view: "today" as const, state: "idle" as const,
    connectionLost: false, offline: false, mobile: false, open: true, update: null, onSelectBot: vi.fn(), onView: vi.fn(), onNewBot: vi.fn(), onSettings: vi.fn(), onUsage: vi.fn(), onSignOut: vi.fn(),
    onPin: vi.fn(), onBotSettings: vi.fn(), onMoveToSection: vi.fn(), onNewSection: vi.fn(), onChooseMain: vi.fn(), onDismissMainSuggestion: vi.fn(), ...more };
  await act(async () => root.render(createElement(Sidebar, props)));
  await act(async () => { await preloadBotMenu(); });
  return props;
};

it("leads home with the main assistant, marked Main, and shows it nowhere else", async () => {
  const props = await sidebar({ mainBotId: "sage" });
  const main = container.querySelector(".home-main")!;
  expect(main.textContent).toContain("SageMain");
  expect(main.textContent).toContain("Dentist moved to 4 PM");
  // It leads the pinned assistants and is not repeated among them or in the list.
  expect(main.compareDocumentPosition(container.querySelector(".home-pinned")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect([...container.querySelectorAll(".pinned-bot, .bot-row")].map(row => row.textContent)).not.toContainEqual(expect.stringContaining("Sage"));
  await act(async () => container.querySelector<HTMLButtonElement>(".main-bot")!.click());
  expect(props.onSelectBot).toHaveBeenCalledWith("sage");
  expect(container.querySelector(".home-main-suggestion")).toBeNull();
});

it("suggests choosing a main assistant until it is dismissed", async () => {
  const props = await sidebar({});
  expect(container.querySelector(".home-main-suggestion")!.textContent).toContain("Choose a main assistant: it checks in on what's coming up and hands work to your other assistants.");
  await act(async () => button("Choose").click());
  expect(props.onChooseMain).toHaveBeenCalled();
  await act(async () => button("Not now").click());
  expect(props.onDismissMainSuggestion).toHaveBeenCalled();
  await sidebar({ mainSuggestionDismissed: true });
  expect(container.querySelector(".home-main-suggestion")).toBeNull();
  // A main assistant this person can no longer see is not shown, and the suggestion returns.
  await sidebar({ mainBotId: "gone" });
  expect(container.querySelector(".home-main")).toBeNull();
  expect(container.querySelector(".home-main-suggestion")).not.toBeNull();
});

it("picks only the member's own personal assistants and explains the others", async () => {
  const onMakePersonal = vi.fn(), onClose = vi.fn();
  await act(async () => root.render(createElement(MainAssistantPicker, { boot, onChoose: (id: string | null) => chooseMain(id, vi.fn()), onMakePersonal, onClose })));
  const own = container.querySelector('[aria-label="Your personal assistants"]')!;
  expect([...own.querySelectorAll("strong")].map(node => node.textContent)).toEqual(["Sage", "Notes"]);
  const others = container.querySelector('[aria-label="Other assistants"]')!.textContent!;
  expect(others).toContain("Shared with the household. Check-ins stay private only on your own personal assistant.");
  expect(others).toContain("Visible to the whole household because it has no recorded owner.");
  await act(async () => own.querySelector("button")!.click());
  expect(write).toHaveBeenCalledWith("/preferences/main", { botId: "sage" }, "PUT");
  expect(onClose).toHaveBeenCalled();
  await act(async () => buttons().filter(item => item.textContent === "Make it personal")[0].click());
  expect(onMakePersonal).toHaveBeenCalledWith(ranch);
});

it("says why choosing failed and stays open", async () => {
  vi.mocked(write).mockRejectedValueOnce(new ApiError("Sage can't be your main assistant. Shared with the household.", 409, "main_not_personal"));
  const onClose = vi.fn();
  await act(async () => root.render(createElement(MainAssistantPicker, { boot, onChoose: (id: string | null) => chooseMain(id, vi.fn()), onMakePersonal: vi.fn(), onClose })));
  await act(async () => button("Make main").click());
  expect(container.textContent).toContain("Sage can't be your main assistant.");
  expect(onClose).not.toHaveBeenCalled();
});

describe("in the main assistant's details", () => {
  let apply = vi.fn();
  beforeEach(() => { apply = vi.fn(); });
  const details = async (preferences: Partial<Preferences>, bot = sage) => {
    const current = { ...boot, preferences: { ...boot.preferences, ...preferences } };
    await act(async () => root.render(createElement(BotDetails, { boot: current, bot, avatarState: "idle", conversation: null, connectionLost: false,
      editPreferences: vi.fn(), onSettings: vi.fn(), onFind: vi.fn(), onClose: vi.fn(),
      onMain: id => chooseMain(id, apply), onCheckIns: change => saveCheckIns(current.preferences.checkIns, change, apply) })));
  };
  it("shows what the server saved when it saved a change Hermes hasn't finished, and says why", async () => {
    await details({ mainBotId: "sage" });
    const cleared = { ...boot.preferences, mainBotId: undefined };
    vi.mocked(write).mockRejectedValueOnce(new ApiError("Your previous main assistant still has a check-in in Hermes.", 502, "main_clear_pending", undefined,
      { code: "main_clear_pending", preferences: cleared }));
    await act(async () => button("Main").click());
    expect(apply).toHaveBeenCalledWith(cleared);
    expect(container.textContent).toContain("Your previous main assistant still has a check-in in Hermes.");
    await details({ mainBotId: "sage", checkIns: { enabled: true, everyHours: 2, timezone: "America/Chicago" } });
    const off = { ...boot.preferences, mainBotId: "sage", checkIns: { enabled: false, everyHours: 2, timezone: "America/Chicago" } };
    vi.mocked(write).mockRejectedValueOnce(new ApiError("Check-ins are off, but Hermes hasn't removed the routine yet.", 502, "check_in_removal_pending", undefined,
      { code: "check_in_removal_pending", preferences: off }));
    apply.mockClear();
    await act(async () => container.querySelector<HTMLInputElement>('.main-check-ins [role="switch"]')!.click());
    expect(apply).toHaveBeenCalledWith(off);
    expect(container.textContent).toContain("Hermes hasn't removed the routine yet.");
    // A refusal that saved nothing changes nothing on screen.
    vi.mocked(write).mockRejectedValueOnce(new ApiError("Sage can't be your main assistant.", 409, "main_routine_busy"));
    apply.mockClear();
    await details({});
    await act(async () => button("Make main").click());
    expect(apply).not.toHaveBeenCalled();
  });
  it("makes or clears the main assistant in one action, and only offers it on the member's own", async () => {
    await details({});
    expect(container.textContent).not.toContain("Check in with me");
    await act(async () => button("Make main").click());
    expect(write).toHaveBeenLastCalledWith("/preferences/main", { botId: "sage" }, "PUT");
    await details({ mainBotId: "sage" });
    expect(button("Main").getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("Main").click());
    expect(write).toHaveBeenLastCalledWith("/preferences/main", { botId: null }, "PUT");
    await details({}, ranch);
    expect(buttons().some(item => item.textContent === "Make main")).toBe(false);
  });
  it("turns check-ins on, off by default, with the device's timezone, and changes how often", async () => {
    await details({ mainBotId: "sage" });
    const toggle = () => container.querySelector<HTMLInputElement>('.main-check-ins [role="switch"]')!;
    expect(toggle().checked).toBe(false);
    expect(container.querySelector(".main-check-ins select")).toBeNull();
    await act(async () => toggle().click());
    expect(write).toHaveBeenLastCalledWith("/preferences/check-ins", { enabled: true, everyHours: 2, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, "PUT");
    await details({ mainBotId: "sage", checkIns: { enabled: true, everyHours: 2, timezone: "America/Chicago" } });
    const often = container.querySelector<HTMLSelectElement>(".main-check-ins select")!;
    expect([...often.options].map(option => option.textContent)).toEqual(["Every hour", "Every 2 hours", "Every 3 hours", "Every 4 hours"]);
    await act(async () => { often.value = "4"; often.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(vi.mocked(write).mock.calls.at(-1)![1]).toMatchObject({ enabled: true, everyHours: 4 });
  });
  it("shows Hermes's refusal under the switch", async () => {
    vi.mocked(write).mockRejectedValueOnce(new ApiError("Hermes couldn't set up check-ins. Try again.", 502, "check_in_unavailable"));
    await details({ mainBotId: "sage" });
    await act(async () => container.querySelector<HTMLInputElement>('.main-check-ins [role="switch"]')!.click());
    expect(container.querySelector(".form-message, [role='alert'], .settings-footnote")!.textContent).toContain("Hermes couldn't set up check-ins.");
  });
});

it("asks the main assistant from the palette with the typed words", async () => {
  const onAsk = vi.fn();
  const props = { boot: { ...boot, preferences: { ...boot.preferences, mainBotId: "sage" } }, botId: "", readThrough: {}, connectionLost: false, onClose: vi.fn(), onSelectBot: vi.fn(),
    onView: vi.fn(), onSearch: vi.fn(), onSettings: vi.fn(), onUsage: vi.fn(), onNewBot: vi.fn(), onTheme: vi.fn(), onShortcuts: vi.fn(), onAsk };
  await act(async () => root.render(createElement(CommandPalette, props)));
  // The main assistant leads the assistants, ahead of pinned ones.
  expect(container.querySelector('[role="option"]')!.textContent).toContain("Sage");
  await typeInto(container.querySelector<HTMLInputElement>('[role="combobox"]')!, "move dentist");
  const ask = [...container.querySelectorAll('[role="option"]')].find(option => option.textContent!.startsWith("Ask Sage"))!;
  expect(ask.textContent).toContain('Ask Sage: "move dentist"');
  await act(async () => (ask as HTMLElement).click());
  expect(onAsk).toHaveBeenCalledWith("sage", "move dentist");
  // Without a main assistant there is nothing to ask.
  await act(async () => root.render(createElement(CommandPalette, { ...props, boot })));
  await typeInto(container.querySelector<HTMLInputElement>('[role="combobox"]')!, "move dentist");
  expect(container.textContent).not.toContain("Ask ");
});

describe("a handoff in the transcript", () => {
  const handoff = (target: string): Message => ({ id: "h", role: "assistant", text: "", toolName: "message_agent", origin: { kind: "agent", visibility: "conversation" },
    toolCall: { id: "c", name: "message_agent", arguments: JSON.stringify({ target, message: "Fix the gate" }), status: "completed", result: "queued" } });
  const render = (message: Message, bots = boot.bots) => act(async () => root.render(createElement(ExchangeBots.Provider, { value: { bots, currentBotId: "sage" } },
    createElement(AgentExchange, { message, recipient: "Sage" }))));
  it("opens the other assistant's chat", async () => {
    const opened = vi.fn();
    window.addEventListener(OPEN_CHAT_EVENT, event => opened((event as CustomEvent).detail));
    await render(handoff("ranch"));
    await act(async () => button("Open Ranch Hand's chat").click());
    expect(opened).toHaveBeenCalledWith({ botId: "ranch" });
  });
  it("offers nothing for an assistant this person can't open, a fan-out or the open chat", async () => {
    for (const target of ["dad-diary", "ranch, notes", "sage", ""]) {
      await render(handoff(target));
      expect(buttons().some(item => item.textContent?.startsWith("Open "))).toBe(false);
    }
  });
});
