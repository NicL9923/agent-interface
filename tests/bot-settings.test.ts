// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotSettings } from "../src/BotSettings";
import { api, write } from "../src/client-api";
import { defaultPreferences } from "../src/shared/types";
import type { Bootstrap, Bot } from "../src/shared/types";

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
  capabilities: { botConfiguration: { supported: true } } as Bootstrap["capabilities"],
  connection: { connected: true },
  csrfToken: "test",
};
let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const onSaved = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(BotSettings, { bot, bootstrap, onClose, onSaved })));
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
