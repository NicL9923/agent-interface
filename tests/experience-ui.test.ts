// @vitest-environment jsdom
import { act, createElement } from "react";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { api, ApiError, write } from "../src/client-api";
import { TodayPanel } from "../src/components/TodayPanel";
import { MemoryPanel, memoryDraftSize } from "../src/components/MemoryPanel";
import { ReplyCards } from "../src/components/ReplyCards";
import { MessageMarkdown } from "../src/components/MessageMarkdown";
import { RoutineEnhancements, RoutineSchedulePreview } from "../src/components/RoutineEnhancements";
import type { ProfileMemory, TodayOverview } from "../src/shared/experience";
import { defaultPreferences } from "../src/shared/types";
import type { Bootstrap } from "../src/shared/types";
import { click, mountRoot, typeInto } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn() }))(original)));
vi.mock("../src/components/Avatar", async original => ({ ...await original<typeof import("../src/components/Avatar")>(), Avatar: () => createElement("span") }));
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  vi.mocked(api).mockReset(); vi.mocked(write).mockReset();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  for (const [name, open] of [["showModal", true], ["close", false]] as const) {
    Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, value: function(this: HTMLDialogElement) { this.open = open; } });
  }
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });

  ({ container, root } = mountRoot());
});
async function render(element: ReactElement) { await act(async () => root.render(element)); }
const bootstrap = { user: { id: "one", name: "One" }, preferences: defaultPreferences, bots: [{ id: "ranch", name: "Ranch", activity: "idle" }] } as Bootstrap;
it("shows every loaded recap event, opens the right assistant and marks only the loaded frontier", async () => {
  const generatedAt = "2026-10-02T02:00:00Z";
  const overview: TodayOverview = { generatedAt, frontier: "40", hasMore: true, since: "2026-10-01T02:00:00Z", unavailableBots: ["offline"],
    items: [{ botId: "offline", botName: "Offline", activity: { state: "disconnected" }, approvals: [], attention: [], files: [], error: "Unavailable" }],
    events: Array.from({ length: 40 }, (_, index) => ({ id: `e${index}`, botId: "ranch", kind: "completed", title: `Result ${index}`, occurredAt: generatedAt })) };
  vi.mocked(api).mockResolvedValue(overview); vi.mocked(write).mockResolvedValue({ ok: true }); const onOpen = vi.fn();
  await render(createElement(TodayPanel, { bootstrap, onOpen }));
  expect(container.textContent).toContain("0 at work"); expect(container.textContent).toContain("Offline · Disconnected");
  expect(container.textContent).toContain("Result 0"); expect(container.textContent).toContain("Result 39");
  await act(async () => Array.from(container.querySelectorAll(".today-row")).find(row => row.querySelector("strong")?.textContent?.startsWith("Result 0"))!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(onOpen).toHaveBeenCalledWith("ranch"); await click("Mark this page caught up");
  expect(write).toHaveBeenCalledWith("/today/seen", { seenAt: generatedAt, frontier: "40" }, "PUT");
});
it("can acknowledge an empty overview without hiding later event arrivals", async () => {
  const generatedAt = "2026-10-02T02:00:00Z";
  vi.mocked(api).mockResolvedValue({ generatedAt, frontier: "0", hasMore: false, since: generatedAt, unavailableBots: [], items: [], events: [] });
  vi.mocked(write).mockResolvedValue({ ok: true });
  await render(createElement(TodayPanel, { bootstrap, onOpen: vi.fn() }));
  await click("Mark caught up");
  expect(write).toHaveBeenCalledWith("/today/seen", { seenAt: generatedAt, frontier: "0" }, "PUT");
});
it("shows when this client last checked, since an unchanged recap keeps its original generatedAt", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date("2026-10-02T02:20:00Z"));
  // A 304 hands back the body loaded earlier, generated 20 minutes ago.
  vi.mocked(api).mockResolvedValue({ generatedAt: "2026-10-02T02:00:00Z", frontier: "0", hasMore: false, since: "2026-10-01T02:00:00Z", unavailableBots: [], items: [], events: [] });
  await render(createElement(TodayPanel, { bootstrap, onOpen: vi.fn() }));
  expect(container.querySelector(".today-timestamp")?.textContent).toBe("Checked just now");
});
it("leads with each request, distinguishes secure requests and lists an active assistant only once", async () => {
  const overview: TodayOverview = { generatedAt: "2026-10-02T02:00:00Z", frontier: "0", hasMore: false,
    since: "2026-10-01T02:00:00Z", unavailableBots: [], events: [], items: [
      { botId: "ranch", botName: "Ranch", activity: { state: "working" }, files: [], attention: [],
        approvals: [{ id: "approval", title: "Add the gate reminder?", detail: "Notify the household", status: "pending" }] },
      { botId: "secure", botName: "Bookkeeper", activity: { state: "blocked" }, files: [], approvals: [],
        attention: [{ id: "login", kind: "secure", title: "Sign in to your bank", detail: "Use a secure request" }] },
      { botId: "garden", botName: "Garden planner", activity: { state: "thinking" }, files: [], approvals: [], attention: [] },
    ] };
  vi.mocked(api).mockResolvedValue(overview);
  const onOpen = vi.fn();
  await render(createElement(TodayPanel, { bootstrap, onOpen }));
  const requests = container.querySelectorAll<HTMLButtonElement>(".today-attention-list .today-row");
  expect(requests).toHaveLength(2);
  expect(requests[0].querySelector("strong")?.textContent).toBe("Add the gate reminder?");
  expect(requests[0].textContent).toContain("Ranch · Approval");
  expect(requests[1].textContent).toContain("Bookkeeper · Secure request");
  expect(requests[1].querySelector(".today-row-action")?.textContent).toBe("Review");
  expect(container.querySelectorAll(".today-row")).toHaveLength(3);
  expect(container.querySelector(".today-summary")?.textContent).toContain("1 at work");
  await act(async () => requests[1].click());
  expect(onOpen).toHaveBeenCalledWith("secure");
});
it("keeps disconnected assistants named and opens their conversation to reconnect", async () => {
  vi.mocked(api).mockResolvedValue({ generatedAt: "2026-10-02T02:00:00Z", frontier: "0", hasMore: false,
    since: "2026-10-01T02:00:00Z", unavailableBots: ["ranch"], events: [], items: [
      { botId: "ranch", botName: "Ranch", activity: { state: "disconnected" }, files: [], approvals: [], attention: [],
        error: "Could not read this Hermes conversation. Open it to reconnect." },
    ] });
  const onOpen = vi.fn();
  await render(createElement(TodayPanel, { bootstrap, onOpen }));
  expect(container.querySelector(".today-summary")?.textContent).toContain("1 need you");
  const row = container.querySelector<HTMLButtonElement>(".today-attention-list .today-row")!;
  expect(row.querySelector("strong")?.textContent).toContain("Open it to reconnect");
  expect(row.textContent).toContain("Ranch · Disconnected");
  expect(row.querySelector(".today-row-action")?.textContent).toBe("Reconnect");
  await act(async () => row.click());
  expect(onOpen).toHaveBeenCalledWith("ranch");
});
it("preserves another document's draft and original revision when saving profile memory", async () => {
  const memory: ProfileMemory = { botId: "ranch", profile: "ranch", scope: "profile", owner: "Hermes", notice: "Existing conversations keep their snapshot.", documents: [
    { target: "memory", label: "Assistant notes", revision: "a".repeat(64), enabled: true, charLimit: 5000, charCount: 5, entries: [{ id: "1", text: "First" }] },
    { target: "user", label: "About you", revision: "b".repeat(64), enabled: true, charLimit: 5000, charCount: 6, entries: [{ id: "2", text: "Second" }] },
  ] };
  vi.mocked(api).mockResolvedValue(memory);
  vi.mocked(write).mockResolvedValueOnce({ ...memory, documents: [
    { ...memory.documents[0], revision: "c".repeat(64), entries: [{ id: "3", text: "Changed first" }] },
    { ...memory.documents[1], revision: "d".repeat(64), entries: [{ id: "4", text: "External edit" }] },
  ] }).mockRejectedValueOnce(new ApiError("Memory changed. Reload before saving.", 409));
  await render(createElement(MemoryPanel, { botId: "ranch" }));
  const fields = container.querySelectorAll<HTMLTextAreaElement>("textarea"); await typeInto(fields[0], "Changed first"); await typeInto(fields[1], "My unsaved second edit");
  await act(async () => container.querySelectorAll<HTMLButtonElement>(".memory-document .primary")[0].click());
  expect(container.querySelectorAll<HTMLTextAreaElement>("textarea")[1].value).toBe("My unsaved second edit");
  await act(async () => container.querySelectorAll<HTMLButtonElement>(".memory-document .primary")[1].click());
  expect(write).toHaveBeenLastCalledWith("/bots/ranch/memory/user", { revision: "b".repeat(64), entries: [{ id: "2", text: "My unsaved second edit" }] }, "PATCH");
  expect(container.textContent).toContain("Your edits are kept"); expect(container.querySelectorAll<HTMLTextAreaElement>("textarea")[1].value).toBe("My unsaved second edit");
});
it("keeps failed checklist edits for retry and loads state for the signed-in account", async () => {
  const card = { id: "groceries", type: "checklist" as const, title: "Groceries", items: [{ id: "milk", text: "Milk" }] };
  vi.mocked(api).mockResolvedValue({ checkedIds: [], notes: {} }); vi.mocked(write).mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce({ checkedIds: ["milk"], notes: {} });
  await render(createElement(ReplyCards, { document: { version: 1, cards: [card] }, botId: "ranch", messageId: "reply", userId: "one" }));
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(container.querySelector<HTMLInputElement>("input")!.checked).toBe(true); expect(container.textContent).toContain("Connection lost");
  await click("Retry saving"); expect(write).toHaveBeenLastCalledWith("/bots/ranch/messages/reply/cards/groceries/state", { checkedIds: ["milk"], notes: {} }, "PUT");
  expect(container.textContent).toContain("1 / 1");
  vi.mocked(api).mockResolvedValue({ checkedIds: [], notes: {} });
  await render(createElement(ReplyCards, { document: { version: 1, cards: [card] }, botId: "ranch", messageId: "reply", userId: "two" }));
  expect(container.querySelector<HTMLInputElement>("input")!.checked).toBe(false);
});
it("preserves interactive state and pending edits when conversation polling rerenders unchanged text", async () => {
  const text = '```agent-ui\n{"version":1,"cards":[{"id":"trip","type":"itinerary","title":"Our trip","items":[{"id":"stop","title":"Lunch"}]}]}\n```';
  vi.mocked(api).mockResolvedValue({ checkedIds: [], notes: {} });
  const props = { text, botId: "ranch", messageId: "reply", userId: "one" };
  await render(createElement(MessageMarkdown, props)); await click("Add note");
  await typeInto(container.querySelector("textarea")!, "Let's leave at noon"); await render(createElement(MessageMarkdown, props));
  expect(container.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Let's leave at noon"); expect(api).toHaveBeenCalledTimes(1);
  await render(createElement(MessageMarkdown, { ...props, unavailable: true }));
  expect(container.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Let's leave at noon"); expect(api).toHaveBeenCalledTimes(1);
});
it("discards a schedule preview if the caller edited the schedule while it was loading", async () => {
  let resolve!: (value: unknown) => void; vi.mocked(write).mockReturnValue(new Promise(done => { resolve = done; })); const ready = vi.fn();
  await render(createElement(RoutineSchedulePreview, { botId: "ranch", schedule: "0 7 * * *", onReady: ready }));
  await click("Preview schedule"); await render(createElement(RoutineSchedulePreview, { botId: "ranch", schedule: "0 8 * * *", onReady: ready }));
  await act(async () => resolve({ botId: "ranch", schedule: "0 7 * * *", timezone: "America/Chicago", kind: "cron", nextRuns: ["2026-10-02T12:00:00Z"] }));
  expect(ready).not.toHaveBeenCalled(); expect(container.textContent).not.toContain("Next runs");
});
it("renders schedules from a native system timezone abbreviation without crashing", async () => {
  vi.mocked(write).mockResolvedValue({ botId: "ranch", schedule: "0 7 * * *", timezone: "CDT", kind: "cron", nextRuns: ["2026-10-02T12:00:00Z"] });
  await render(createElement(RoutineSchedulePreview, { botId: "ranch", schedule: "0 7 * * *" })); await click("Preview schedule");
  expect(container.textContent).toContain("Hermes timezone: CDT"); expect(container.querySelector("ol")!.textContent).toContain("UTC");
});
it("persists a trial admission before dispatch and checks an uncertain run without starting another", async () => {
  const routine = { id: "r1", botId: "ranch", name: "Morning", schedule: "0 7 * * *", prompt: "Report", enabled: true };
  vi.mocked(write).mockImplementation(async (_path, value) => { expect(localStorage.getItem("agent-interface:routine-trial:one:r1")).toBe((value as { requestId: string }).requestId); throw new Error("Timed out"); });
  vi.mocked(api).mockRejectedValue(new ApiError("No receipt yet", 404));
  await render(createElement(RoutineEnhancements, { routine, userId: "one" })); await click("Try once");
  const requestId = localStorage.getItem("agent-interface:routine-trial:one:r1"); expect(requestId).toBeTruthy(); expect(write).toHaveBeenCalledTimes(1);
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent === "Try once")).toBe(false);
  await click("Check run status"); expect(api).toHaveBeenCalledWith(`/routines/r1/runs/${requestId}`); expect(write).toHaveBeenCalledTimes(1);
  await click("Retry the same request"); expect(write).toHaveBeenLastCalledWith("/routines/r1/run", { requestId });
});

function memoryForEditing(): ProfileMemory {
  return { botId: "ranch", profile: "ranch", scope: "profile", owner: "Hermes", notice: "Shared profile.",
    refresh: { revision: "", state: "applied", busy: false, message: "Saved in Hermes. No app memory refresh is pending." },
    documents: [
      { target: "memory", label: "Assistant notes", revision: "a".repeat(64), enabled: true, charLimit: 2200, charCount: 5, entries: [{ id: "1", text: "First" }] },
      { target: "user", label: "About you", revision: "b".repeat(64), enabled: true, charLimit: 1375, charCount: 6, entries: [{ id: "2", text: "Second" }] },
    ] };
}
it("counts Unicode scalars and known separator overhead without guessing unknown overhead", () => {
  const document = { ...memoryForEditing().documents[0], charCount: 11, entries: [{ id: "1", text: "🧑‍🌾" }, { id: "2", text: "élève" }] };
  expect(memoryDraftSize(document, [{ id: "1", text: " 🧑‍🌾 " }, { id: "2", text: "🍏" }])).toBe(7);
  expect(memoryDraftSize(memoryForEditing().documents[0], document.entries)).toBeUndefined();
  expect(memoryDraftSize({ ...document, charCount: 1 }, document.entries)).toBeUndefined();
  expect(memoryDraftSize(document, [])).toBe(0);
});
it("does not announce a save on the first profile read", async () => {
  vi.mocked(api).mockResolvedValue(memoryForEditing());
  await render(createElement(MemoryPanel, { botId: "ranch" }));
  expect(container.textContent).not.toContain("Saved in Hermes.");
  expect(container.textContent).toContain("About this profile");
});
it("keeps conflicted drafts selectable, confirms reload and preserves them if the reload fails", async () => {
  const memory = memoryForEditing(); vi.mocked(api).mockResolvedValue(memory);
  vi.mocked(write).mockRejectedValueOnce(new ApiError("Hermes is being upgraded. Memory edits are paused.", 409));
  await render(createElement(MemoryPanel, { botId: "ranch" }));
  await typeInto(container.querySelector<HTMLTextAreaElement>("textarea")!, "Keep my draft");
  await click("Save memories", container.querySelector(".memory-document")!);
  const field = container.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(field.readOnly).toBe(true); expect(field.disabled).toBe(false); field.focus(); expect(document.activeElement).toBe(field);
  await click("Reload profile memory"); await click("Keep editing");
  expect(api).toHaveBeenCalledTimes(1); expect(field.value).toBe("Keep my draft");
  vi.mocked(api).mockRejectedValueOnce(new Error("Could not reload memory."));
  await click("Reload profile memory"); await click("Reload and discard edits");
  expect(container.textContent).toContain("Could not reload memory.");
  expect(container.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Keep my draft");
  await click("Try loading again"); await click("Reload and discard edits");
  const fresh = container.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(fresh.value).toBe("First"); expect(fresh.readOnly).toBe(false);
});
it("keeps the conflict explained after discarding the edited text", async () => {
  vi.mocked(api).mockResolvedValue(memoryForEditing());
  vi.mocked(write).mockRejectedValueOnce(new ApiError("Reload the newer profile memory.", 409));
  await render(createElement(MemoryPanel, { botId: "ranch" }));
  await typeInto(container.querySelector<HTMLTextAreaElement>("textarea")!, "Edited");
  await click("Save memories", container.querySelector(".memory-document")!); await click("Discard edits");
  expect(container.textContent).not.toContain("Your edits are kept");
  expect(container.textContent).toContain("Reload profile memory before editing again.");
  expect(container.querySelector<HTMLTextAreaElement>("textarea")!.readOnly).toBe(true);
});
it("blocks reload during a document write and restores it when the write settles", async () => {
  const memory = memoryForEditing(); vi.mocked(api).mockResolvedValue(memory);
  let finish!: (memory: ProfileMemory) => void;
  const pending = new Promise<ProfileMemory>(resolve => { finish = resolve; });
  vi.mocked(write).mockReturnValueOnce(pending);
  await render(createElement(MemoryPanel, { botId: "ranch" }));
  await typeInto(container.querySelector<HTMLTextAreaElement>("textarea")!, "Edited");
  await click("Save memories", container.querySelector(".memory-document")!);
  const reload = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Reload profile memory")!;
  expect(reload.disabled).toBe(true); expect(container.textContent).toContain("Saving memories in Hermes...");
  await act(async () => finish({ ...memory, documents: [{ ...memory.documents[0], revision: "c".repeat(64), entries: [{ id: "3", text: "Edited" }] }, memory.documents[1]] }));
  expect(reload.disabled).toBe(false);
});
it("accepts server normalization even when the saved document revision is unchanged", async () => {
  const memory = memoryForEditing(); vi.mocked(api).mockResolvedValue(memory); vi.mocked(write).mockResolvedValue(memory);
  await render(createElement(MemoryPanel, { botId: "ranch" }));
  await typeInto(container.querySelector<HTMLTextAreaElement>("textarea")!, " First ");
  await click("Save memories", container.querySelector(".memory-document")!);
  expect(container.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("First");
  expect(container.querySelector<HTMLButtonElement>(".memory-document .primary")!.disabled).toBe(true);
});
it.each(["saved", "failed"] as const)("keeps the caret in the other document when a write %s", async outcome => {
  const memory = memoryForEditing(); vi.mocked(api).mockResolvedValue(memory);
  let finish!: (value: ProfileMemory) => void, fail!: (reason: Error) => void;
  vi.mocked(write).mockReturnValueOnce(new Promise<ProfileMemory>((resolve, reject) => { finish = resolve; fail = reject; }));
  await render(createElement(MemoryPanel, { botId: "ranch" }));
  await typeInto(container.querySelector<HTMLTextAreaElement>("textarea")!, "Edited first");
  await click("Save memories", container.querySelector(".memory-document")!);
  const other = container.querySelectorAll<HTMLTextAreaElement>("textarea")[1];
  other.focus(); await typeInto(other, "Continue typing in the second document");
  await act(async () => {
    if (outcome === "failed") fail(new Error("Memory write failed."));
    else finish({ ...memory, documents: [{ ...memory.documents[0], revision: "c".repeat(64), entries: [{ id: "3", text: "Edited first" }] }, memory.documents[1]] });
  });
  expect(document.activeElement).toBe(other);
  expect(other.value).toBe("Continue typing in the second document");
});
it("keeps keyboard focus visible at the Memory heading after a clean reload", async () => {
  vi.mocked(api).mockResolvedValue(memoryForEditing());
  await render(createElement(MemoryPanel, { botId: "ranch" }));
  const reload = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Reload profile memory")!;
  reload.focus(); await click("Reload profile memory");
  expect(document.activeElement).toBe(container.querySelector(".memory-intro h2"));
});
it("moves keyboard focus to a newly added memory above its Add button", async () => {
  vi.mocked(api).mockResolvedValue(memoryForEditing());
  await render(createElement(MemoryPanel, { botId: "ranch" }));
  const section = container.querySelector('.memory-document[data-memory-target="memory"]')!;
  await click("Add memory", section);
  expect(document.activeElement).toBe(section.querySelectorAll("textarea")[1]);
});
