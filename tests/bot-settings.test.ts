// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotSettings } from "../src/BotSettings";
import { api, ApiError, write } from "../src/client-api";
import { defaultPreferences } from "../src/shared/types";
import type { Bootstrap, Bot } from "../src/shared/types";

// SVG geometry is a browser concern; these tests cover the form around the avatar.
vi.mock("../src/components/Avatar", async (original) => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  Avatar: () => createElement("span", { "data-avatar": "" }),
}));
vi.mock("../src/client-api", async (original) => ({
  ...await original<typeof import("../src/client-api")>(),
  api: vi.fn().mockResolvedValue({}),
  write: vi.fn().mockResolvedValue({}),
}));

const bot: Bot = { id: "shared", name: "Shared", shared: true, model: "test", activity: "idle" };
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
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

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  vi.unstubAllGlobals();
});

async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

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
    expect(api).toHaveBeenCalledExactlyOnceWith("/bots/shared", { method: "DELETE" });
    expect(write).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
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
  await click("Other model");
  expect(container.textContent).not.toContain("Confirm this model");
  expect(container.textContent).not.toContain("This model has a higher price");
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(write).toHaveBeenLastCalledWith("/bots/shared", expect.objectContaining({ provider: "provider", model: "other", shared: true, confirmModel: false }), "PATCH");
});

describe("compact settings navigation", () => {
  const compact = async () => {
    const media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    await act(async () => {
      root.unmount();
      root = createRoot(container);
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
    expect(nav.querySelectorAll("button")).toHaveLength(8);
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
