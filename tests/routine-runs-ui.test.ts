// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api, write } from "../src/client-api";
import { defaultPreferences } from "../src/shared/types";
import type { Bootstrap, Conversation, Message, Preferences } from "../src/shared/types";
import type { RoutineRun } from "../src/shared/routine-runs";
import { FakeEventSource } from "./fake-event-source";
import { advance, mountRoot, stubMatchMedia } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async (original) => ({
  ...await original<typeof import("../src/client-api")>(),
  api: vi.fn(),
  write: vi.fn(),
  uploadFile: vi.fn(),
  clearResponseCache: vi.fn(),
}))(original)));
vi.mock("../src/app/use-chat-presence", () => ({ useChatPresence: vi.fn() }));
vi.mock("../src/components/Avatar", async (original) => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  Avatar: () => createElement("span"),
}));

let preferences: Preferences;
const boot = (): Bootstrap => ({
  user: { id: "one", name: "One", email: "one@example.test" },
  household: [],
  preferences,
  bots: [{ id: "shared", name: "Shared", shared: true, model: "test", activity: "idle" }],
  capabilities: Object.fromEntries(["chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration", "tools", "skills",
    "routines", "durableEvents", "idempotency", "imageGeneration", "stop", "portraitGeneration", "avatarMetadata"]
    .map(key => [key, { supported: true }])) as Bootstrap["capabilities"],
  connection: { connected: true },
  csrfToken: "test",
});
const prompt = (id: string, text: string, createdAt: string): Message => ({ id, role: "user", text, createdAt, sender: { id: "one", name: "One" } });
const answer = (id: string, text: string, createdAt: string): Message => ({ id, role: "assistant", text, createdAt });
const run = (id: string, routineId: string, routineName: string, startedAt: string, extra: Partial<RoutineRun> = {}): RoutineRun =>
  ({ id, routineId, routineName, startedAt, finishedAt: startedAt, status: "succeeded", previewOnly: false, ...extra });
let conversation: Conversation & { earlier?: number };
let runs: RoutineRun[];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
  vi.clearAllMocks();
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia();
  history.replaceState(null, "", "/");
  preferences = { ...defaultPreferences, startPage: "assistant" };
  conversation = { botId: "shared", sessionId: "live", approvals: [], files: [], activity: { state: "idle" }, earlier: 0, messages: [
    prompt("q1", "Plan the week", "2026-10-06T08:00:00Z"), answer("a1", "Here is the week.", "2026-10-06T08:00:10Z"),
    // The morning brief delivered its own run into the chat.
    { id: "d1", role: "user", text: "[Cron delivery: Morning brief]\nRain at noon.", createdAt: "2026-10-06T09:00:20Z" },
    prompt("q2", "Thanks", "2026-10-06T10:00:00Z"), answer("a2", "Any time.", "2026-10-06T10:00:05Z"),
  ] };
  runs = [
    run("c1", "cert", "Certificate check", "2026-10-06T07:00:00Z", { status: "failed", error: "Certificate expires in 2 days.", preview: "FAILED" }),
    run("b1", "brief", "Morning brief", "2026-10-06T09:00:00Z", { finishedAt: "2026-10-06T09:00:15Z" }),
    run("c2", "cert", "Certificate check", "2026-10-06T09:30:00Z", { preview: "All 4 certificates are valid." }),
    run("s1", "supply", "Feed order", "2026-10-06T11:00:00Z", { status: "running", finishedAt: undefined }),
  ];
  vi.mocked(write).mockReset().mockImplementation(async (path: string, body: unknown) => (path === "/preferences" ? body : { id: "saved" }) as never);
  vi.mocked(api).mockImplementation(async <T>(path: string) => {
    const result = path === "/bootstrap?roster=lean" ? boot()
      : path === "/bots/shared/draft" ? { text: "", attachments: [] }
      : path.startsWith("/bots/shared/conversation?") ? conversation
      : path === "/bots/shared/routine-runs" ? { runs, unavailable: [] }
      : path === "/bots/shared/routines/cert/results/c2" ? { previewOnly: false, messages: [{ id: "m1", role: "assistant", text: "All **4** certificates are valid.", files: [{ id: "report", name: "report.txt", mime: "text/plain" }] }] }
      : path === "/routines" ? []
      : null;
    return result as T;
  });
  ({ container, root } = mountRoot());
});

async function render() {
  await act(async () => root.render(createElement(App)));
  await advance(50);
}
const cards = () => [...container.querySelectorAll<HTMLElement>(".routine-run")];
const order = () => [...container.querySelectorAll<HTMLElement>(".routine-run, [data-message-id]")]
  .map(node => node.dataset.runId ? `run:${node.dataset.runId}` : node.dataset.messageId);
const summary = (id: string) => container.querySelector<HTMLButtonElement>(`[data-run-id="${id}"] .routine-run-summary`)!;
const button = (scope: ParentNode, text: string) => [...scope.querySelectorAll("button")].find(item => item.textContent?.trim() === text)!;

describe("routine runs in the conversation", () => {
  it("places each run among the turns by time and leaves out the one its delivery already shows", async () => {
    await render();
    // The brief's run is the delivered message; the transcript shows it once.
    expect(order()).toEqual(["run:c1", "q1", "a1", "d1", "run:c2", "q2", "a2", "run:s1"]);
    expect(cards().map(card => card.className)).toEqual([
      "routine-run run-failed", "routine-run run-succeeded", "routine-run run-running"]);
    // Collapsed: the name, a visible word for runs that need a look, a spoken one otherwise, and one line of output.
    const [failed, valid, running] = cards();
    expect(failed.querySelector(".routine-run-state")!.textContent).toBe("Failed");
    expect(failed.querySelector(".routine-run-preview")!.textContent).toBe("Certificate expires in 2 days.");
    expect(valid.querySelector(".sr-only")!.textContent).toBe("Succeeded");
    expect(valid.querySelector(".routine-run-preview")!.textContent).toBe("All 4 certificates are valid.");
    expect(running.querySelector(".routine-run-state")!.textContent).toBe("Running");
    expect(summary("c2").getAttribute("aria-expanded")).toBe("false");
    expect(vi.mocked(api).mock.calls.some(([path]) => String(path).includes("/results/"))).toBe(false);
  });

  it("opens a run to its output, saves it, and opens its full results", async () => {
    await render();
    await act(async () => summary("c2").click());
    await advance(20);
    const card = container.querySelector<HTMLElement>('[data-run-id="c2"]')!;
    expect(summary("c2").getAttribute("aria-expanded")).toBe("true");
    expect(card.querySelector(".routine-run-preview")).toBeNull();
    expect(card.querySelector(".routine-run-facts")!.textContent).toContain("StatusSucceeded");
    expect(card.querySelector(".routine-run-output strong")!.textContent).toBe("4");
    expect(card.querySelector<HTMLAnchorElement>(".file-link")!.getAttribute("href")).toBe("/api/files/report");
    await act(async () => button(card, "Save output").click());
    await advance(20);
    expect(vi.mocked(write)).toHaveBeenCalledWith("/saved", { kind: "routine", botId: "shared", routineId: "cert", resultId: "c2", title: "Certificate check" });
    expect(card.textContent).toContain("Saved to your saved items.");
    await act(async () => button(card, "All results").click());
    await act(async () => { await vi.dynamicImportSettled(); });
    await advance(50);
    // The full results open at this run.
    expect(vi.mocked(api).mock.calls.map(([path]) => path)).toContain("/bots/shared/routines/cert/results");
  });

  it("hides a routine's runs from this chat with Undo, and honors the saved choice", async () => {
    await render();
    await act(async () => summary("c2").click());
    await advance(20);
    await act(async () => button(container.querySelector('[data-run-id="c2"]')!, "Hide this routine in chat").click());
    await advance(20);
    const saved = vi.mocked(write).mock.calls.filter(([path]) => path === "/preferences").at(-1)![1] as Preferences;
    expect(saved.hiddenRoutineRuns).toEqual([{ botId: "shared", routineId: "cert" }]);
    expect(cards().map(card => card.dataset.runId)).toEqual(["s1"]);
    expect(document.body.textContent).toContain("Hid Certificate check runs from this chat");
    await act(async () => button(document.body, "Undo").click());
    await advance(20);
    const undone = vi.mocked(write).mock.calls.filter(([path]) => path === "/preferences").at(-1)![1] as Preferences;
    expect(undone.hiddenRoutineRuns).toEqual([]);
    expect(cards().map(card => card.dataset.runId)).toEqual(["c1", "c2", "s1"]);
  });

  it("shows only runs inside the loaded history until it reaches the start", async () => {
    conversation.earlier = 4;
    await render();
    // c1 ran before the oldest loaded message; it arrives with the earlier page.
    expect(cards().map(card => card.dataset.runId)).toEqual(["c2", "s1"]);
  });

  it("rereads runs on a new saved message and while one runs", async () => {
    await render();
    const reads = () => vi.mocked(api).mock.calls.filter(([path]) => path === "/bots/shared/routine-runs").length;
    const before = reads();
    runs = runs.map(item => item.id === "s1" ? { ...item, status: "succeeded", finishedAt: "2026-10-06T11:00:20Z", preview: "Ordered 40 bags." } : item);
    await advance(15_000);
    expect(reads()).toBeGreaterThan(before);
    expect(container.querySelector('[data-run-id="s1"]')!.className).toBe("routine-run run-succeeded");
    const settled = reads();
    conversation = { ...conversation, messages: [...conversation.messages, answer("a3", "New reply.", "2026-10-06T11:30:00Z")] };
    await act(async () => FakeEventSource.notifyAll());
    await advance(1500);
    expect(reads()).toBeGreaterThan(settled);
  });
});
