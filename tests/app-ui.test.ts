// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api, ApiError, clearResponseCache, uploadFile, write } from "../src/client-api";
import { defaultPreferences } from "../src/shared/types";
import type { Bootstrap, Conversation } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";

vi.mock("../src/client-api", async (original) => ({
  ...await original<typeof import("../src/client-api")>(),
  api: vi.fn(),
  write: vi.fn().mockResolvedValue({}),
  uploadFile: vi.fn(),
  clearResponseCache: vi.fn(),
}));
const renders = vi.hoisted(() => ({ avatar: 0, markdown: 0 }));
// SVG geometry and animation are browser concerns, not part of these state regressions.
vi.mock("../src/components/Avatar", async (original) => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  Avatar: (props: { state?: string; size?: number; prop?: string; reducedMotion?: boolean }) => (renders.avatar++, createElement("span", {
    "data-avatar-state": props.state, "data-avatar-size": props.size, "data-avatar-prop": props.prop, "data-avatar-still": props.reducedMotion ? "" : undefined,
  })),
}));
// Unmemoized on purpose, so the count shows whether the transcript re-renders.
vi.mock("../src/components/MessageMarkdown", () => ({
  MessageMarkdown: (props: { text: string }) => (renders.markdown++, createElement("div", { className: "message-markdown" }, props.text)),
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
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
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
    const result = path === "/bootstrap?roster=lean" ? bootstrap
      : path === "/bots/shared/draft" ? savedDraft
      : path.startsWith("/bots/shared/conversation?") ? conversation
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
/** The server reports a change, as Hermes frames or a write would. */
async function changed() {
  await act(async () => FakeEventSource.notifyAll());
  await advance(1500);
}

// Screens such as preferences load on first use.
async function loaded() {
  await act(async () => { await vi.dynamicImportSettled(); });
}

const reviewCheckbox = () => container.querySelector<HTMLInputElement>(".interruption-review input")!;
const sendButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;

describe("conversation state", () => {
  it("reopens a refused household stream at the fallback interval", async () => {
    await render();
    const stream=[...FakeEventSource.streams].find(stream=>stream.url==="/api/events")!;
    await act(async()=>stream.fail());
    await advance(45_000);
    expect(FakeEventSource.created.filter(url=>url==="/api/events")).toHaveLength(2);
  });
  it("refreshes bootstrap on a household roster notice", async () => {
    await render();
    const reads=()=>vi.mocked(api).mock.calls.filter(([path])=>path==="/bootstrap?roster=lean").length;
    const before=reads();
    await act(async()=>{for(const stream of FakeEventSource.streams)if(stream.url==="/api/events")stream.emit("roster","roster");});
    expect(reads()).toBe(before+1);
  });
  it("patches an inflight reply without fetching the transcript", async () => {
    conversation = {...conversation, activity:{state:"thinking",runId:"run"},messages:[{id:"u",role:"user",text:"Hello"}]};
    await render();
    const reads = vi.mocked(api).mock.calls.length;
    await act(async () => {
      for (const stream of FakeEventSource.streams) if (stream.url.includes("inflight=1")) stream.emit("inflight", JSON.stringify({botId:"shared",message:{id:"sid-inflight",role:"assistant",text:"Growing reply"},activity:{state:"thinking",runId:"run"},toolCalls:[]}));
    });
    expect(container.textContent).toContain("Growing reply");
    expect(vi.mocked(api).mock.calls).toHaveLength(reads);
  });
  it.each(["done", "new-run"])("does not reapply an old live tail over a %s fetch", async mode => {
    conversation = { ...conversation, activity: { state: "thinking", runId: "run" }, messages: [] };
    await render();
    await act(async () => {
      for (const stream of FakeEventSource.streams) if (stream.url.includes("inflight=1")) stream.emit("inflight", JSON.stringify({ botId: "shared", message: { id: "sid-inflight", role: "assistant", text: "Old tail" }, activity: { state: "thinking", runId: "run" }, toolCalls: [] }));
    });
    expect(container.textContent).toContain("Old tail");
    conversation = { ...conversation, activity: { state: mode === "done" ? "done" : "thinking", runId: mode === "done" ? "run" : "next-run" }, messages: [{ id: "saved", role: "assistant", text: "Persisted reply" }] };
    await advance(30_000);
    expect(container.textContent).not.toContain("Old tail");
    expect(container.textContent).toContain("Persisted reply");
  });
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
    await changed();
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
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click());
    await loaded();
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
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click());
    await loaded();
    expect(container.querySelectorAll(".hermes-upgrade-panel")).toHaveLength(0);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".settings-row")].find(button => button.textContent?.startsWith("Integrations"))!.click());
    await loaded();
    await advance(30_000);
    expect(container.querySelectorAll(".integrations-panel")).toHaveLength(1);
    // Rarely used screens stay unloaded until opened, and an opened one stays mounted.
    expect(container.querySelectorAll(".hermes-upgrade-panel")).toHaveLength(0);
  });

  it("loads the Hermes updates panel when first opened and keeps it mounted for its running status", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click());
    await loaded();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".settings-row")].find(button => button.textContent?.startsWith("Hermes and updates"))!.click());
    await loaded();
    expect(container.querySelector<HTMLDialogElement>(".hermes-upgrade-panel")?.open).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close Hermes updates"]')!.click());
    expect(container.querySelector<HTMLDialogElement>(".hermes-upgrade-panel")?.open).toBe(false);
  });

  it("does not re-render the app when bootstrap and conversation polls are unchanged", async () => {
    await render();
    await advance(2000);
    const settled = renders.avatar;
    expect(settled).toBeGreaterThan(0);
    await advance(90_000);
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === "/bootstrap?roster=lean").length).toBeGreaterThanOrEqual(3);
    expect(renders.avatar).toBe(settled);
  });

  it("shows current work inline in the transcript and stops claiming work during a disconnect", async () => {
    conversation = { ...conversation, activity: { state: "working", detail: "Running terminal" },
      toolCalls: [{ id: "shell", name: "terminal", status: "running" }] };
    await render();
    expect(container.querySelector('.transcript .conversation-activity [data-avatar-size="52"]')?.getAttribute("data-avatar-state")).toBe("working");
    expect(container.querySelector('.conversation-activity [data-avatar-size="52"]')?.getAttribute("data-avatar-prop")).toBe("computer");
    // Only the inline work indicator animates; the header and home stay still.
    expect(container.querySelector(".conversation-activity [data-avatar-state]")?.hasAttribute("data-avatar-still")).toBe(false);
    expect([...container.querySelectorAll(".chat-header [data-avatar-state], .bot-rail [data-avatar-state]")].every(item => item.hasAttribute("data-avatar-still"))).toBe(true);
    expect(container.querySelector(".activity-copy")?.textContent).toContain("Shared is running terminal...");
    // The sweeping highlight is a visual copy of the text, so assistive technology must hear the line once.
    const highlight = container.querySelector(".activity-shimmer .shimmer-band");
    expect(highlight?.getAttribute("aria-hidden")).toBe("true");
    expect(highlight?.textContent).toBe("Shared is running terminal...");
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!;
    await act(async () => stop.click());
    expect(write).toHaveBeenCalledWith("/bots/shared/stop", {});
    vi.mocked(api).mockImplementation(async <T>(path: string) => {
      if (path.startsWith("/bots/shared/conversation?")) throw new Error("Disconnected");
      return (path === "/bootstrap?roster=lean" ? bootstrap : savedDraft) as T;
    });
    await changed();
    expect(container.querySelector('.conversation-activity [data-avatar-size="52"]')?.getAttribute("data-avatar-state")).toBe("disconnected");
    expect(container.querySelector('.conversation-activity [data-avatar-size="52"]')?.hasAttribute("data-avatar-prop")).toBe(false);
    expect(container.querySelector(".activity-copy")?.textContent).not.toContain("Shared is running terminal...");
  });

  it("hides empty tool-call replies and the assistant's own name, keeping one timestamp per reply", async () => {
    conversation = { ...conversation, activity: { state: "done" }, messages: [
      { id: "question", role: "user", text: "Check the NAS", sender: { id: "one", name: "One" }, createdAt: "2026-10-07T12:00:00Z" },
      { id: "call-row", role: "assistant", text: "", createdAt: "2026-10-07T12:00:05Z", toolCall: { id: "ssh", name: "terminal", status: "completed" } },
      { id: "first", role: "assistant", text: "Tailscale is installed.", createdAt: "2026-10-07T12:00:09Z" },
      { id: "second", role: "assistant", text: "It is connected." },
    ] };
    await render();
    const replies = [...container.querySelectorAll(".message-assistant")];
    expect(replies.map(reply => reply.getAttribute("data-message-id"))).toEqual(["first", "second"]);
    expect(replies.map(reply => reply.querySelectorAll(".message-attribution time").length)).toEqual([1, 0]);
    expect(replies.some(reply => reply.querySelector(".message-attribution")?.textContent?.includes("Shared"))).toBe(false);
    expect(container.querySelector(".message-user .message-attribution")?.textContent).toContain("One");
    expect(container.querySelector(".tool-count")?.textContent).toBe("1");
  });

  it("loads transcript images lazily and reserves the space of one that has been seen", async () => {
    conversation = { ...conversation, activity: { state: "done" }, messages: [
      { id: "chart-message", role: "assistant", text: "Here is the chart.", files: [{ id: "chart-file", name: "chart.png", mime: "image/png" }] },
    ] };
    await render();
    const image = () => container.querySelector<HTMLImageElement>(".file-link img")!;
    expect(image().getAttribute("loading")).toBe("lazy");
    expect(image().getAttribute("decoding")).toBe("async");
    expect(image().hasAttribute("width")).toBe(false);
    Object.defineProperty(image(), "naturalWidth", { value: 800 });
    Object.defineProperty(image(), "naturalHeight", { value: 600 });
    await act(async () => image().dispatchEvent(new Event("load")));
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect([image().getAttribute("width"), image().getAttribute("height")]).toEqual(["800", "600"]);
  });

  it("keeps the transcript from re-rendering while typing", async () => {
    conversation = { ...conversation, activity: { state: "idle" }, messages: [{ id: "answer", role: "assistant", text: "Ready when you are." }] };
    await render();
    const settled = renders.markdown;
    expect(settled).toBeGreaterThan(0);
    const textarea = container.querySelector("textarea")!;
    for (const text of ["H", "He", "Hey"]) await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(textarea.value).toBe("Hey");
    expect(renders.markdown).toBe(settled);
  });

  it("spins Send without a status bar until a send ends without a receipt", async () => {
    conversation = { ...conversation, activity: { state: "idle" } };
    let finish!: (receipt: { requestId: string; status: "uncertain" }) => void;
    vi.mocked(write).mockImplementation(async <T>(path: string, value?: unknown) => path === "/bots/shared/messages"
      ? await new Promise<T>(resolve => { finish = receipt => resolve(receipt as T); void value; }) : {} as T);
    try {
      await render();
      await act(async () => sendButton().click());
      expect(sendButton().disabled).toBe(true);
      expect(sendButton().getAttribute("aria-busy")).toBe("true");
      expect(sendButton().querySelector(".spin")).not.toBeNull();
      expect(container.querySelector(".composer-area .notice")).toBeNull();
      const requestId = (vi.mocked(write).mock.calls.find(([path]) => path === "/bots/shared/messages")![1] as { requestId: string }).requestId;
      await act(async () => finish({ requestId, status: "uncertain" }));
      expect(container.querySelector(".composer-area .notice")?.textContent).toContain("Retry this saved message");
      expect(sendButton().disabled).toBe(true);
    } finally { vi.mocked(write).mockReset().mockResolvedValue({}); }
  });

  it("keeps guidance submission feedback when the draft is cleared mid-send", async () => {
    conversation = { ...conversation, activity: { state: "working" } };
    let finish!: (receipt: { requestId: string; status: "accepted" }) => void;
    vi.mocked(write).mockImplementation(async <T>(path: string) => path === "/bots/shared/messages"
      ? await new Promise<T>(resolve => { finish = receipt => resolve(receipt as T); }) : {} as T);
    try {
      await render();
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send guidance"]')!.click());
      const textarea = container.querySelector("textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(container.querySelector('[aria-label="Stop response"]')).toBeNull();
      expect(container.querySelector('[aria-label="Send guidance"]')?.getAttribute("aria-busy")).toBe("true");
      const requestId = (vi.mocked(write).mock.calls.find(([path]) => path === "/bots/shared/messages")![1] as { requestId: string }).requestId;
      await act(async () => finish({ requestId, status: "accepted" }));
      expect(container.querySelector('[aria-label="Stop response"]')).not.toBeNull();
    } finally { vi.mocked(write).mockReset().mockResolvedValue({}); }
  });

  it("opens the file picker from a real Attach button", async () => {
    conversation = { ...conversation, activity: { state: "idle" } };
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    try {
      await render();
      const attach = container.querySelector<HTMLButtonElement>('button[aria-label="Attach images, PDFs, or text"]')!;
      await act(async () => attach.click());
      expect(click).toHaveBeenCalledOnce();
      expect((click.mock.contexts[0] as HTMLInputElement).type).toBe("file");
      expect((click.mock.contexts[0] as HTMLInputElement).hidden).toBe(true);
    } finally { click.mockRestore(); }
  });

  describe("attachments", () => {
    type Upload = { file: File; progress(sent: number): void; signal: AbortSignal; finish(value: unknown): void; fail(error: Error): void };
    let uploads: Upload[];
    beforeEach(() => {
      conversation = { ...conversation, activity: { state: "idle" } };
      uploads = [];
      vi.mocked(uploadFile).mockImplementation((_path, file, options) => new Promise((resolve, reject) => uploads.push({
        file, progress: sent => options!.onProgress!(sent), signal: options!.signal!, finish: resolve as (value: unknown) => void, fail: reject,
      })));
      Object.assign(URL, { createObjectURL: vi.fn(() => "blob:local-preview"), revokeObjectURL: vi.fn() });
    });
    const image = (name = "image.png") => new File(["pixels"], name, { type: "image/png" });
    const transfer = (files: File[], text = "") => ({ files, types: ["Files"], getData: () => text, dropEffect: "none" });
    const dispatch = (target: Element, type: string, key: "clipboardData" | "dataTransfer", value: unknown) => act(async () => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, key, { value });
      target.dispatchEvent(event);
    });
    const chips = () => [...container.querySelectorAll<HTMLElement>(".attachment")];

    it("uploads a pasted screenshot with visible progress and keeps it in the saved draft", async () => {
      await render();
      await dispatch(container.querySelector("textarea")!, "paste", "clipboardData", transfer([image()]));
      expect(container.querySelector("textarea")!.value).toBe(savedDraft.text);
      expect(uploads[0]!.file.name).toMatch(/^Pasted image \d\d\.\d\d\.\d\d\.png$/);
      await act(async () => uploads[0]!.progress(0.4));
      expect(chips()[0]!.className).toContain("attachment-uploading");
      expect(chips()[0]!.textContent).toContain("Uploading 40%");
      expect(sendButton().disabled).toBe(true);
      await act(async () => uploads[0]!.finish({ id: "stored", name: uploads[0]!.file.name, mime: "image/png", size: 6 }));
      expect(chips()).toHaveLength(1);
      expect(chips()[0]!.className).not.toContain("attachment-uploading");
      expect(chips()[0]!.querySelector("img")!.getAttribute("src")).toBe("blob:local-preview");
      expect(sendButton().disabled).toBe(false);
      await advance(400);
      expect(write).toHaveBeenCalledWith("/bots/shared/draft", expect.objectContaining({ attachments: [expect.objectContaining({ id: "stored" })] }), "PUT");
    });

    it("explains refused drops and offers Retry when an upload fails", async () => {
      await render();
      const panel = container.querySelector(".conversation-panel")!;
      const dropped = transfer([new File(["x"], "letter.docx", { type: "application/msword" }), image("trail.png")]);
      await dispatch(panel, "dragenter", "dataTransfer", dropped);
      expect(container.querySelector(".drop-overlay")?.textContent).toContain("Drop to attach for Shared");
      await dispatch(panel, "drop", "dataTransfer", dropped);
      expect(container.querySelector(".drop-overlay")).toBeNull();
      expect(container.querySelector(".attachment-notice")?.textContent).toContain("letter.docx can't be attached");
      expect(uploads.map(upload => upload.file.name)).toEqual(["trail.png"]);
      await act(async () => uploads[0]!.fail(new Error("Hermes is restarting.")));
      expect(chips()[0]!.className).toContain("attachment-failed");
      expect(container.querySelector(".attachment-error")?.textContent).toContain("trail.png didn't upload. Hermes is restarting. Retry or remove it to send.");
      expect(sendButton().disabled).toBe(true);
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Retry uploading trail.png"]')!.click());
      expect(uploads).toHaveLength(2);
      await act(async () => uploads[1]!.finish({ id: "trail", name: "trail.png", mime: "image/png" }));
      expect(container.querySelector(".attachment-error")).toBeNull();
      expect(chips()).toHaveLength(1);
      expect(sendButton().disabled).toBe(false);
    });

    it("closes an image preview once its attachment leaves the draft", async () => {
      await render();
      await dispatch(container.querySelector("textarea")!, "paste", "clipboardData", transfer([image("map.png")]));
      await act(async () => uploads[0]!.finish({ id: "map", name: "map.png", mime: "image/png" }));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Preview map.png"]')!.click());
      expect(container.querySelector(".attachment-preview img")?.getAttribute("src")).toBe("blob:local-preview");
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove map.png"]')!.click());
      vi.mocked(URL.createObjectURL).mockReturnValue("blob:next-preview");
      await dispatch(container.querySelector("textarea")!, "paste", "clipboardData", transfer([image("gate.png")]));
      expect(chips()).toHaveLength(1);
      expect(container.querySelector(".attachment-preview")).toBeNull();
    });

    it("adds a finished upload to its own assistant after switching away and back", async () => {
      bootstrap.bots.push({ ...bootstrap.bots[0]!, id: "other", name: "Other" });
      const original = vi.mocked(api).getMockImplementation()!;
      try {
        await render();
        await dispatch(container.querySelector("textarea")!, "paste", "clipboardData", transfer([image("map.png")]));
        const open = (name: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>(".bot-item")].find(button => button.textContent?.includes(name))!.click());
        await open("Other");
        // Without a cached copy, the upload must load the saved draft before adding to it.
        localStorage.removeItem("agent-interface:draft:one:shared");
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        vi.mocked(api).mockImplementation(async <T>(path: string) => path === "/bots/shared/draft" ? gate.then(() => savedDraft as T) : original(path) as Promise<T>);
        await act(async () => uploads[0]!.finish({ id: "map", name: "map.png", mime: "image/png" }));
        await open("Shared");
        await act(async () => release());
        await advance(300);
        expect(container.querySelector("textarea")!.value).toBe(savedDraft.text);
        expect(chips().map(chip => chip.title.split("\n")[0])).toEqual(["map.png"]);
      } finally { bootstrap.bots.pop(); }
    });

    it("cancels an upload removed before it finishes", async () => {
      await render();
      await dispatch(container.querySelector("textarea")!, "paste", "clipboardData", transfer([image("map.png")]));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Cancel uploading map.png"]')!.click());
      expect(uploads[0]!.signal.aborted).toBe(true);
      expect(chips()).toHaveLength(0);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local-preview");
    });
  });

  it("pins assistants to the top of home and shows everyone else's latest message", async () => {
    const other = { ...bootstrap.bots[0], id: "other", name: "Other", lastMessage: { text: "Pot roast tonight.", at: new Date().toISOString() } };
    const home = { ...bootstrap, bots: [...bootstrap.bots, other], preferences: { ...bootstrap.preferences, favorites: ["shared"] } };
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string) => path === "/bootstrap?roster=lean" ? home as T : original(path) as Promise<T>);
    vi.mocked(write).mockImplementation(async <T>(path: string, value?: unknown) => (path === "/preferences" ? value : {}) as T);
    try {
      await render();
      const pinned = () => [...container.querySelectorAll(".home-pinned .pinned-name")].map(item => item.textContent);
      expect(pinned()).toEqual(["Shared"]);
      const row = container.querySelector<HTMLButtonElement>(".home-list .bot-row")!;
      expect(row.textContent).toContain("Pot roast tonight.");
      expect(row.querySelector("time")?.getAttribute("dateTime")).toBe(other.lastMessage.at);
      await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 })));
      await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('.bot-menu [role="menuitem"]')].find(item => item.textContent === "Pin to top")!.click());
      expect(write).toHaveBeenCalledWith("/preferences", expect.objectContaining({ favorites: ["shared", "other"] }), "PATCH");
      expect(pinned()).toEqual(["Shared", "Other"]);
      expect(document.body.querySelector(".bot-menu")).toBeNull();
      const toggle = container.querySelector<HTMLButtonElement>('.chat-header [aria-label="Unpin assistant"]')!;
      await act(async () => toggle.click());
      expect(pinned()).toEqual(["Other"]);
    } finally { vi.mocked(write).mockReset().mockResolvedValue({}); }
  });

  it("opens the pin menu on a held touch but not while the list scrolls", async () => {
    await render();
    const row = container.querySelector<HTMLButtonElement>(".bot-row")!;
    const touch = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientX: x, clientY: y }] });
      return act(async () => row.dispatchEvent(event));
    };
    await touch("touchstart", 20, 20);
    for (let y = 22; y <= 60; y += 2) await touch("touchmove", 20, y);
    await advance(600);
    expect(document.body.querySelector(".bot-menu")).toBeNull();
    await touch("touchend", 20, 60);
    await touch("touchstart", 20, 20);
    await advance(600);
    expect(document.body.querySelector(".bot-menu")).not.toBeNull();
  });

  it("does not save the switch-time scroll clamp as the next assistant's reading position", async () => {
    const other = { ...bootstrap.bots[0], id: "other", name: "Other" };
    bootstrap.bots.push(other);
    try {
      conversation = { ...conversation, activity: { state: "idle" }, messages: [{ id: "answer", role: "assistant", text: "Earlier" }] };
      let finish!: () => void;
      const original = vi.mocked(api).getMockImplementation()!;
      vi.mocked(api).mockImplementation(async <T>(path: string) => path.startsWith("/bots/other/conversation?")
        ? await new Promise<T>(resolve => { finish = () => resolve({ ...conversation, botId: "other", messages: [{ id: "latest", role: "assistant", text: "Latest" }] } as T); })
        : original(path) as Promise<T>);
      await render(); await advance(20);
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".bot-item")].find(button => button.textContent?.includes("Other"))!.click());
      const transcript = container.querySelector<HTMLElement>(".transcript")!;
      Object.defineProperties(transcript, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 300, configurable: true } });
      transcript.scrollTop = 0;
      await act(async () => transcript.dispatchEvent(new Event("scroll")));
      await advance(310);
      expect(vi.mocked(write).mock.calls.some(([path]) => path === "/bots/other/read-position")).toBe(false);
      // The response is placed at the latest message before paint, leaving no gap for a clamp.
      await act(async () => finish());
      expect(transcript.scrollTop).toBe(2000);
    } finally { bootstrap.bots.pop(); }
  });

  it("opens phones on home, pushes into a chat and returns with Back", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(max-width: 620px)", addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    conversation = { ...conversation, activity: { state: "idle" } };
    await render();
    const rail = () => container.querySelector(".bot-rail")!;
    expect(rail().classList.contains("open")).toBe(true);
    expect(container.querySelector("main")!.hasAttribute("inert")).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>(".bot-row")!.click());
    expect(rail().classList.contains("open")).toBe(false);
    expect(container.querySelector("main")!.hasAttribute("inert")).toBe(false);
    const back = container.querySelector<HTMLButtonElement>('[aria-label="Back to assistants"]')!;
    expect(document.activeElement).toBe(back);
    await act(async () => back.click());
    expect(rail().classList.contains("open")).toBe(true);
    expect(document.activeElement).toBe(container.querySelector(".bot-rail [aria-current='page']"));
  });

  it.each([false, true])("leaves an assistant that becomes someone else's personal one, on a phone: %s", async (phone) => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: phone && query === "(max-width: 620px)", addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const books = { ...bootstrap.bots[0], id: "books", name: "Ranch books" };
    let hidden = false, reads = 0;
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string) => {
      if (path === "/bootstrap?roster=lean") return { ...bootstrap, bots: hidden ? bootstrap.bots : [books, ...bootstrap.bots] } as T;
      if (path.startsWith("/bots/books/conversation?")) {
        reads++;
        if (hidden) throw new ApiError("Assistant not found", 404, "assistant_not_found");
        return { ...conversation, botId: "books", activity: { state: "idle" } } as T;
      }
      return original(path) as Promise<T>;
    });
    history.replaceState(null, "", "/?bot=books");
    await render();
    if (phone) await act(async () => container.querySelector<HTMLButtonElement>(".bot-row")!.click());
    expect(container.querySelector(".bot-rail")!.classList.contains("open")).toBe(false);
    hidden = true;
    // The change stream says the conversation changed; reading it now answers 404.
    await act(async () => FakeEventSource.notifyAll());
    expect(container.textContent).toContain("That assistant is no longer available to you.");
    expect(new URLSearchParams(location.search).get("bot")).toBe("shared");
    expect(container.querySelector(".bot-rail")!.classList.contains("open")).toBe(phone);
    const settled = reads;
    await act(async () => FakeEventSource.notifyAll());
    await advance(31_000);
    expect(reads, "no request loop for the missing assistant").toBe(settled);
  });

  it("calls an ownerless personal assistant visible to the household, not yours", async () => {
    const original = bootstrap.bots[0];
    bootstrap.bots[0] = { ...original, shared: false };
    try {
      await render();
      expect(container.querySelector(".chat-title")?.textContent).toContain("Personal, visible to the household");
      expect(container.textContent).not.toContain("Your personal assistant");
    } finally { bootstrap.bots[0] = original; }
  });

  it("collects a turn's reasoning into one accordion between the prompt and the reply", async () => {
    conversation = { ...conversation, activity: { state: "done" }, messages: [
      { id: "question", role: "user", text: "Join the NAS" },
      { id: "plan", role: "assistant", text: "", reasoning: "Plan the SSH steps." },
      { id: "call", role: "assistant", text: "", reasoning: "Check the status.", toolCall: { id: "ssh", name: "terminal", status: "completed" } },
      { id: "answer", role: "assistant", text: "Tailscale is up." },
    ] };
    vi.mocked(api).mockImplementation(async <T>(path: string) => (path === "/bootstrap?roster=lean"
      ? { ...bootstrap, preferences: { ...defaultPreferences, startPage: "assistant", presentation: "advanced" } }
      : path.startsWith("/bots/shared/conversation?") ? conversation : savedDraft) as T);
    await render();
    const accordions = container.querySelectorAll(".reasoning-calls");
    expect(accordions).toHaveLength(1);
    expect(accordions[0].querySelector(".tool-count")?.textContent).toBe("2");
    expect([...accordions[0].querySelectorAll(".reasoning-part")].map(part => part.textContent)).toEqual(["Plan the SSH steps.", "Check the status."]);
    expect(accordions[0].previousElementSibling?.getAttribute("data-message-id")).toBe("question");
    expect(accordions[0].nextElementSibling?.getAttribute("data-message-id")).toBe("answer");
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

  it("collapses coordination by source and keeps the scheduled answer and decisions visible", async () => {
    conversation = { ...conversation, messages: [
      { id: "cron", role: "user", text: '[Cronjob "Bunny care" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]\n\nHay and water.' },
      { id: "reminder", role: "assistant", text: "Start with the bunnies." },
      { id: "dm", role: "user", text: "Message from 🤖 Planner (@planner): Check the gate." },
      { id: "bot-reply", role: "assistant", text: "I will check it." },
      { id: "human", role: "user", text: "Hello from Desktop" },
      { id: "handoff", role: "tool", text: "", toolCall: { id: "worker", name: "delegate_task", status: "running" } },
    ], approvals: [{ id: "decision", title: "Open the gate?", detail: "Your decision needed", status: "pending" }] };
    await render();
    const bubbles = [...container.querySelectorAll(".message[data-message-id]")];
    expect(bubbles.map(row => row.getAttribute("data-message-id"))).toEqual(["reminder", "human"]);
    expect(bubbles[0].querySelector(".message-attribution")?.textContent).toContain("Scheduled");
    expect(bubbles[1].textContent).toContain("Hello from Desktop");
    const groups = [...container.querySelectorAll(".tool-calls")];
    expect(groups.map(group => group.querySelector("summary")?.textContent)).toEqual(["Scheduled jobs1", "Bot messages2", "Subagents1Running"]);
    expect(groups.every(group => !group.hasAttribute("open"))).toBe(true);
    expect(container.querySelector(".approval-card")?.textContent).toContain("Open the gate?");
    await act(async () => { groups[0].setAttribute("open", ""); });
    expect(groups[0].textContent).toContain("Hay and water.");
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
        : path.startsWith("/bots/other/conversation?") ? { ...conversation, botId: "other" } as T : original(path) as Promise<T>);
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
    await changed();
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
    vi.mocked(api).mockImplementation(async <T>(path: string) => (path === "/bootstrap?roster=lean"
      ? { ...bootstrap, preferences: {...defaultPreferences, startPage:"assistant", presentation: "advanced" } }
      : path.startsWith("/bots/shared/conversation?") ? conversation : savedDraft) as T);
    await act(async()=>{ for(const stream of FakeEventSource.streams)if(stream.url==="/api/events")stream.emit("roster","roster"); });
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
    vi.mocked(api).mockImplementation(async <T>(path: string) => (path === "/bootstrap?roster=lean"
      ? { ...bootstrap, preferences: { ...defaultPreferences, startPage:"assistant", presentation: "advanced" } }
      : path.startsWith("/bots/shared/conversation?") ? conversation : savedDraft) as T);
    await render();
    expect(container.querySelector('[data-tool-call-id="live-call"] summary')?.textContent).toContain("Running");
    vi.mocked(api).mockImplementation(async <T>(path: string) => {
      if (path.startsWith("/bots/shared/conversation?")) throw new Error("Disconnected");
      return (path === "/bootstrap?roster=lean" ? { ...bootstrap, preferences: { ...defaultPreferences, startPage:"assistant", presentation: "advanced" } } : savedDraft) as T;
    });
    await changed();
    expect(container.querySelector('[data-tool-call-id="live-call"] summary')?.textContent).toContain("Last seen running");
  });

  it("loads a saved server draft while Hermes is down and never overwrites it with an empty draft", async () => {
    let resolveDraft!: (value: typeof savedDraft) => void;
    const draftResponse = new Promise<typeof savedDraft>((resolve) => { resolveDraft = resolve; });
    vi.mocked(api).mockImplementation(async <T>(path: string) => {
      if (path.startsWith("/bots/shared/conversation?")) throw new Error("Hermes is unavailable");
      return (path === "/bootstrap?roster=lean" ? bootstrap : await draftResponse) as T;
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
    await changed();
    expect(reviewCheckbox()).toBeNull();
    conversation = { ...conversation, activity: { state: "interrupted", runId: "new-run" } };
    await changed();
    expect(reviewCheckbox().checked).toBe(false);
    expect(sendButton().disabled).toBe(true);

    await act(async () => reviewCheckbox().click());
    expect(sendButton().disabled).toBe(false);
    conversation = { ...conversation, activity: { state: "interrupted", runId: "another-run" } };
    await changed();
    expect(reviewCheckbox().checked).toBe(false);
    expect(sendButton().disabled).toBe(true);
  });
});

describe("reply announcements", () => {
  const message = (id: string, role: "user" | "assistant", text: string) => ({ id, role, text });
  const settled = [message("u1", "user", "Hello"), message("a1", "assistant", "Hi, I'm here.")];
  const announcement = () => container.querySelector('.transcript-frame > [role="status"]')!.textContent;
  const hold = (messages: typeof settled, state: Conversation["activity"]["state"] = "done") => {
    conversation = { ...conversation, messages, activity: { state, runId: "run" } };
  };

  it("labels the transcript as a region without making it announce everything", async () => {
    await render();
    const transcript = container.querySelector(".transcript")!;
    expect(transcript.getAttribute("role")).toBe("region");
    expect(transcript.getAttribute("aria-label")).toBe("Conversation");
    expect(transcript.hasAttribute("aria-live")).toBe(false);
  });

  it("stays quiet for the reply already in the conversation when it opens", async () => {
    hold(settled);
    await render();
    await changed();
    expect(announcement()).toBe("");
  });

  it("reads a new reply once, as plain words", async () => {
    hold(settled);
    await render();
    hold([...settled, message("u2", "user", "Status?"),
      message("a2", "assistant", "## Done\n**The report** is [ready](https://example.invalid).\n```\nnpm test\n```")]);
    await changed();
    expect(announcement()).toBe("Shared replied: Done The report is ready.");
  });

  it("waits for the assistant to stop working and reads the finished text, not each stage", async () => {
    hold(settled);
    await render();
    hold([...settled, message("u2", "user", "Status?"), message("a2", "assistant", "Checking")], "working");
    await changed();
    expect(announcement()).toBe("");
    hold([...settled, message("u2", "user", "Status?"), message("a2", "assistant", "Checking. All clear.")], "working");
    await changed();
    expect(announcement()).toBe("");
    hold([...settled, message("u2", "user", "Status?"), message("a2", "assistant", "Checking. All clear.")], "done");
    await changed();
    expect(announcement()).toBe("Shared replied: Checking. All clear.");
  });

  it("reads the finished reply when Hermes swaps its in-flight row for saved rows with new IDs", async () => {
    hold(settled);
    await render();
    const prompt = message("u2", "user", "Status?");
    hold([...settled, prompt, message("session-inflight", "assistant", "Checking")], "working");
    await changed();
    expect(announcement()).toBe("");
    hold([...settled, prompt, message("row-41", "assistant", "Checking. All clear.")], "done");
    await changed();
    expect(announcement()).toBe("Shared replied: Checking. All clear.");
  });

  it("reads an unsaved reply once, not again when saved rows replace it", async () => {
    hold(settled);
    await render();
    const prompt = message("u2", "user", "Status?");
    hold([...settled, prompt, message("session-inflight", "assistant", "All clear.")], "done");
    await changed();
    expect(announcement()).toBe("Shared replied: All clear.");
    const first = container.querySelector('.transcript-frame > [role="status"] > span');
    hold([...settled, prompt, message("row-41", "assistant", "All clear.")], "done");
    await advance(3000);
    expect(container.querySelector('.transcript-frame > [role="status"] > span')).toBe(first);
  });

  it("reads an identical reply in the next turn even as the previous one is being replaced", async () => {
    hold(settled);
    await render();
    const first = message("u2", "user", "Status?");
    hold([...settled, first, message("session-inflight", "assistant", "Done.")], "done");
    await changed();
    const node = container.querySelector('.transcript-frame > [role="status"] > span');
    const saved = [...settled, first, message("row-41", "assistant", "Done.")];
    const second = message("u3", "user", "And now?");
    hold([...saved, second, message("session-inflight", "assistant", "Done.")], "done");
    await changed();
    const next = container.querySelector('.transcript-frame > [role="status"] > span');
    expect(announcement()).toBe("Shared replied: Done.");
    expect(next).not.toBe(node);
    hold([...saved, second, message("row-50", "assistant", "Done.")], "done");
    await changed();
    expect(container.querySelector('.transcript-frame > [role="status"] > span')).toBe(next);
  });

  it("stays quiet for a finished unsaved reply on load, and for the rows that later save it", async () => {
    const prompt = message("u2", "user", "Status?");
    hold([...settled, prompt, message("session-inflight", "assistant", "Old news.")], "done");
    await render();
    await changed();
    expect(announcement()).toBe("");
    hold([...settled, prompt, message("row-41", "assistant", "Old news.")], "done");
    await changed();
    expect(announcement()).toBe("");
  });

  it("reads a second identical reply as a new announcement", async () => {
    hold(settled);
    await render();
    hold([...settled, message("a2", "assistant", "Done.")]);
    await changed();
    const first = container.querySelector('.transcript-frame > [role="status"] > span');
    expect(announcement()).toBe("Shared replied: Done.");
    hold([...settled, message("a2", "assistant", "Done."), message("a3", "assistant", "Done.")]);
    await changed();
    expect(announcement()).toBe("Shared replied: Done.");
    expect(container.querySelector('.transcript-frame > [role="status"] > span')).not.toBe(first);
  });

  it("never pairs the previous assistant's reply with the newly opened assistant's name", async () => {
    const other = { ...bootstrap.bots[0], id: "other", name: "Other" };
    bootstrap.bots.push(other);
    const written: string[] = [];
    const nodeValue = Object.getOwnPropertyDescriptor(Node.prototype, "nodeValue")!;
    Object.defineProperty(Node.prototype, "nodeValue", { configurable: true, get: nodeValue.get, set(value: string) {
      if (this.parentElement?.closest('.transcript-frame > [role="status"]')) written.push(String(value));
      nodeValue.set!.call(this, value);
    } });
    try {
      const original = vi.mocked(api).getMockImplementation()!;
      vi.mocked(api).mockImplementation(async <T>(path: string) => path.startsWith("/bots/other/conversation?")
        ? { ...conversation, botId: "other", messages: [] } as T : original(path) as Promise<T>);
      hold(settled);
      await render();
      hold([...settled, message("a2", "assistant", "Done.")]);
      await changed();
      expect(announcement()).toBe("Shared replied: Done.");
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".bot-item")].find(button => button.textContent?.includes("Other"))!.click());
      expect(written.filter(text => text.startsWith("Other"))).toEqual([]);
      expect(announcement()).toBe("");
    } finally {
      Object.defineProperty(Node.prototype, "nodeValue", nodeValue);
      bootstrap.bots.pop();
    }
  });

  it("keeps the first 200 characters of a long reply", async () => {
    hold(settled);
    await render();
    hold([...settled, message("a2", "assistant", "word ".repeat(100))]);
    await changed();
    expect(announcement()).toBe(`Shared replied: ${"word ".repeat(40).trim()}…`);
  });

  it("stays quiet when older history is loaded above the conversation", async () => {
    hold(settled);
    await render();
    hold([message("u0", "user", "Earlier"), message("a0", "assistant", "An older answer"), ...settled]);
    await changed();
    expect(announcement()).toBe("");
  });

  it("ignores a new user message", async () => {
    hold(settled);
    await render();
    hold([...settled, message("u2", "user", "More please")]);
    await changed();
    expect(announcement()).toBe("");
  });
});
