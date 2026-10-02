// @vitest-environment jsdom
import { act, createElement } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, ApiError, write } from "../src/client-api";
import { TodayPanel } from "../src/components/TodayPanel";
import { MemoryPanel } from "../src/components/MemoryPanel";
import { ReplyCards } from "../src/components/ReplyCards";
import { MessageMarkdown } from "../src/components/MessageMarkdown";
import { RoutineEnhancements, RoutineSchedulePreview } from "../src/components/RoutineEnhancements";
import type { ProfileMemory, TodayOverview } from "../src/shared/experience";
import { defaultPreferences } from "../src/shared/types";
import type { Bootstrap } from "../src/shared/types";

vi.mock("../src/client-api", async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn() }));
vi.mock("../src/components/Avatar", async original => ({ ...await original<typeof import("../src/components/Avatar")>(), Avatar: () => createElement("span") }));
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.mocked(api).mockReset(); vi.mocked(write).mockReset(); localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });
async function render(element: ReactElement) { await act(async () => root.render(element)); }
async function click(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === text);
  expect(button).toBeDefined(); await act(async () => button!.click());
}
async function type(input: HTMLTextAreaElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
const bootstrap = { user: { id: "one", name: "One" }, preferences: defaultPreferences, bots: [{ id: "ranch", name: "Ranch", activity: "idle" }] } as Bootstrap;
it("shows every loaded recap event, opens the right assistant and marks only the loaded frontier", async () => {
  const generatedAt = "2026-10-02T02:00:00Z";
  const overview: TodayOverview = { generatedAt, frontier: "40", hasMore: true, since: "2026-10-01T02:00:00Z", unavailableBots: ["offline"],
    items: [{ botId: "offline", botName: "Offline", activity: { state: "disconnected" }, approvals: [], attention: [], files: [], error: "Unavailable" }],
    events: Array.from({ length: 40 }, (_, index) => ({ id: `e${index}`, botId: "ranch", kind: "completed", title: `Result ${index}`, occurredAt: generatedAt })) };
  vi.mocked(api).mockResolvedValue(overview); vi.mocked(write).mockResolvedValue({ ok: true }); const onOpen = vi.fn();
  await render(createElement(TodayPanel, { bootstrap, onOpen }));
  expect(container.textContent).toContain("0 at work"); expect(container.textContent).toContain("Couldn't check 1 assistant");
  expect(container.textContent).toContain("Result 0"); expect(container.textContent).toContain("Result 39");
  await act(async () => Array.from(container.querySelectorAll(".today-row")).find(row => row.textContent?.startsWith("Result 0"))!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
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
  const fields = container.querySelectorAll<HTMLTextAreaElement>("textarea"); await type(fields[0], "Changed first"); await type(fields[1], "My unsaved second edit");
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
  await type(container.querySelector("textarea")!, "Let's leave at noon"); await render(createElement(MessageMarkdown, props));
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
