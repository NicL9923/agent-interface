// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerModelPicker } from "../src/components/ComposerModelPicker";
import { ApiError, api, write } from "../src/client-api";
import type { Bootstrap, Bot, ModelCatalog } from "../src/shared/types";

vi.mock("../src/client-api", async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn() }));
const catalog: ModelCatalog = { provider: "house", model: "saved-model", providers: [
  { id: "house", name: "House provider", authenticated: true, models: [
    { id: "saved-model", name: "Saved model", available: true },
    { id: "new-model", name: "New model", available: true },
  ] },
] };
const bot = { id: "ranch", name: "Ranch hand", description: "Help", instructions: "Be kind.", model: "saved-model",
  provider: "house", shared: true, enabledMcpServers: ["calendar"], activity: "idle" } as Bot;
const bootstrap = { capabilities: { botConfiguration: { supported: true } }, preferences: { modelFavorites: [] } } as unknown as Bootstrap;
let container: HTMLDivElement, root: Root;
const onSaved = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(api).mockResolvedValue(catalog); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = (value: Bot = bot) => act(async () => root.render(createElement(ComposerModelPicker, { bot: value, bootstrap, disabled: false, onSaved })));
const trigger = () => container.querySelector<HTMLButtonElement>(".composer-model > button")!;
const click = async (name: string) => {
  const button = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === name);
  expect(button, name).toBeTruthy(); await act(async () => button!.click());
};

it("switches the model while resending the assistant's other settings unchanged", async () => {
  vi.mocked(write).mockResolvedValue({});
  await render(); await act(async () => trigger().click());
  await click("New model");
  expect(write).toHaveBeenCalledWith("/bots/ranch", { name: "Ranch hand", description: "Help", instructions: "Be kind.",
    model: "new-model", provider: "house", shared: true, enabledMcpServers: ["calendar"], confirmModel: false }, "PATCH");
  expect(onSaved).toHaveBeenCalledOnce(); expect(container.querySelector(".model-popover")).toBeNull();
});

it("asks before retrying a model Hermes wants confirmed", async () => {
  vi.mocked(write).mockRejectedValueOnce(new ApiError("This model is expensive.", 409, "MODEL_CONFIRMATION_REQUIRED", true)).mockResolvedValue({});
  await render(); await act(async () => trigger().click());
  await click("New model");
  expect(container.textContent).toContain("This model is expensive."); expect(onSaved).not.toHaveBeenCalled();
  await click("Confirm this model");
  expect(write).toHaveBeenLastCalledWith("/bots/ranch", expect.objectContaining({ model: "new-model", confirmModel: true }), "PATCH");
  expect(onSaved).toHaveBeenCalledOnce();
});

it("stays disabled when the instructions it must resend are unknown", async () => {
  await render({ ...bot, instructions: undefined });
  expect(trigger().disabled).toBe(true);
});

it("drops a late confirmation request after switching assistants", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(write).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
  await render(); await act(async () => trigger().click());
  await click("New model");
  await render({ ...bot, id: "kitchen", name: "Kitchen companion" });
  await act(async () => reject(new ApiError("This model is expensive.", 409, "MODEL_CONFIRMATION_REQUIRED", true)));
  await act(async () => trigger().click());
  expect(container.textContent).not.toContain("Confirm this model");
  expect(container.textContent).not.toContain("This model is expensive.");
});

it("closes when the assistant can no longer be saved safely and returns focus after a choice", async () => {
  vi.mocked(write).mockResolvedValue({});
  await render(); await act(async () => trigger().click());
  expect(document.activeElement).toBe(container.querySelector("input[type=search]"));
  await render({ ...bot, instructions: undefined });
  expect(container.querySelector(".model-popover")).toBeNull();
  await render(); await act(async () => trigger().click());
  await click("New model");
  expect(document.activeElement).toBe(trigger());
});
