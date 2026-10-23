// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, ApiError, write } from "../src/client-api";
import { AutomationPanel, LearningPanel } from "../src/components/AutomationPanel";
import type { AutomationOverview } from "../src/shared/automation";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn() }))(original)));
let root: Root, container: HTMLDivElement;
const bots = [{ id: "ranch", name: "Ranch", model: "fixture", shared: true, activity: "idle" as const }];
const initial = (): AutomationOverview => ({ botId: "ranch", owner: "Hermes", canManageTriggers: true,
  goals: { supported: true, goal: { title: "Prepare the fall ranch plan", status: "paused", turnsUsed: 20, maxTurns: 20 } },
  tasks: { supported: true, items: [] }, triggers: { supported: true, platformEnabled: true, items: [] },
  skills: { supported: true, approvalRequired: true, installed: [{ name: "ranch-plan", description: "Seasonal planning" }], pending: [{ id: "aabbccdd", summary: "Improve feed check", origin: "background", revision: "a".repeat(64) }] },
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.mocked(api).mockReset(); vi.mocked(write).mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [{ id: "routine", botId: "ranch", name: "Morning check", enabled: true }] : initial());
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (name: string) => Array.from(container.querySelectorAll("button")).find(item => item.textContent?.trim() === name)!;
async function click(name: string) { expect(button(name)).toBeDefined(); await act(async () => button(name).click()); }
async function input(label: string, value: string) {
  const element = Array.from(container.querySelectorAll("label")).find(row => row.firstChild?.textContent === label)!.querySelector("input,textarea") as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function submit() { await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }
async function work() { await act(async () => root.render(createElement(AutomationPanel, { botId: "ranch", bots }))); }

it("resumes a real goal with one stable request ID after an uncertain response", async () => {
  vi.mocked(write).mockRejectedValueOnce(new ApiError("Gateway went away", 502));
  await work(); await click("Resume goal");
  const first = vi.mocked(write).mock.calls[0];
  expect(first[0]).toBe("/bots/ranch/automation/goal/resume");
  expect(first[1]).toEqual({ requestId: expect.any(String) });
  expect(button("Resume goal").disabled).toBe(true);
  expect(container.textContent).toContain("Nothing will be sent again automatically");
  await click("Refresh status");
  vi.mocked(write).mockResolvedValueOnce({ ...initial(), goals: { ...initial().goals, resume: { requestId: (first[1] as { requestId: string }).requestId, status: "accepted" } } });
  await click("Resume goal");
  expect(vi.mocked(write).mock.calls[1][1]).toEqual(first[1]);
});

it("requires conversation review before replacing an uncertain resume with a fresh attempt", async () => {
  const value = initial();
  const previous = crypto.randomUUID();
  value.goals.resume = { requestId: previous, status: "uncertain" };
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  vi.mocked(write).mockResolvedValue({ ...value, goals: { ...value.goals, resume: { requestId: "accepted", status: "accepted" } } });
  await work();
  expect(button("Resume goal").disabled).toBe(true);
  expect(button("Start a new attempt").disabled).toBe(true);
  expect(write).not.toHaveBeenCalled();
  await act(async () => [...container.querySelectorAll("label")].find(row => row.textContent?.includes("I've reviewed the conversation"))!.querySelector("input")!.click());
  await click("Start a new attempt");
  const payload = vi.mocked(write).mock.calls[0][1] as { requestId: string; reviewedInterruption: boolean };
  expect(payload.requestId).not.toBe(previous);
  expect(payload.reviewedInterruption).toBe(true);
  expect(write).toHaveBeenCalledTimes(1);
});

it("retires a resume ID when a later refresh confirms admission", async () => {
  let value = initial();
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  vi.mocked(write).mockRejectedValueOnce(new ApiError("Lost response", 502));
  await work(); await click("Resume goal");
  const previous = (vi.mocked(write).mock.calls[0][1] as { requestId: string }).requestId;
  value = { ...value, goals: { ...value.goals, resume: { requestId: previous, status: "accepted" } } };
  await click("Refresh status");
  vi.mocked(write).mockResolvedValueOnce(value);
  await click("Resume goal");
  expect((vi.mocked(write).mock.calls[1][1] as { requestId: string }).requestId).not.toBe(previous);
});

it("retires a refused cross-goal request without silently reporting a successful resume", async () => {
  vi.mocked(write).mockRejectedValueOnce(new ApiError("This resume belongs to a replaced goal.", 409));
  await work(); await click("Resume goal");
  const previous = (vi.mocked(write).mock.calls[0][1] as { requestId: string }).requestId;
  expect(container.textContent).toContain("belongs to a replaced goal");
  expect(container.textContent).not.toContain("Saved in Hermes.");
  await click("Refresh status"); vi.mocked(write).mockResolvedValueOnce(initial()); await click("Resume goal");
  expect((vi.mocked(write).mock.calls[1][1] as { requestId: string }).requestId).not.toBe(previous);
});

it("requires an explicit whole-goal replacement before discarding native goal details", async () => {
  vi.mocked(write).mockResolvedValue(initial());
  await work(); await click("Replace goal...");
  expect(container.textContent).toContain("removes its native subgoals, completion contracts and verification gates");
  expect(button("Replace with paused goal").disabled).toBe(true);
  await submit(); expect(write).not.toHaveBeenCalled();
  await act(async () => [...container.querySelectorAll("label")].find(row => row.textContent?.includes("Replace the entire standing goal"))!.querySelector("input")!.click());
  await submit();
  expect(write).toHaveBeenCalledWith("/bots/ranch/automation/goal", { title: "Prepare the fall ranch plan", maxTurns: 20 }, "PUT");
});

it("clears task assignment explicitly and shows when the board is truncated", async () => {
  const value = initial();
  value.tasks = { supported: true, truncated: true, limit: 100, items: [{ id: "task", title: "Gate", body: "Inspect", status: "blocked", priority: 0, assignee: "ranch", owner: "ranch", dependencies: [] }] };
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value); vi.mocked(write).mockResolvedValue(value.tasks.items[0]);
  await work();
  expect(container.textContent).toContain("Showing the newest 100 visible tasks");
  await click("Edit task");
  const select = [...container.querySelectorAll("label")].find(row => row.firstChild?.textContent === "Assigned assistant")!.querySelector("select")!;
  await act(async () => { select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await submit();
  expect(write).toHaveBeenCalledWith("/bots/ranch/automation/tasks/task", { title: "Gate", body: "Inspect", priority: 0, assignee: null }, "PATCH");
});

it("keeps task instructions and request ID through an uncertain create, without auto retry", async () => {
  vi.mocked(write).mockRejectedValueOnce(new ApiError("Lost response", 502));
  await work(); await click("New task"); await input("Task title", "Check the east fence"); await input("Instructions", "Read the last inspection report first."); await submit();
  const payload = vi.mocked(write).mock.calls[0][1];
  expect(payload).toMatchObject({ title: "Check the east fence", body: "Read the last inspection report first.", assignee: "ranch", requestId: expect.any(String) });
  expect(button("Create task").disabled).toBe(true);
  expect(container.querySelector("textarea")!.value).toBe("Read the last inspection report first.");
  expect(write).toHaveBeenCalledTimes(1);
  await click("Refresh status"); vi.mocked(write).mockResolvedValueOnce({ ok: true }); await submit();
  expect(vi.mocked(write).mock.calls[1][1]).toEqual(payload);
});

it("shows a new signing secret once and creates a disabled trigger", async () => {
  vi.mocked(write).mockResolvedValueOnce({ subscription: { id: "fence-alert", url: "https://hermes.example.test/hooks/fence-alert" }, secret: "synthetic-secret" });
  await work(); await click("New event trigger"); await input("Trigger ID", "fence-alert"); await input("Description", "Fence alerts"); await input("Event names, separated by commas", "alert, recovery"); await submit();
  expect(write).toHaveBeenCalledWith("/bots/ranch/automation/triggers", { id: "fence-alert", description: "Fence alerts", events: ["alert", "recovery"], routineId: "routine" }, "POST");
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("synthetic-secret");
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  await click("I've saved it"); expect(container.querySelector('input[type="password"]')).toBeNull();
});

it("makes event controls read-only for a non-administrator", async () => {
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [{ id: "routine", botId: "ranch", name: "Morning check" }] : { ...initial(), canManageTriggers: false });
  await work(); expect(button("New event trigger").disabled).toBe(true);
  expect(container.textContent).toContain("Only an integration administrator"); expect(write).not.toHaveBeenCalled();
});

it("approves the displayed diff revision and refuses truncated approval", async () => {
  let truncated = true;
  vi.mocked(api).mockImplementation(async path => path.includes("/skills/pending/") ? { id: "aabbccdd", diff: "+Check water before feed.", revision: "b".repeat(64), truncated } : initial());
  vi.mocked(write).mockResolvedValue({ ok: true });
  await act(async () => root.render(createElement(LearningPanel, { botId: "ranch" })));
  await click("Review change"); expect(button("Approve change").disabled).toBe(true);
  truncated = false; await click("Review change"); await click("Approve change");
  expect(write).toHaveBeenCalledWith("/bots/ranch/automation/skills/pending/aabbccdd", { revision: "b".repeat(64), decision: "approve" }, "POST");
});

it("reports unsupported native capabilities without editable controls", async () => {
  const value = initial(); for (const item of [value.goals, value.tasks, value.triggers]) { item.supported = false; item.reason = "Update and qualify Hermes first."; }
  vi.mocked(api).mockResolvedValue(value);
  await work(); expect(container.textContent).toContain("Update and qualify Hermes first.");
  expect(button("New task")).toBeUndefined(); expect(button("Resume goal")).toBeUndefined(); expect(button("New event trigger")).toBeUndefined();
});

it("retires a failed status refresh once a change and its follow-up status succeed", async () => {
  await work();
  vi.mocked(api).mockRejectedValueOnce(new Error("Hermes is restarting."));
  await click("Refresh status");
  expect(container.textContent).toContain("Hermes is restarting.");
  vi.mocked(write).mockResolvedValueOnce(initial());
  await click("Resume goal");
  expect(container.textContent).toContain("Saved in Hermes.");
  expect(container.textContent).not.toContain("Hermes is restarting.");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
