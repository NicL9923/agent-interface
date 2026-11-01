// @vitest-environment jsdom
import { act, createElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { ChatHeader } from "../src/app/ChatHeader";
import type { Bootstrap, Bot } from "../src/shared/types";
import { mountRoot } from "./ui-harness";

vi.mock("../src/components/Avatar", () => ({ Avatar: () => null }));
const bot = { id: "ranch", name: "Ranch hand", model: "claude-opus-5-5", modelName: "Claude Opus 5.5", provider: "anthropic", shared: true, activity: "idle" } as Bot;
const boot = (presentation: "simple" | "advanced") => ({ preferences: { presentation, modelFavorites: [] }, capabilities: { botConfiguration: { supported: true } } }) as unknown as Bootstrap;
let mount: ReturnType<typeof mountRoot>;
beforeEach(() => { mount = mountRoot(); });
const render = async (presentation: "simple" | "advanced", selected: Bot = bot) => {
  await mount.render(createElement(ChatHeader, { view: "conversation", boot: boot(presentation), selected, avatarState: "idle", railOpen: false,
    onOpenRail: vi.fn(), onDetails: vi.fn(), onModelSaved: vi.fn() }));
  await act(async () => { await vi.dynamicImportSettled(); });
};
const chip = () => mount.container.querySelector<HTMLButtonElement>(".chat-model > button");

it("shows the model's display name with its provider mark under the name in Advanced, as a control apart from the identity button", async () => {
  await render("advanced");
  expect(chip()?.textContent).toBe("Claude Opus 5.5");
  expect(chip()?.querySelector("[data-provider-icon]")?.getAttribute("data-provider-icon")).toBe("anthropic");
  expect(chip()?.getAttribute("aria-label")).toContain("Claude Opus 5.5");
  expect(chip()?.title).toBe("anthropic / claude-opus-5-5");
  // A button inside a button is invalid, so the chip must sit beside the identity button.
  expect(chip()?.closest(".chat-identity")).toBeNull();
  expect(mount.container.querySelector(".chat-identity")?.textContent).toBe("Ranch hand");
});
it("never shows the model in Simple", async () => {
  await render("simple");
  expect(chip()).toBeNull();
  expect(mount.container.textContent).toContain("Shared with your household");
  expect(mount.container.textContent).not.toMatch(/Claude|opus|anthropic/i);
});
it("falls back to the model identifier when the server sent no display name", async () => {
  await render("advanced", { ...bot, modelName: undefined, provider: undefined });
  expect(chip()?.textContent).toBe("claude-opus-5-5");
  expect(chip()?.querySelector("[data-provider-icon]")?.getAttribute("data-provider-icon")).toBe("generic");
});
it("keeps the chip but disables it while the connection is lost", async () => {
  await mount.render(createElement(ChatHeader, { view: "conversation", boot: boot("advanced"), selected: bot, avatarState: "idle", railOpen: false, modelLocked: true,
    onOpenRail: vi.fn(), onDetails: vi.fn(), onModelSaved: vi.fn() }));
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(chip()?.disabled).toBe(true);
});
