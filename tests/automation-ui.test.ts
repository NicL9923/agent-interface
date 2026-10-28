// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, ApiError, write } from "../src/client-api";
import { AutomationPanel, LearningPanel, likelyCreatedTask } from "../src/components/AutomationPanel";
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
  await work(); await click("Replace goal…");
  expect(container.textContent).toContain("removes its native subgoals, completion contracts and verification gates");
  expect(button("Replace with paused goal").disabled).toBe(true);
  await submit(); expect(write).not.toHaveBeenCalled();
  await act(async () => [...container.querySelectorAll("label")].find(row => row.textContent?.includes("Replace the entire standing goal"))!.querySelector("input")!.click());
  await submit();
  expect(write).toHaveBeenCalledWith("/bots/ranch/automation/goal", { title: "Prepare the fall ranch plan", maxTurns: 20 }, "PUT");
});

it("keeps an uncertain receipt's server message visible after refresh", async () => {
  const value = initial();
  const message = "Admission is still being checked in the canonical conversation.";
  value.goals.resume = { requestId: crypto.randomUUID(), status: "uncertain", message };
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  await work();
  expect(container.textContent).toContain(message);
  const announcement = container.querySelector('[role="status"][aria-label="Resume status"]');
  expect(announcement?.textContent).toBe(message);
  expect([...container.querySelectorAll("p")].filter(node => node.textContent === message && node !== announcement)).toHaveLength(1);
  await click("Refresh status");
  expect(container.querySelector('[role="status"][aria-label="Resume status"]')).toBe(announcement);
  expect([...container.querySelectorAll("p")].filter(node => node.textContent === message && node !== announcement)).toHaveLength(1);
  expect(button("Resume goal").disabled).toBe(true);
  expect(write).not.toHaveBeenCalled();
});

it("shows a rejected receipt loaded from status without a preceding write", async () => {
  const value = initial();
  const message = "The scheduler refused this continuation for a specific reason.";
  value.goals.resume = { requestId: crypto.randomUUID(), status: "rejected", message };
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  await work(); expect(container.textContent).toContain(message);
  await click("Refresh status"); expect(container.textContent).toContain(message);
  expect(write).not.toHaveBeenCalled();
});

it("announces a newly rejected resume without a second visible error", async () => {
  let value = initial();
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  await work();
  const announcement = container.querySelector('[role="status"][aria-label="Resume result"]');
  const message = "The scheduler refused the continuation.";
  value = { ...value, goals: { ...value.goals, resume: { requestId: crypto.randomUUID(), status: "rejected", message } } };
  vi.mocked(write).mockResolvedValueOnce(value);
  await click("Resume goal");
  expect(container.querySelector('[role="status"][aria-label="Resume result"]')).toBe(announcement);
  expect(announcement?.textContent).toBe(message);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect([...container.querySelectorAll("p")].filter(node => node.textContent === message && node !== announcement)).toHaveLength(1);
  await click("Refresh status");
  expect(container.querySelector('[role="status"][aria-label="Resume status"]')?.textContent).toBe("");
  expect(announcement?.textContent).toBe("");
  value = { ...value, goals: { ...value.goals, resume: { requestId: crypto.randomUUID(), status: "rejected", message: "A later continuation was refused." } } };
  vi.mocked(write).mockResolvedValueOnce(value); await click("Resume goal");
  expect(announcement?.textContent).toBe("A later continuation was refused.");
  expect(container.querySelector('[role="status"][aria-label="Resume status"]')?.textContent).toBe("");
});

it("moves clear confirmation focus to Keep and restores it after Keep or Clear", async () => {
  let value = initial(); vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  await work(); const opener = button("Clear goal…");
  await click("Clear goal…"); expect(document.activeElement).toBe(button("Keep goal"));
  await click("Keep goal"); expect(document.activeElement).toBe(opener);
  await click("Clear goal…"); value = { ...value, goals: { ...value.goals, goal: null } }; vi.mocked(write).mockResolvedValueOnce(value);
  await click("Clear goal"); expect(document.activeElement).toBe(button("Set a goal"));
});

it("focuses the replacement objective and restores the opener on Cancel", async () => {
  await work(); const opener = button("Replace goal…");
  await click("Replace goal…"); expect(document.activeElement).toBe(container.querySelector("textarea"));
  expect(button("Resume goal").disabled).toBe(true); expect(button("Clear goal…").disabled).toBe(true);
  await click("Cancel"); expect(document.activeElement).toBe(opener); expect(button("Resume goal").disabled).toBe(false);
});

it("does not announce an accepted receipt on load", async () => {
  const value = initial();
  value.goals.resume = { requestId: crypto.randomUUID(), status: "accepted", runId: "run-1" };
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  await work();
  expect(container.textContent).not.toContain("Resume not confirmed");
  expect(container.textContent).not.toContain("Resume rejected");
  expect(container.querySelector('[role="status"][aria-label="Resume status"]')?.textContent).toBe("");
  expect(container.querySelector('[role="status"][aria-label="Resume result"]')?.textContent).toBe("");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("preserves an unknown native goal status and offers no resume for a done goal", async () => {
  let value = initial(); value.goals.goal!.status = "constructor";
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  await work(); expect(container.textContent).toContain("constructor"); expect(button("Resume goal").disabled).toBe(true);
  value = { ...value, goals: { ...value.goals, goal: { ...value.goals.goal!, status: "done" } } }; await click("Refresh status");
  expect(button("Resume goal")).toBeUndefined();
  expect(container.textContent).toContain("Done");
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
  await work(); await click("New task"); await input("Task title", "Check the east fence"); await input("Instructions (optional)", "Read the last inspection report first."); await submit();
  const payload = vi.mocked(write).mock.calls[0][1];
  expect(payload).toMatchObject({ title: "Check the east fence", body: "Read the last inspection report first.", assignee: "ranch", requestId: expect.any(String) });
  expect(button("Create task").disabled).toBe(true);
  expect(document.activeElement?.textContent).toContain("Not confirmed. Hermes may have created this task.");
  expect(container.querySelector("textarea")!.value).toBe("Read the last inspection report first.");
  expect(write).toHaveBeenCalledTimes(1);
  await click("Refresh status");
  expect(document.activeElement?.textContent).toContain("No new task with this title is visible.");
  expect(container.querySelector('[aria-label="Task result"]')?.textContent).toContain("Create task sends the same request again.");
  vi.mocked(write).mockResolvedValueOnce({ ok: true }); await submit();
  expect(vi.mocked(write).mock.calls[1][1]).toEqual(payload);
  await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  expect(document.activeElement).toBe(button("New task"));
});

it("shows a new signing secret once and creates a disabled trigger", async () => {
  vi.mocked(write).mockResolvedValueOnce({ subscription: { id: "fence-alert", url: "https://hermes.example.test/hooks/fence-alert" }, secret: "synthetic-secret" });
  await work(); await click("New event trigger"); await input("Trigger ID", "fence-alert"); await input("Description", "Fence alerts"); await input("Event names, separated by commas", "alert, recovery"); await submit();
  expect(write).toHaveBeenCalledWith("/bots/ranch/automation/triggers", { id: "fence-alert", description: "Fence alerts", events: ["alert", "recovery"], routineId: "routine" });
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
  expect(write).toHaveBeenCalledWith("/bots/ranch/automation/skills/pending/aabbccdd", { revision: "b".repeat(64), decision: "approve" });
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

const task = (id: string, status: string, dependencies: string[] = []) => ({ id, title: `Task ${id}`, body: "Instructions", status, priority: 0, assignee: null, owner: "ranch", dependencies });
async function openTask(id: string) {
  const summary = [...container.querySelectorAll(".automation-task > summary")].find(item => item.textContent?.includes(`Task ${id}`)) as HTMLElement;
  expect(summary).toBeDefined(); await act(async () => summary.click());
}
it("groups task statuses, preserves unknown statuses, and keeps running tasks read-only", async () => {
  const value = initial(); value.tasks.items = [task("done", "done"), task("todo", "todo"), task("unknown", "future_state"), task("running", "running", ["todo"])];
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  await work();
  expect([...container.querySelectorAll(".automation-task-group-toggle")].map(item => item.textContent)).toEqual(["Running · 1", "To do · 1", "Future State · 1", "Done · 1"]);
  await openTask("running");
  const card = [...container.querySelectorAll(".automation-task")].find(item => item.textContent?.includes("Task running"))!;
  expect(card.textContent).toContain("Task todo · To do");
  expect(card.textContent).toContain("A Hermes worker is running this task");
  expect(card.querySelectorAll("button")).toHaveLength(0);
});

it("reconciles a task refusal locally and preserves goal controls and partial updates", async () => {
  let value = initial(); value.tasks.items = [task("one", "blocked")];
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  await work(); await openTask("one");
  value = { ...value, tasks: { ...value.tasks, items: [{ ...task("one", "ready"), body: "Updated before refusal" }] } };
  vi.mocked(write).mockRejectedValueOnce(new ApiError("Exact server refusal.", 409));
  await click("Start task");
  expect(container.textContent).toContain("Updated before refusal");
  const card = container.querySelector<HTMLDetailsElement>(".automation-task")!;
  expect(card.open).toBe(true); expect(card.textContent).toContain("Exact server refusal. Status refreshed.");
  expect(document.activeElement).toBe(card.querySelector(".automation-task-feedback"));
  expect(container.querySelector('[aria-label="Task result"]')?.textContent).toContain("Exact server refusal.");
  expect(button("Resume goal").disabled).toBe(false); expect(button("Replace goal…").disabled).toBe(false); expect(button("Clear goal…").disabled).toBe(false);
  expect(vi.mocked(api).mock.calls.filter(([path]) => path === "/bots/ranch/automation")).toHaveLength(2);
  await click("Refresh status"); expect(card.textContent).not.toContain("Exact server refusal.");
});

it("locks changes when task refusal reconciliation fails", async () => {
  const value = initial(); value.tasks.items = [task("one", "blocked")];
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  await work(); await openTask("one");
  vi.mocked(write).mockRejectedValueOnce(new ApiError("Refused", 409));
  vi.mocked(api).mockRejectedValueOnce(new Error("Offline"));
  await click("Start task");
  expect(button("Resume goal").disabled).toBe(true);
  expect(container.textContent).toContain("status could not refresh");
  expect(container.textContent).toContain("Not confirmed. Use Refresh status");
});

it("keeps a moved task open, focused and announced and sends only chosen action fields", async () => {
  let value = initial(); value.tasks.items = [task("one", "blocked")];
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  await work(); await openTask("one");
  value = { ...value, tasks: { ...value.tasks, items: [task("one", "ready")] } };
  vi.mocked(write).mockResolvedValueOnce(value.tasks.items[0]); await click("Start task");
  expect(vi.mocked(write).mock.calls[0][1]).toEqual({ action: "start" });
  const card = container.querySelector<HTMLDetailsElement>(".automation-task")!;
  expect(card.open).toBe(true); expect(card.textContent).toContain("Moved to Ready."); expect(document.activeElement).toBe(card.querySelector(".automation-task-feedback"));
  expect(container.querySelector('[aria-label="Task result"]')?.textContent).toBe("Moved to Ready.");
  await click("Block task…"); expect(container.textContent).toContain("What is blocking this task?");
  await click("Request review…"); expect(container.textContent).not.toContain("What is blocking this task?"); expect(container.textContent).toContain("Notes for the reviewer (optional)");
});

it("sends an optional start note and sends a reviewer only with a review request", async () => {
  const value = initial(); value.tasks.items = [task("one", "blocked")];
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  vi.mocked(write).mockResolvedValue(value.tasks.items[0]);
  await work(); await openTask("one"); await input("Start note", "Start after lunch"); await click("Start task");
  expect(vi.mocked(write).mock.calls[0][1]).toEqual({ action: "start", reason: "Start after lunch" });
  await click("Request review…");
  const select = [...container.querySelectorAll("label")].find(row => row.firstChild?.textContent === "Reviewer")!.querySelector("select")!;
  await act(async () => { select.value = "ranch"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await input("Notes for the reviewer (optional)", "Check the gate"); await click("Request review");
  expect(vi.mocked(write).mock.calls[1][1]).toEqual({ action: "request_review", reviewer: "ranch", reason: "Check the gate" });
});


it("reveals a moved task in a previously collapsed status group", async () => {
  let value = initial(); value.tasks.items = [task("one", "blocked"), task("two", "ready")];
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  await work(); await click("Ready · 1"); await openTask("one");
  value = { ...value, tasks: { ...value.tasks, items: [task("one", "ready"), task("two", "ready")] } };
  vi.mocked(write).mockResolvedValueOnce(value.tasks.items[0]); await click("Start task");
  expect(button("Ready · 2").getAttribute("aria-expanded")).toBe("true");
  const card = container.querySelector<HTMLDetailsElement>('[data-task-id="one"]')!;
  expect(card.open).toBe(true); expect(document.activeElement).toBe(card.querySelector(".automation-task-feedback"));
});

it("retires a task refusal when another task closes its card", async () => {
  const value = initial(); value.tasks.items = [task("one", "blocked"), task("two", "ready")];
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  await work(); await openTask("one"); vi.mocked(write).mockRejectedValueOnce(new ApiError("Old task refusal.", 409));
  await click("Start task"); expect(container.textContent).toContain("Old task refusal.");
  await openTask("two"); await openTask("one");
  expect(container.textContent).not.toContain("Old task refusal.");
});

it("does not send review notes with a different Start action", async () => {
  const value = initial(); value.tasks.items = [task("one", "blocked")];
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  vi.mocked(write).mockResolvedValue(value.tasks.items[0]);
  await work(); await openTask("one"); await click("Request review…");
  await input("Notes for the reviewer (optional)", "Review this first"); await click("Start task");
  expect(vi.mocked(write).mock.calls[0][1]).toEqual({ action: "start" });
});


it("shows vanished-task feedback at the board heading and focuses that heading", async () => {
  let value = initial(); value.tasks.items = [task("one", "blocked")];
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  await work(); await openTask("one"); value = { ...value, tasks: { ...value.tasks, items: [] } };
  vi.mocked(write).mockRejectedValueOnce(new ApiError("Task not found.", 404)); await click("Start task");
  expect(container.querySelector(".automation-tasks > .automation-task-feedback")?.textContent).toContain("Task one: Task not found. Status refreshed.");
  expect(document.activeElement).toBe(container.querySelector(".automation-tasks > h3"));
});

it("keeps dependency results beside their controls and focuses the result", async () => {
  let value = initial(); value.tasks.items = [task("one", "blocked"), task("two", "ready")];
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  vi.mocked(write).mockResolvedValue({});
  await work(); await openTask("one");
  const select = container.querySelector<HTMLSelectElement>(".automation-task-add select")!;
  await act(async () => { select.value = "two"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  value = { ...value, tasks: { ...value.tasks, items: [task("one", "blocked", ["two"]), task("two", "ready")] } };
  await click("Add dependency");
  const card = container.querySelector<HTMLDetailsElement>('[data-task-id="one"]')!;
  expect(card.querySelector(".automation-task-dependencies .automation-task-feedback")?.textContent).toBe("Saved in Hermes.");
  expect(card.querySelector(".automation-task-move .automation-task-feedback")).toBeNull();
  expect(document.activeElement).toBe(card.querySelector(".automation-task-feedback"));
  value = { ...value, tasks: { ...value.tasks, items: [task("one", "blocked"), task("two", "ready")] } };
  await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="Remove dependency on Task two"]')!.click());
  expect(card.querySelector(".automation-task-dependencies .automation-task-feedback")?.textContent).toBe("Saved in Hermes.");
  expect(card.querySelector(".automation-task-move .automation-task-feedback")).toBeNull();
  expect(document.activeElement).toBe(card.querySelector(".automation-task-feedback"));
});

it("returns focus to the chosen task action when its form is cancelled", async () => {
  const value = initial(); value.tasks.items = [task("one", "blocked")];
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  await work(); await openTask("one");
  for (const name of ["Block task…", "Request review…"]) {
    await click(name); expect(button(name).getAttribute("aria-expanded")).toBe("true");
    button("Cancel").focus(); await click("Cancel");
    expect(document.activeElement).toBe(button(name)); expect(button(name).getAttribute("aria-expanded")).toBe("false");
  }
});

it("does not reopen a task or steal focus when its late result arrives", async () => {
  let value = initial(); value.tasks.items = [task("one", "blocked"), task("two", "ready")];
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  let complete!: (result: unknown) => void; vi.mocked(write).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  await work(); await openTask("one"); await click("Start task"); await openTask("two");
  const second = container.querySelector<HTMLDetailsElement>('[data-task-id="two"]')!; second.querySelector<HTMLElement>("summary")!.focus();
  value = { ...value, tasks: { ...value.tasks, items: [task("one", "ready"), task("two", "ready")] } };
  await act(async () => complete(value.tasks.items[0]));
  expect(second.open).toBe(true); expect(document.activeElement).toBe(second.querySelector("summary"));
  expect(container.querySelector<HTMLDetailsElement>('[data-task-id="one"]')?.open).toBe(false);
});


it("matches only a new task with the exact submitted title", () => {
  const items = [task("known", "blocked"), { ...task("new", "blocked"), title: "Fence" }];
  expect(likelyCreatedTask(["known"], "Fence", items)?.id).toBe("new");
  expect(likelyCreatedTask(["known", "new"], "Fence", items)).toBeUndefined();
  expect(likelyCreatedTask([], "fence", items)).toBeUndefined();
  expect(likelyCreatedTask([], "Fence ", items)).toBeUndefined();
});

it("focuses the create title and returns focus on cancel", async () => {
  await work(); await click("New task");
  expect(document.activeElement).toBe(container.querySelector('form[aria-labelledby="new-task-heading"] input'));
  await click("Cancel"); await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  expect(document.activeElement).toBe(button("New task"));
});

it("locks edit fields during a pending save and reports success beside edit", async () => {
  let value = initial(); value.tasks.items = [task("one", "blocked")];
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  let complete!: (value: unknown) => void;
  vi.mocked(write).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  await work(); await openTask("one"); await click("Edit task"); await input("Task title", "Edited title");
  await submit();
  const form = container.querySelector<HTMLFormElement>('form[aria-labelledby^="edit-task-"]')!;
  expect([...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, textarea, select")].every(field => field.disabled)).toBe(true);
  expect(button("Saving…").disabled).toBe(true);
  value = { ...value, tasks: { ...value.tasks, items: [{ ...task("one", "blocked"), title: "Edited title" }] } };
  await act(async () => complete(value.tasks.items[0]));
  const feedback = container.querySelector<HTMLElement>('.automation-task-feedback')!;
  expect(form.isConnected).toBe(false); expect(feedback.textContent).toBe("Saved in Hermes.");
  expect(document.activeElement).toBe(feedback); expect(container.querySelector('[aria-label="Task result"]')?.textContent).toBe("Saved in Hermes.");
});

it("keeps an edit draft after a local refusal and reconciles a running task", async () => {
  let value = initial(); value.tasks.items = [task("one", "blocked"), task("two", "ready")];
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  await work(); await openTask("one"); await click("Edit task"); await input("Task title", "Draft title");
  vi.mocked(write).mockRejectedValueOnce(new ApiError("Refused.", 409)); await submit();
  expect(container.querySelector<HTMLInputElement>('form[aria-labelledby^="edit-task-"] input')?.value).toBe("Draft title");
  expect(container.querySelector('.automation-task-feedback')?.textContent).toContain("Refused. Status refreshed.");
  expect(button("Resume goal").disabled).toBe(false); expect(button("Start task").disabled).toBe(false);
  value = { ...value, tasks: { ...value.tasks, items: [task("one", "running"), task("two", "ready")] } };
  vi.mocked(write).mockRejectedValueOnce(new ApiError("Worker owns it.", 409)); await submit();
  expect(container.querySelector('form[aria-labelledby^="edit-task-"]')).toBeNull();
  expect(container.textContent).toContain("A Hermes worker is running this task");
  expect(container.querySelector('.automation-task-move .automation-task-feedback')?.textContent).toContain("Worker owns it.");
  expect(button("Resume goal").disabled).toBe(false);
  value = { ...value, tasks: { ...value.tasks, items: [task("one", "ready"), task("two", "ready")] } };
  await click("Refresh status");
  expect(container.querySelector('form[aria-labelledby^="edit-task-"]')).toBeNull();
  expect(button("Edit task")).toBeDefined();
});

it("keeps other actions out of a reviewed create attempt and its busy labels", async () => {
  const value = initial(); value.tasks.items = [task("one", "blocked")];
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  vi.mocked(write).mockRejectedValueOnce(new ApiError("Lost create response", 502));
  await work(); await click("New task"); await input("Task title", "A new fence"); await submit();
  await click("Refresh status");
  expect(document.activeElement?.textContent).toContain("No new task with this title is visible.");
  await openTask("one"); await click("Edit task");
  let fail!: (error: Error) => void;
  vi.mocked(write).mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
  await click("Start task");
  expect(button("Create task").disabled).toBe(true); expect(button("Creating…")).toBeUndefined();
  expect(button("Save task").disabled).toBe(true); expect(button("Saving…")).toBeUndefined();
  await act(async () => fail(new ApiError("Lost move response", 502)));
  const form = container.querySelector('form[aria-labelledby="new-task-heading"]')!;
  expect(form.querySelector('.automation-task-callout')).toBeNull();
  expect(form.textContent).not.toContain("Hermes may have created this task");
  expect(document.activeElement?.textContent).not.toContain("Hermes may have created this task");
  expect(write).toHaveBeenCalledTimes(2);
});

it("waits for the create review result before moving focus from Refresh status", async () => {
  const value = initial();
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  vi.mocked(write).mockRejectedValueOnce(new ApiError("Lost create response", 502));
  await work(); await click("New task"); await input("Task title", "A new fence"); await submit();
  let finish!: (result: AutomationOverview) => void;
  vi.mocked(api).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const refresh = button("Refresh status"); refresh.focus(); await click("Refresh status");
  expect(document.activeElement).toBe(refresh);
  await act(async () => finish(value));
  expect(document.activeElement?.textContent).toContain("No new task with this title is visible.");
  expect(write).toHaveBeenCalledTimes(1);
});

it.each([false, true])("keeps a successful move focused after create review (match=%s)", async match => {
  let value = initial(); value.tasks.items = [task("one", "blocked")];
  vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  vi.mocked(write).mockRejectedValueOnce(new ApiError("Lost create response", 502));
  await work(); await click("New task"); await input("Task title", "A new fence"); await submit();
  const appeared = { ...task("new", "blocked"), title: "A new fence" };
  if (match) value = { ...value, tasks: { ...value.tasks, items: [...value.tasks.items, appeared] } };
  await click("Refresh status");
  expect(document.activeElement?.textContent).toContain(match ? "A task with this title appeared" : "No new task with this title");
  await openTask("one");
  let complete!: (result: unknown) => void;
  vi.mocked(write).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  await click("Start task");
  value = { ...value, tasks: { ...value.tasks, items: [task("one", "ready"), ...(match ? [appeared] : [])] } };
  await act(async () => complete({ ok: true }));
  const feedback = container.querySelector<HTMLElement>('[data-task-id="one"] .automation-task-feedback')!;
  expect(feedback.textContent).toBe("Moved to Ready.");
  expect(document.activeElement).toBe(feedback);
  expect(container.querySelector('[aria-label="Task result"]')?.textContent).toBe("Moved to Ready.");
  expect(write).toHaveBeenCalledTimes(2);
});

it("creates, opens and announces the new task and resets the next draft", async () => {
  let value = initial(); vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  await work(); await click("New task"); await input("Task title", "Fence");
  const created = { ...task("new", "blocked"), title: "Fence" };
  value = { ...value, tasks: { ...value.tasks, items: [created] } }; vi.mocked(write).mockResolvedValueOnce(created);
  await submit(); const first = vi.mocked(write).mock.calls[0][1] as { requestId: string };
  const card = container.querySelector<HTMLDetailsElement>('[data-task-id="new"]')!;
  expect(card.open).toBe(true); expect(document.activeElement).toBe(card.querySelector('.automation-task-feedback'));
  expect(container.querySelector('[aria-label="Task result"]')?.textContent).toBe('Created. "Fence" stays blocked until you start it.');
  await click("New task"); expect(container.querySelector<HTMLInputElement>('form[aria-labelledby="new-task-heading"] input')?.value).toBe("");
  await input("Task title", "Another"); vi.mocked(write).mockResolvedValueOnce(created); await submit();
  expect((vi.mocked(write).mock.calls[1][1] as { requestId: string }).requestId).not.toBe(first.requestId);
});

it("locks an uncertain create when a likely match appears and closes without another POST", async () => {
  let value = initial(); vi.mocked(api).mockImplementation(async path => path === "/routines" ? [] : value);
  vi.mocked(write).mockRejectedValueOnce(new ApiError("Lost", 502));
  await work(); await click("New task"); await input("Task title", "Fence"); await submit();
  value = { ...value, tasks: { ...value.tasks, items: [{ ...task("new", "blocked"), title: "Fence" }] } };
  await click("Refresh status");
  expect(container.textContent).toContain("A task with this title appeared on the board.");
  expect(document.activeElement?.textContent).toContain("A task with this title appeared on the board.");
  expect(container.querySelector('[aria-label="Task result"]')?.textContent).toContain("Hermes may have saved it.");
  expect(container.querySelector<HTMLInputElement>('form[aria-labelledby="new-task-heading"] input')?.disabled).toBe(true);
  expect(button("Create task")).toBeUndefined(); expect(container.querySelector('.automation-task-choices input')).toBeNull();
  await click("Close"); const card = container.querySelector<HTMLDetailsElement>('[data-task-id="new"]')!;
  expect(card.open).toBe(true); expect(document.activeElement).toBe(card.querySelector('.automation-task-feedback'));
  expect(card.querySelector('.automation-task-feedback')?.textContent).toBe('"Fence" appeared on the board. Hermes may have saved it.');
  expect(container.querySelector('[aria-label="Task result"]')?.textContent).toBe('"Fence" appeared on the board. Hermes may have saved it.');
  expect(write).toHaveBeenCalledTimes(1);
});
