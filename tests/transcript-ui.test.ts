// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api, write } from "../src/client-api";
import { defaultPreferences } from "../src/shared/types";
import type { Bootstrap, Conversation, Message } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { advance, mountRoot, stubMatchMedia, typeInto } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async (original) => ({
  ...await original<typeof import("../src/client-api")>(),
  api: vi.fn(),
  write: vi.fn().mockResolvedValue({}),
  uploadFile: vi.fn(),
  clearResponseCache: vi.fn(),
}))(original)));
vi.mock("../src/app/use-chat-presence", () => ({ useChatPresence: vi.fn() }));
vi.mock("../src/components/Avatar", async (original) => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  Avatar: () => createElement("span"),
}));

const bootstrap: Bootstrap = {
  user: { id: "one", name: "One", email: "one@example.test" },
  household: [],
  preferences: { ...defaultPreferences, startPage: "assistant" },
  bots: [{ id: "shared", name: "Shared", shared: true, model: "test", activity: "idle" }],
  capabilities: Object.fromEntries([
    "chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration",
    "tools", "skills", "routines", "durableEvents", "idempotency", "imageGeneration",
    "stop", "portraitGeneration", "avatarMetadata",
  ].map((key) => [key, { supported: true }])) as Bootstrap["capabilities"],
  connection: { connected: true },
  csrfToken: "test",
};
const savedDraft = { text: "My saved draft", attachments: [] };
const writeText = vi.fn<(value: string) => Promise<void>>();
let conversation: Conversation;
let searchHits: unknown[];
let container: HTMLDivElement;
let root: Root;
const prompt = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "user", text, sender: { id: "one", name: "One" }, ...extra });
const answer = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "assistant", text, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  history.replaceState(null, "", "/");
  searchHits = [];
  conversation = { botId: "shared", sessionId: "live", messages: [], approvals: [], files: [], activity: { state: "idle" } };
  vi.mocked(write).mockReset().mockResolvedValue({});
  vi.mocked(api).mockImplementation(async <T>(path: string) => {
    const result = path === "/bootstrap?roster=lean" ? bootstrap
      : path === "/bots/shared/draft" ? savedDraft
      : path.startsWith("/bots/shared/conversation?") ? conversation
      : path.startsWith("/search?") ? { hits: searchHits, unavailableBots: [] }
      : null;
    return result as T;
  });
  ({ container, root } = mountRoot());
});

async function render() {
  await act(async () => root.render(createElement(App)));
  await advance(20);
}
async function changed() {
  await act(async () => FakeEventSource.notifyAll());
  await advance(1500);
}
const textarea = () => container.querySelector("textarea")!;
const labelled = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const status = () => [...container.querySelectorAll('.transcript-frame > [role="status"]')].map(node => node.textContent).join(" ");
const buttonText = (text: string) => [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === text);
const messagesWritten = () => vi.mocked(write).mock.calls.filter(([path]) => path === "/bots/shared/messages");

describe("retry a failed turn", () => {
  const file = { id: "photo", name: "gate.jpg", mime: "image/jpeg" };
  beforeEach(() => {
    conversation = { ...conversation, activity: { state: "failed", runId: "run-1" },
      messages: [prompt("q1", "Check the gate", { files: [file] })] };
  });

  it("resends the person's message with its files, naming it, without touching the draft", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(write).mockImplementation(async <T>(path: string) => path === "/bots/shared/messages"
      ? await new Promise<T>(resolve => { finish = value => resolve(value as T); }) : {} as T);
    await render();
    expect(textarea().value).toBe("My saved draft");
    await act(async () => buttonText("Retry")!.click());
    const retrying = buttonText("Retrying…")!;
    expect(retrying.disabled).toBe(true);
    await act(async () => retrying.click());
    expect(messagesWritten()).toHaveLength(1);
    const body = messagesWritten()[0][1] as Record<string, unknown>;
    expect(body).toEqual({ requestId: expect.any(String), text: "Check the gate", attachments: [file], retryOf: "q1" });
    expect(body).not.toHaveProperty("draftBaseRevision");
    await act(async () => finish({ requestId: body.requestId, status: "accepted" }));
    // Until the conversation shows the new run, Retry stays away, so it cannot be sent twice.
    expect(buttonText("Retry")).toBeUndefined();
    expect(textarea().value).toBe("My saved draft");
    expect(vi.mocked(write).mock.calls.some(([path]) => String(path).endsWith("/draft"))).toBe(false);
  });

  it("shows a refused retry in the send-error notice and offers it again", async () => {
    vi.mocked(write).mockImplementation(async <T>(path: string) => (path === "/bots/shared/messages"
      ? { requestId: "x", status: "rejected", message: "The assistant is busy." } : {}) as T);
    await render();
    await act(async () => buttonText("Retry")!.click());
    expect(container.querySelector(".notice.error")?.textContent).toContain("The assistant is busy.");
    expect(buttonText("Retry")?.disabled).toBe(false);
  });

  it("is not offered once the assistant replied, or while working", async () => {
    conversation = { ...conversation, messages: [...conversation.messages, answer("a1", "Partly done.")] };
    await render();
    expect(buttonText("Retry")).toBeUndefined();
    conversation = { ...conversation, activity: { state: "working" }, messages: [prompt("q1", "Check the gate")] };
    await changed();
    expect(buttonText("Retry")).toBeUndefined();
  });
});

describe("questions", () => {
  it("picks options with number keys, moves to the next question and sends several choices as one answer", async () => {
    conversation = { ...conversation, activity: { state: "blocked" }, attention: [{ id: "ask", kind: "clarify", title: "Supplies", detail: "Two questions.", questions: [
      { id: "feed", prompt: "Which feed?", options: ["Hay", "Pellets"] },
      { id: "extras", prompt: "Anything else?", options: ["Water", "Salt lick", "Treats"], multiple: true },
    ] }] };
    await render();
    const card = container.querySelector<HTMLElement>('[data-attention-id="ask"]')!;
    expect(card.id).toBe("attention-clarify-ask");
    const first = card.querySelector<HTMLElement>('[data-question="0"]')!;
    first.querySelector("input")!.focus();
    await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true })));
    expect(card.querySelector<HTMLInputElement>('[data-question="0"] input:checked')?.closest("label")?.textContent).toContain("Pellets");
    await act(async () => { vi.advanceTimersToNextFrame(); });
    const second = card.querySelector<HTMLElement>('[data-question="1"]')!;
    expect(second.contains(document.activeElement)).toBe(true);
    const boxes = [...second.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(4);
    const submit = card.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(true);
    await act(async () => second.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true })));
    await act(async () => boxes[0].click());
    await act(async () => boxes[3].click());
    await typeInto(second.querySelector<HTMLInputElement>('[aria-label="Your answer: Anything else?"]')!, "fresh greens");
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(write).toHaveBeenCalledWith("/bots/shared/requests/ask", { answers: { feed: "Pellets", extras: "Water, Treats, fresh greens" } });
  });

  it("keeps a free-text field for a question without options", async () => {
    conversation = { ...conversation, attention: [{ id: "ask", kind: "clarify", title: "Name", detail: "", questions: [{ id: "name", prompt: "Gate name?" }] }] };
    await render();
    await typeInto(container.querySelector<HTMLInputElement>('[aria-label="Gate name?"]')!, "North");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-attention-id="ask"] button[type="submit"]')!.click());
    expect(write).toHaveBeenCalledWith("/bots/shared/requests/ask", { answers: { name: "North" } });
  });

  it("addresses approval cards for the status dock", async () => {
    conversation = { ...conversation, approvals: [{ id: "gate", title: "Open the gate?", detail: "", status: "pending" }] };
    await render();
    expect(container.querySelector('[data-attention-id="gate"]')?.id).toBe("attention-approval-gate");
  });
});

describe("reply actions", () => {
  beforeEach(() => {
    conversation = { ...conversation, messages: [prompt("q", "Plan supper"), answer("a", "**Pot roast** tonight.\n\nCarrots too.")] };
  });

  it("copies the reply's Markdown and announces it", async () => {
    await render();
    await act(async () => labelled("Copy reply").click());
    expect(writeText).toHaveBeenCalledWith("**Pot roast** tonight.\n\nCarrots too.");
    expect(status()).toContain("Copied");
    expect(labelled("Copied")).not.toBeNull();
  });

  it("saves the reply as a saved item", async () => {
    await render();
    await act(async () => labelled("Save reply").click());
    expect(write).toHaveBeenCalledWith("/saved", { kind: "session", botId: "shared", sessionId: "live", messageId: "a", title: "Pot roast tonight. Carrots too." });
    expect(labelled("Reply saved").disabled).toBe(true);
  });

  it("offers Share only where the browser can share", async () => {
    await render();
    expect(container.querySelector('[aria-label="Share reply"]')).toBeNull();
  });

  it("quotes the reply at the end of the draft and refuses while the draft is sending", async () => {
    await render();
    await act(async () => labelled("Quote in reply").click());
    expect(textarea().value).toBe("My saved draft\n\n> **Pot roast** tonight.\n>\n> Carrots too.\n\n");
    await act(async () => { vi.advanceTimersToNextFrame(); });
    expect(document.activeElement).toBe(textarea());
    vi.mocked(write).mockImplementation(async <T>(path: string) => (path === "/bots/shared/messages" ? new Promise<T>(() => {}) : {}) as T);
    await act(async () => labelled("Send message").click());
    await act(async () => labelled("Quote in reply").click());
    expect(status()).toContain("still sending");
    const sent = messagesWritten()[0][1] as { text: string };
    expect(sent.text).toBe("My saved draft\n\n> **Pot roast** tonight.\n>\n> Carrots too.\n\n");
  });
});

describe("find in chat", () => {
  beforeEach(() => {
    conversation = { ...conversation, earlier: 4, messages: [prompt("q", "Is the north gate shut?"), answer("a", "The gate is shut."), answer("b", "Barn is fine.")] } as Conversation;
    searchHits = [
      { botId: "shared", botName: "Shared", sessionId: "live", title: "", snippet: "", messageId: "old", offset: 2 },
      { botId: "shared", botName: "Shared", sessionId: "live", title: "", snippet: "", messageId: "a" },
      { botId: "shared", botName: "Shared", sessionId: "earlier-session", title: "", snippet: "", messageId: "elsewhere" },
    ];
  });
  const find = () => container.querySelector<HTMLInputElement>('.find-bar input')!;
  const count = () => container.querySelector(".find-count")?.textContent;

  it("opens with Cmd+F, counts loaded matches, then merges unloaded history and opens it", async () => {
    await render();
    const before = labelled("Copy reply");
    before.focus();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, cancelable: true })));
    expect(document.activeElement).toBe(find());
    await typeInto(find(), "gate");
    expect(count()).toBe("2 of 2");
    await advance(300);
    expect(api).toHaveBeenCalledWith("/search?q=gate&botId=shared");
    expect(count()).toBe("3 of 3");
    await act(async () => find().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(count()).toBe("2 of 3");
    // The oldest match is not loaded: the window reloads from it.
    await act(async () => find().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(count()).toBe("1 of 3");
    expect(api).toHaveBeenCalledWith("/bots/shared/conversation?start=old");
    await act(async () => find().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector(".find-bar")).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it("drops a search response for an older query", async () => {
    let first!: (value: unknown) => void;
    vi.mocked(api).mockImplementation(async <T>(path: string) => (path === "/search?q=ga&botId=shared"
      ? new Promise(resolve => { first = resolve; })
      : path === "/bootstrap?roster=lean" ? bootstrap : path === "/bots/shared/draft" ? savedDraft
      : path.startsWith("/search?") ? { hits: [], unavailableBots: [] } : conversation) as T);
    await render();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true })));
    await typeInto(find(), "ga");
    await advance(300);
    await typeInto(find(), "gate");
    await advance(300);
    await act(async () => first({ hits: searchHits, unavailableBots: [] }));
    expect(count()).toBe("2 of 2");
  });
});

describe("opening a message", () => {
  it("opens the live conversation at a linked message and highlights it briefly", async () => {
    history.replaceState(null, "", "/?bot=shared&message=m2");
    conversation = { ...conversation, messages: [prompt("m2", "Older question"), answer("m3", "Older answer")] };
    await render();
    expect(api).toHaveBeenCalledWith("/bots/shared/conversation?start=m2");
    expect(container.querySelector('[data-message-id="m2"]')?.hasAttribute("data-found")).toBe(true);
    expect(location.search).toBe("?bot=shared");
    await advance(2500);
    expect(container.querySelector('[data-message-id="m2"]')?.hasAttribute("data-found")).toBe(false);
  });
});

describe("turn work", () => {
  it("folds a finished turn's tools into one row with its duration, outside of which decisions stay", async () => {
    const call = { id: "c1", name: "terminal", status: "completed" as const, startedAt: "2026-10-01T16:00:05Z" };
    conversation = { ...conversation, approvals: [{ id: "gate", title: "Open the gate?", detail: "", status: "pending" }], messages: [
      prompt("q", "Check it", { createdAt: "2026-10-01T16:00:00Z" }),
      { id: "t", role: "tool", text: "", toolCall: call },
      answer("a", "Checked.", { createdAt: "2026-10-01T16:02:14Z" }),
    ] };
    await render();
    const fold = container.querySelector<HTMLDetailsElement>(".turn-work")!;
    expect(fold.querySelector("summary")?.textContent).toBe("Worked for 2m 14s · 1 tool call");
    expect(fold.open).toBe(false);
    expect(fold.contains(container.querySelector(".approval-card"))).toBe(false);
  });

  it("shows the running tool's receipt beside the working avatar", async () => {
    conversation = { ...conversation, activity: { state: "working", runId: "r" }, messages: [prompt("q", "Check it")],
      toolCalls: [{ id: "c1", name: "calendar.create_event", status: "running" }] };
    await render();
    expect(container.querySelector(".turn-work summary")?.textContent).toBe("Working · 1 tool call");
    expect(container.querySelector(".activity-live-tool")?.textContent).toBe("Action in progress · calendar.create_event");
  });
});

describe("scroll intent", () => {
  it("stops following the end at once when the reader wheels up", async () => {
    const height = vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) { return this.classList.contains("transcript") ? 2000 : 0; });
    const view = vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) { return this.classList.contains("transcript") ? 300 : 0; });
    try {
      conversation = { ...conversation, messages: [prompt("q", "Hello"), answer("a", "Hi")] };
      await render();
      const transcript = container.querySelector<HTMLElement>(".transcript")!;
      expect(transcript.scrollTop).toBe(2000);
      transcript.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      transcript.scrollTop = 1500;
      conversation = { ...conversation, messages: [...conversation.messages, answer("b", "More")] };
      await changed();
      expect(transcript.scrollTop).toBe(1500);
      expect(container.querySelector(".jump-latest")).not.toBeNull();
    } finally { height.mockRestore(); view.mockRestore(); }
  });
});
