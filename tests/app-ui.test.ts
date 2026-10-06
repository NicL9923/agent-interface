// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api, clearResponseCache, write } from "../src/client-api";
import { defaultPreferences } from "../src/shared/types";
import type { Bootstrap, Conversation } from "../src/shared/types";

vi.mock("../src/client-api", async (original) => ({
  ...await original<typeof import("../src/client-api")>(),
  api: vi.fn(),
  write: vi.fn().mockResolvedValue({}),
  clearResponseCache: vi.fn(),
}));
const renders = vi.hoisted(() => ({ avatar: 0 }));
// SVG geometry and animation are browser concerns, not part of these state regressions.
vi.mock("../src/components/Avatar", async (original) => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  Avatar: (props: { state?: string; size?: number }) => (renders.avatar++, createElement("span", {
    "data-avatar-state": props.state, "data-avatar-size": props.size,
  })),
}));

const bootstrap: Bootstrap = {
  user: { id: "one", name: "One", email: "one@example.test" },
  household: [],
  preferences: {...defaultPreferences,startPage:"assistant"},
  bots: [{ id: "shared", name: "Shared", shared: true, model: "test", activity: "idle" }],
  capabilities: Object.fromEntries([
    "chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration",
    "tools", "skills", "routines", "durableEvents", "idempotency", "imageGeneration",
    "stop", "portraitGeneration", "avatarMetadata",
  ].map((key) => [key, { supported: true }])) as Bootstrap["capabilities"],
  connection: { connected: true },
  csrfToken: "test",
};
const savedDraft = { text: "My saved server draft", attachments: [] };
let conversation: Conversation;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
  localStorage.clear();
  history.replaceState(null, "", "/");
  conversation = {
    botId: "shared", messages: [], approvals: [], files: [],
    activity: { state: "interrupted", runId: "old-run" },
  };
  vi.mocked(api).mockImplementation(async <T>(path: string) => {
    const result = path === "/bootstrap" ? bootstrap
      : path === "/bots/shared/draft" ? savedDraft
      : path === "/bots/shared/conversation" ? conversation
      : null;
    return result as T;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(createElement(App)));
}

async function advance(milliseconds: number) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
}

const reviewCheckbox = () => container.querySelector<HTMLInputElement>(".interruption-review input")!;
const sendButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;

describe("conversation state", () => {
  it("preserves a pending secure form across polling while keeping credentials out of the chat draft", async () => {
    const secure = { method: "vault.save_login" as const, epoch: "current", sessionId: "session", origin: "https://example.invalid", site: "Example" };
    conversation = { ...conversation, attention: [{ id: "login-request", kind: "secure", title: "Save login", detail: "Native request", secure }] };
    await render();
    const password = container.querySelector<HTMLInputElement>('.secure-request input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(password, "synthetic-pending-secret");
      password.dispatchEvent(new Event("input", { bubbles: true }));
    });
    conversation = { ...conversation, attention: [{ ...conversation.attention![0], secure: { ...secure } }] };
    await advance(8000);
    expect(container.querySelector<HTMLInputElement>('.secure-request input[type="password"]')!.value).toBe("synthetic-pending-secret");
    expect(container.querySelector("textarea")!.value).toBe(savedDraft.text);
    expect(write).not.toHaveBeenCalled();
    expect(JSON.stringify(Object.values(localStorage))).not.toContain("synthetic-pending-secret");
    conversation = { ...conversation, attention: [{ ...conversation.attention![0], secure: { ...secure, sessionId: "replacement" } }] };
    await advance(1500);
    expect(container.querySelector<HTMLInputElement>('.secure-request input[type="password"]')!.value).toBe("");
  });

  it("removes this device's push registration and browser subscription before signing out", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
    const order: string[] = [];
    const endpoint = "https://push.example.invalid/this-device";
    vi.stubGlobal("navigator", { onLine: true, serviceWorker: {
      getRegistration: vi.fn(async () => ({ pushManager: { getSubscription: vi.fn(async () => ({ endpoint,
        unsubscribe: vi.fn(async () => { order.push("unsubscribe"); return true; }),
      })) } })), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } });
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string) => path === "/auth/config" ? { localDevAuth: true } as T : original(path) as Promise<T>);
    vi.mocked(write).mockImplementation(async <T>(path: string) => { order.push(path); return {} as T; });
    await render();
    await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "Preferences")!.click());
    await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "Sign out")!.click());
    expect(write).toHaveBeenCalledWith("/push/subscriptions", { endpoint }, "DELETE");
    expect(order).toEqual(["/push/subscriptions", "unsubscribe", "/auth/logout"]);
    expect(clearResponseCache).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".sign-in")).not.toBeNull();
    vi.mocked(write).mockReset().mockResolvedValue({});
  });

  it("keeps one integrations dialog across repeated household refreshes", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string) => path.startsWith("/integrations") ? { profile: "shared", canManage: true, connections: [] } as T : original(path) as Promise<T>);
    await render();
    await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "Integrations")!.click());
    await advance(30_000);
    expect(container.querySelectorAll(".integrations-panel")).toHaveLength(1);
    expect(container.querySelectorAll(".hermes-upgrade-panel")).toHaveLength(1);
  });

  it("does not re-render the app when bootstrap and conversation polls are unchanged", async () => {
    await render();
    await advance(2000);
    const settled = renders.avatar;
    expect(settled).toBeGreaterThan(0);
    await advance(16_000);
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === "/bootstrap").length).toBeGreaterThanOrEqual(3);
    expect(renders.avatar).toBe(settled);
  });

  it("shows current work inline in the transcript and stops claiming work during a disconnect", async () => {
    conversation = { ...conversation, activity: { state: "working", detail: "Running terminal" } };
    await render();
    expect(container.querySelector('.transcript .conversation-activity [data-avatar-size="52"]')?.getAttribute("data-avatar-state")).toBe("working");
    expect(container.querySelector(".activity-copy")?.textContent).toContain("Shared is running terminal...");
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!;
    await act(async () => stop.click());
    expect(write).toHaveBeenCalledWith("/bots/shared/stop", {});
    vi.mocked(api).mockImplementation(async <T>(path: string) => {
      if (path === "/bots/shared/conversation") throw new Error("Disconnected");
      return (path === "/bootstrap" ? bootstrap : savedDraft) as T;
    });
    await advance(1500);
    expect(container.querySelector('.conversation-activity [data-avatar-size="52"]')?.getAttribute("data-avatar-state")).toBe("disconnected");
    expect(container.querySelector(".activity-copy")?.textContent).not.toContain("Shared is running terminal...");
  });

  it("switches Stop back to Send while drafting guidance", async () => {
    conversation = { ...conversation, activity: { state: "working" } };
    await render();
    const textarea = container.querySelector("textarea")!;
    const type = (text: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[aria-label="Send guidance"]')).not.toBeNull();
    await type(""); expect(container.querySelector('[aria-label="Stop response"]')).not.toBeNull();
    await type("Try the other file"); expect(container.querySelector('[aria-label="Send guidance"]')).not.toBeNull();
    await type(" "); expect(container.querySelector('[aria-label="Stop response"]')).not.toBeNull();
  });

  it("counts history and live tools once and groups delegated work separately", async () => {
    const call = { id: "lookup", name: "web", status: "completed" as const, result: "Found it" };
    conversation = { ...conversation, activity: { state: "working" }, messages: [
      { id: "question", role: "user", text: "Find it" },
      { id: "tool-row", role: "tool", text: "Found it", toolCall: call },
      { id: "handoff", role: "tool", text: "Done", toolCall: { id: "worker", name: "delegate_task", status: "completed", result: "Done" } },
    ], toolCalls: [call, { id: "second", name: "terminal", status: "running" }] };
    await render();
    const groups = [...container.querySelectorAll<HTMLDetailsElement>(".tool-calls")];
    expect(groups.map(group => group.querySelector("summary")?.textContent)).toEqual(["Tool calls2Running", "Subagents1"]);
    expect(groups.every(group => !group.open)).toBe(true);
    expect(container.querySelectorAll('.tool-call-detail, .action-receipt')).toHaveLength(3);
    expect(container.textContent).toContain("Found it");
  });

  it("preserves separate historical tool results and files when Hermes reuses a call ID", async () => {
    conversation = { ...conversation, activity: { state: "done" }, messages: [
      { id: "question", role: "user", text: "Get both reports" },
      { id: "first-row", role: "tool", text: "First", toolCall: { id: "reused", name: "terminal", status: "completed", result: "First result" } },
      { id: "second-row", role: "tool", text: "Second", toolCall: { id: "reused", name: "terminal", status: "completed", result: "Second result" }, files: [{ id: "report", name: "report.txt", mime: "text/plain" }] },
    ] };
    await render();
    expect(container.querySelector(".tool-count")?.textContent).toBe("2");
    expect(container.textContent).toContain("First result"); expect(container.textContent).toContain("Second result");
    expect(container.querySelector('.tool-calls a')?.textContent).toContain("report.txt");
  });

  it("shows Send for an attachment-only draft while the assistant works", async () => {
    conversation = { ...conversation, activity: { state: "working" } };
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string) => path.endsWith("/draft")
      ? { text: "", attachments: [{ id: "document", name: "report.txt", mime: "text/plain" }] } as T : original(path) as Promise<T>);
    await render();
    expect(container.querySelector('[aria-label="Send guidance"]')).not.toBeNull();
  });

  it("keeps an unanswered Stop isolated when switching assistants", async () => {
    const other = { ...bootstrap.bots[0], id: "other", name: "Other" };
    bootstrap.bots.push(other);
    try {
      conversation = { ...conversation, activity: { state: "working" } };
      const original = vi.mocked(api).getMockImplementation()!;
      vi.mocked(api).mockImplementation(async <T>(path: string) => path.endsWith("/draft") ? { text: "", attachments: [] } as T
        : path === "/bots/other/conversation" ? { ...conversation, botId: "other" } as T : original(path) as Promise<T>);
      let reject!: (error: Error) => void;
      vi.mocked(write).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
      await render(); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!.click());
      expect(container.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!.disabled).toBe(true);
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".bot-item")].find(button => button.textContent?.includes("Other"))!.click());
      expect(container.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!.disabled).toBe(false);
      await act(async () => reject(new Error("Previous assistant failed")));
      expect(container.textContent).not.toContain("Previous assistant failed");
    } finally { bootstrap.bots.pop(); vi.mocked(write).mockReset().mockResolvedValue({}); }
  });

  it("shows approval submission immediately, blocks duplicate decisions and allows retry after failure", async () => {
    conversation = { ...conversation, approvals: [{ id: "approval", title: "Run action?", detail: "Details", status: "pending" }] };
    let reject!: (error: Error) => void;
    vi.mocked(write).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    await render();
    const [approve, decline] = [...container.querySelectorAll<HTMLButtonElement>(".approval-card button")];
    await act(async () => approve.click());
    expect(approve.textContent).toBe("Approving…"); expect(approve.querySelector(".spin")).not.toBeNull();
    expect(approve.disabled).toBe(true); expect(decline.disabled).toBe(true);
    await act(async () => decline.click()); expect(write).toHaveBeenCalledOnce();
    await act(async () => reject(new Error("Could not send decision")));
    expect(approve.disabled).toBe(false); expect(decline.disabled).toBe(false);
    expect(container.textContent).toContain("Could not send decision");
    vi.mocked(write).mockResolvedValueOnce({}); await act(async () => decline.click());
    expect(decline.textContent).toBe("Declined"); expect(decline.disabled).toBe(true);
    vi.mocked(write).mockReset().mockResolvedValue({});
  });

  it("replaces inline thinking with the final reply when work completes", async () => {
    conversation = { ...conversation, activity: { state: "thinking" }, messages: [
      { id: "question", role: "user", text: "Where is the file?" },
    ] };
    await render();
    const activity = container.querySelector(".message-activity")!;
    expect(activity.previousElementSibling?.querySelector("[data-message-id]")?.getAttribute("data-message-id")).toBe("question");
    expect(activity.querySelector("[data-avatar-state]")?.getAttribute("data-avatar-state")).toBe("thinking");
    conversation = { ...conversation, activity: { state: "done", detail: "Finished finding the file." }, messages: [
      ...conversation.messages,
      { id: "answer", role: "assistant", text: "The file is in your Documents folder." },
    ] };
    await advance(1500);
    expect(container.querySelector(".transcript")?.lastElementChild?.textContent).toContain("The file is in your Documents folder.");
    expect(container.querySelector(".conversation-activity")).toBeNull();
    expect(container.querySelector(".chat-header [data-avatar-state]")?.getAttribute("data-avatar-state")).toBe("idle");
  });

  it("keeps Simple readable and exposes real reasoning and deduplicated tool details in Advanced", async () => {
    const call = { id: "call-1", name: "terminal", arguments: '{"command":"pwd"}', status: "completed" as const,
      result: "/home/hermes", startedAt: "2026-09-30T12:00:00Z", completedAt: "2026-09-30T12:00:01Z" };
    conversation = { ...conversation, activity: { state: "done" }, messages: [
      { id: "reply", role: "assistant", text: "Found it.", reasoning: "Checking the working directory." },
      { id: "tool-result", role: "tool", text: "/home/hermes", toolName: "terminal", toolCall: call },
    ], toolCalls: [call, { id: "call-2", name: "read_file", status: "failed", error: "File is missing." }] };
    await render();
    expect(container.querySelectorAll(".tool-call-detail")).toHaveLength(0);
    expect(container.querySelector(".transcript")!.textContent).not.toContain("Checking the working directory.");
    vi.mocked(api).mockImplementation(async <T>(path: string) => (path === "/bootstrap"
      ? { ...bootstrap, preferences: {...defaultPreferences, startPage:"assistant", presentation: "advanced" } }
      : path === "/bots/shared/conversation" ? conversation : savedDraft) as T);
    await advance(8000);
    expect(container.querySelectorAll('[data-tool-call-id="call-1"]')).toHaveLength(1);
    expect(container.querySelectorAll(".tool-call-detail")).toHaveLength(2);
    const completed = container.querySelector<HTMLDetailsElement>('[data-tool-call-id="call-1"]')!;
    expect(completed.open).toBe(false);
    expect(completed.textContent).toContain("Completed");
    expect(completed.textContent).toContain('{"command":"pwd"}');
    expect(completed.textContent).toContain("/home/hermes");
    expect(completed.querySelectorAll("time")).toHaveLength(2);
    expect(container.querySelector('[data-tool-call-id="call-2"]')?.textContent).toContain("File is missing.");
    expect(container.querySelector(".transcript")!.textContent).toContain("Checking the working directory.");
  });

  it("labels a running tool as last observed while disconnected", async () => {
    conversation = { ...conversation, activity: { state: "working", detail: "Running terminal" },
      toolCalls: [{ id: "live-call", name: "terminal", status: "running", arguments: "pwd" }] };
    vi.mocked(api).mockImplementation(async <T>(path: string) => (path === "/bootstrap"
      ? { ...bootstrap, preferences: { ...defaultPreferences, startPage:"assistant", presentation: "advanced" } }
      : path === "/bots/shared/conversation" ? conversation : savedDraft) as T);
    await render();
    expect(container.querySelector('[data-tool-call-id="live-call"] summary')?.textContent).toContain("Running");
    vi.mocked(api).mockImplementation(async <T>(path: string) => {
      if (path === "/bots/shared/conversation") throw new Error("Disconnected");
      return (path === "/bootstrap" ? { ...bootstrap, preferences: { ...defaultPreferences, startPage:"assistant", presentation: "advanced" } } : savedDraft) as T;
    });
    await advance(1500);
    expect(container.querySelector('[data-tool-call-id="live-call"] summary')?.textContent).toContain("Last seen running");
  });

  it("loads a saved server draft while Hermes is down and never overwrites it with an empty draft", async () => {
    let resolveDraft!: (value: typeof savedDraft) => void;
    const draftResponse = new Promise<typeof savedDraft>((resolve) => { resolveDraft = resolve; });
    vi.mocked(api).mockImplementation(async <T>(path: string) => {
      if (path === "/bots/shared/conversation") throw new Error("Hermes is unavailable");
      return (path === "/bootstrap" ? bootstrap : await draftResponse) as T;
    });
    await render();
    const textarea = container.querySelector("textarea")!;
    expect(textarea.disabled).toBe(true);
    await advance(400);
    expect(write).not.toHaveBeenCalled();
    await act(async () => resolveDraft(savedDraft));
    expect(textarea.value).toBe(savedDraft.text);
    expect(textarea.disabled).toBe(false);
    expect(sendButton().disabled).toBe(true);
    await advance(400);
    expect(write).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("agent-interface:draft:one:shared")!).text).toBe(savedDraft.text);
  });

  it("requires a fresh review after an interrupted run resumes or a different run is interrupted", async () => {
    await render();
    expect(reviewCheckbox().checked).toBe(false);
    expect(sendButton().disabled).toBe(true);
    await act(async () => reviewCheckbox().click());
    expect(reviewCheckbox().checked).toBe(true);
    expect(sendButton().disabled).toBe(false);

    conversation = { ...conversation, activity: { state: "working", runId: "old-run" } };
    await advance(1500);
    expect(reviewCheckbox()).toBeNull();
    conversation = { ...conversation, activity: { state: "interrupted", runId: "new-run" } };
    await advance(1500);
    expect(reviewCheckbox().checked).toBe(false);
    expect(sendButton().disabled).toBe(true);

    await act(async () => reviewCheckbox().click());
    expect(sendButton().disabled).toBe(false);
    conversation = { ...conversation, activity: { state: "interrupted", runId: "another-run" } };
    await advance(1500);
    expect(reviewCheckbox().checked).toBe(false);
    expect(sendButton().disabled).toBe(true);
  });
});
