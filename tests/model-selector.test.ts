// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelSelector } from "../src/components/ModelSelector";
import { api, write } from "../src/client-api";
import type { ModelCatalog } from "../src/shared/types";

vi.mock("../src/client-api", () => ({ api: vi.fn(), write: vi.fn() }));
const catalog: ModelCatalog = { provider: "custom:house", model: "saved-model", providers: [
  { id: "house", name: "House provider", aliases: ["custom:house"], authenticated: true, models: [
    { id: "saved-model", name: "Saved model", available: true },
    { id: "new-model", name: "New model", available: true },
  ] },
  { id: "offline", name: "Offline provider", authenticated: false, models: [{ id: "offline-model", name: "Offline model", available: false }] },
] };
let container: HTMLDivElement;
let root: Root;
const onChange = vi.fn(), onFavoritesSaved = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api).mockReset().mockResolvedValue(catalog);
  vi.mocked(write).mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = async (model = "saved-model") => {
  await act(async () => root.render(createElement(ModelSelector, { value: { provider: "custom:house", model }, profile: "shared",
    favorites: [], disabled: false, onChange, onFavoritesSaved })));
};
const button = (label: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)!;

it("loads actual profile models, uses provider disclosures, preserves aliases and chooses available options", async () => {
  await render();
  expect(api).toHaveBeenCalledWith("/models?botId=shared", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(container.querySelectorAll("details.model-provider")).toHaveLength(2);
  const groups = container.querySelectorAll<HTMLDetailsElement>("details.model-provider");
  expect(groups[0].open).toBe(true);
  expect(groups[1].open).toBe(false);
  expect(button("Saved model").getAttribute("aria-pressed")).toBe("true");
  expect(button("Offline modelReconnect in Hermes to use this model").disabled).toBe(true);
  await act(async () => button("New model").click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ provider: "house", model: "new-model" });
});

it("refreshes a loaded catalog without changing the saved choice or reopening a manually collapsed provider", async () => {
  await render();
  const selected = container.querySelector<HTMLDetailsElement>("details.model-provider")!;
  selected.open = false;
  let finish!: (value: ModelCatalog) => void;
  vi.mocked(api).mockImplementationOnce(() => new Promise<ModelCatalog>((resolve) => { finish = resolve; }));
  await act(async () => button("Refresh models").click());
  expect(button("Refresh models").disabled).toBe(true);
  expect(container.textContent).toContain("Loading models from Hermes");
  await act(async () => finish({ ...catalog, providers: catalog.providers.map((provider) => provider.id === "house"
    ? { ...provider, models: [...provider.models, { id: "fresh-model", name: "Fresh model", available: true }] } : provider) }));
  expect(button("Fresh model")).toBeDefined();
  expect(selected.open).toBe(false);
  expect(button("Refresh models").disabled).toBe(false);
  expect(onChange).not.toHaveBeenCalled();
  expect(button("Saved model").getAttribute("aria-pressed")).toBe("true");
});

it("persists favorites separately from household preferences and reports failed writes without changing the favorite", async () => {
  await render();
  const favorite = container.querySelector<HTMLButtonElement>('[aria-label="Add New model to favorites"]')!;
  vi.mocked(write).mockRejectedValueOnce(new Error("Connection lost"));
  await act(async () => favorite.click());
  expect(favorite.getAttribute("aria-pressed")).toBe("false");
  expect(container.textContent).toContain("Connection lost");
  expect(onFavoritesSaved).not.toHaveBeenCalled();
  vi.mocked(write).mockResolvedValueOnce({ modelFavorites: [{ provider: "house", model: "new-model" }] });
  await act(async () => favorite.click());
  expect(write).toHaveBeenLastCalledWith("/preferences/models", { modelFavorites: [{ provider: "house", model: "new-model" }] }, "PUT");
  expect(container.textContent).toContain("Favorites");
  expect(onFavoritesSaved).toHaveBeenCalledOnce();
  const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove New model from favorites"]')!;
  vi.mocked(write).mockResolvedValueOnce({ modelFavorites: [] });
  await act(async () => remove.click());
  expect(write).toHaveBeenLastCalledWith("/preferences/models", { modelFavorites: [] }, "PUT");
});

it("filters provider groups by search and shows an empty search result", async () => {
  await render();
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, "new model"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(container.querySelectorAll("details.model-provider")).toHaveLength(1);
  expect(container.querySelector("details.model-provider")?.hasAttribute("open")).toBe(true);
  expect(button("New model")).toBeDefined();
  await act(async () => { setter.call(input, "missing"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(container.textContent).toContain("No models match your search.");
});

it("keeps a saved model after a catalog failure and retries without replacing the selection", async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error("Hermes unavailable"));
  await render("retired-model");
  expect(container.textContent).toContain("retired-model");
  expect(container.textContent).toContain("Hermes unavailable");
  await act(async () => button("Retry loading models").click());
  expect(container.textContent).toContain("Your saved model is kept");
  expect(onChange).not.toHaveBeenCalled();
});
