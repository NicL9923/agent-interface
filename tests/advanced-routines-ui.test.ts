// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdvancedRoutineFields } from "../src/components/AdvancedRoutineFields";
import { api } from "../src/client-api";
import type { Routine } from "../src/shared/types";
vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (() => ({ api: vi.fn() }))()));
let container: HTMLDivElement;
let root: Root;
let draft: Omit<Routine, "id">;
const initial = { botId: "shared", name: "Morning", prompt: "Check", schedule: "1h", enabled: true,
  model: "old-model", provider: "old-provider", skills: ["saved-skill"], script: "morning.py", enabledToolsets: ["saved-tool"], contextFrom: ["self", "missing"] };
function Editor() {
  const [value, setValue] = useState<Omit<Routine, "id">>(initial); draft = value;
  return createElement(AdvancedRoutineFields, { value, onChange: setValue, editing: "abc", routines: [
    { id: "def", botId: "shared", name: "Weather", prompt: "", schedule: "1h", enabled: true },
    { id: "private", botId: "other", name: "Private", prompt: "", schedule: "1h", enabled: true },
  ] });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset().mockImplementation(async path => (path.includes("models") ? { providers: [
    { id: "connected", name: "Connected", authenticated: true, models: [{ id: "chosen", name: "Chosen", available: true }] },
  ] } : path.includes("skills") ? [{ id: "weather", name: "Weather skill", enabled: true }]
    : [{ id: "file", name: "Files", enabled: true }]) as never);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(Editor)));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function open() { await act(async () => { const details = container.querySelector("details")!; details.open = true; details.dispatchEvent(new Event("toggle")); }); }
async function check(text: string) {
  const label = [...container.querySelectorAll("label")].find(label => label.textContent?.trim() === text)!;
  await act(async () => label.querySelector("input")!.click());
}
it("loads on expansion without changing saved pins, tools, skills, or continuity", async () => {
  expect(api).not.toHaveBeenCalled();
  await open();
  expect(draft).toEqual(initial);
  expect(container.textContent).toContain("saved-skill (saved, unavailable)");
  expect(container.textContent).toContain("saved-tool (saved, unavailable)");
  expect(container.textContent).toContain("missing (saved, unavailable)");
  expect(container.textContent).not.toContain("Private");
  await check("Weather");
  expect(draft.contextFrom).toEqual(["self", "missing", "def"]);
  await check("Run the script without a model");
  expect(draft).toMatchObject({ noAgent: true, model: "old-model", skills: ["saved-skill"], contextFrom: ["self", "missing", "def"] });
});
it("lets users release model and tool overrides explicitly", async () => {
  await open();
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Use assistant model and provider")!.click());
  await check("Use profile tools");
  expect(draft).toMatchObject({ model: null, provider: null, enabledToolsets: null, skills: ["saved-skill"], contextFrom: ["self", "missing"] });
});
it("makes catalog failures retryable while preserving the draft", async () => {
  vi.mocked(api).mockRejectedValue(new Error("Disconnected"));
  await open();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Disconnected");
  expect(draft).toEqual(initial);
  vi.mocked(api).mockResolvedValue([] as never);
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Retry advanced choices")!.click());
  expect(container.textContent).toContain("No skills reported");
  expect(draft).toEqual(initial);
});
