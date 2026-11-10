// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { keepKnownAnswers, mayReplace, nextRecord, type Saved } from "../src/components/FormReplyCard";
import { ApiError, api, write } from "../src/client-api";
import { defaultPreferences } from "../src/shared/types";
import type { AttentionRequest, Bootstrap, Conversation, Message, ToolCall } from "../src/shared/types";
import { useConversation } from "../src/app/use-conversation";
import { useTurnRetry } from "../src/app/use-turn-retry";
import { formRequestId, retryRequestId } from "../src/shared/retry-id";
import { FakeEventSource } from "./fake-event-source";
import { clearDecline } from "../src/app/decline-handoff";
import { advance, mountRoot, stubMatchMedia, typeInto, waitForUi } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async (original) => ({
  ...await original<typeof import("../src/client-api")>(),
  api: vi.fn(),
  write: vi.fn().mockResolvedValue({}),
  uploadFile: vi.fn(),
  clearResponseCache: vi.fn(),
}))(original)));
vi.mock("../src/app/use-chat-presence", () => ({ useChatPresence: vi.fn() }));
vi.mock("../src/app/use-device-activity", () => ({ useDeviceActivity: vi.fn() }));
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
  formKey: "form-key-one",
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
  // A decline in one test would otherwise still be waiting for the next message in the next.
  clearDecline("shared");
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
  it("shows the failure reason and explains what Retry sends before the person acts", async () => {
    conversation.activity.detail = "The gate service did not answer.";
    await render();
    const recovery = container.querySelector(".recovery-activity")!;
    expect(recovery.textContent).toContain("Shared couldn't finish.");
    expect(recovery.textContent).toContain("The gate service did not answer.");
    expect(recovery.textContent).toContain("Retry sends your last message again. Your draft stays as it is.");
    expect(messagesWritten()).toHaveLength(0);
  });

  it("updates the mounted activity status with the failure title and reason", async () => {
    conversation.activity = { state: "working", runId: "run-1" };
    await render();
    const live = container.querySelector('.activity-copy > [role="status"]')!;
    expect(live.textContent).toContain("Shared is working");
    conversation = { ...conversation, activity: { state: "failed", runId: "run-1", detail: "The gate service did not answer." } };
    await changed();
    expect(container.querySelector('.activity-copy > [role="status"]')).toBe(live);
    expect(live.textContent).toContain("Shared couldn't finish.");
    expect(live.textContent).toContain("The gate service did not answer.");
    expect(live.getAttribute("aria-atomic")).toBe("true");
  });

  // The ID every device derives for retrying q1 after run-1 failed.
  const turnId = () => retryRequestId("shared", "q1", "run-1");
  // The ID is derived with Web Crypto, which settles outside fake timers.
  const posted = (count: number) => waitForUi(() => expect(messagesWritten()).toHaveLength(count));
  const receipts = (status: () => string) => {
    const lookups: string[] = [];
    const previous = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string, ...rest: unknown[]) => {
      if (!path.startsWith("/submissions/")) return previous(path, ...rest as []) as T;
      lookups.push(path.split("/")[2]);
      return { requestId: path.split("/")[2], status: status() } as T;
    });
    return lookups;
  };
  const lost = () => vi.mocked(write).mockImplementation(async <T>(path: string) => {
    if (path === "/bots/shared/messages") throw new TypeError("Failed to fetch");
    return {} as T;
  });

  it("resends the person's message with its files under the failed turn's ID, without touching the draft", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(write).mockImplementation(async <T>(path: string) => path === "/bots/shared/messages"
      ? await new Promise<T>(resolve => { finish = value => resolve(value as T); }) : {} as T);
    await render();
    expect(textarea().value).toBe("My saved draft");
    await act(async () => buttonText("Retry")!.click());
    const retrying = buttonText("Retrying…")!;
    expect(retrying.disabled).toBe(true);
    await posted(1);
    await act(async () => retrying.click());
    expect(messagesWritten()).toHaveLength(1);
    const body = messagesWritten()[0][1] as Record<string, unknown>;
    expect(body).toEqual({ requestId: await turnId(), text: "Check the gate", attachments: [file], retryOf: "q1" });
    expect(body).not.toHaveProperty("draftBaseRevision");
    await act(async () => finish({ requestId: body.requestId, status: "accepted" }));
    // Until the conversation shows the new run, Retry stays away.
    expect(buttonText("Retry")).toBeUndefined();
    expect(textarea().value).toBe("My saved draft");
    expect(vi.mocked(write).mock.calls.some(([path]) => String(path).endsWith("/draft"))).toBe(false);
  });

  it("offers Retry again with the same ID after the server refused it outright, and not after Hermes refused it", async () => {
    let refuse = true;
    vi.mocked(write).mockImplementation(async <T>(path: string, body: unknown) => {
      if (path !== "/bots/shared/messages") return {} as T;
      if (refuse) throw new ApiError("Wait for the current reply to finish before retrying", 409);
      return { requestId: (body as { requestId: string }).requestId, status: "rejected", message: "The attachment is gone." } as T;
    });
    await render();
    await act(async () => buttonText("Retry")!.click());
    await posted(1);
    await advance(0);
    expect(container.querySelector(".notice.error")?.textContent).toContain("Wait for the current reply to finish");
    refuse = false;
    await act(async () => buttonText("Retry")!.click());
    await posted(2);
    await advance(0);
    const ids = messagesWritten().map(([, body]) => (body as { requestId: string }).requestId);
    expect(ids).toEqual([await turnId(), await turnId()]);
    expect(container.querySelector(".retry-refused")?.textContent).toContain("Hermes didn't take the retry. The attachment is gone.");
    // Hermes keeps refusing that ID, so the message box sends it anew.
    expect(buttonText("Retry")).toBeUndefined();
  });

  it("explains a refused retry from the server's record after a reload, and adds the message and its files to the draft", async () => {
    conversation = { ...conversation, retry: { requestId: await turnId(), status: "rejected", message: "The attachment is gone.", retryOf: "q1" } } as Conversation;
    await render();
    // A reload knows it only from the conversation.
    await act(async () => root.render(createElement("div")));
    await render();
    expect(buttonText("Retry")).toBeUndefined();
    expect(container.querySelector(".retry-refused")?.textContent).toContain("Hermes didn't take the retry. The attachment is gone.");
    await act(async () => buttonText("Put my message in the message box")!.click());
    expect(textarea().value).toBe("My saved draft\n\nCheck the gate");
    expect(status()).toContain("Your message is in the message box.");
    await advance(2000);
    expect(vi.mocked(write).mock.calls.findLast(([path]) => path === "/bots/shared/draft")?.[1])
      .toMatchObject({ text: "My saved draft\n\nCheck the gate", attachments: [file] });
    // While a message is on its way, the draft stays as sent and nothing is offered.
    vi.mocked(write).mockImplementation(async <T>(path: string) => (path === "/bots/shared/messages" ? new Promise<T>(() => {}) : {}) as T);
    await act(async () => labelled("Send message").click());
    expect(buttonText("Put my message in the message box")).toBeUndefined();
    expect(messagesWritten()[0][1]).toMatchObject({ text: "My saved draft\n\nCheck the gate", attachments: [file] });
  });

  it("keeps a slow retry of one assistant's turn from blocking or settling another's after switching assistants", async () => {
    const held = new Map<string, (value: unknown) => void>();
    vi.mocked(write).mockImplementation(async <T>(path: string, body: unknown) => path.endsWith("/messages")
      ? await new Promise<T>(resolve => { held.set(path, value => resolve({ requestId: (body as { requestId: string }).requestId, ...value as object } as T)); })
      : {} as T);
    let hook!: ReturnType<typeof useTurnRetry>;
    // Switching assistants keeps the conversation view, and so this hook, mounted.
    const View = ({ botId }: { botId: string }) => {
      hook = useTurnRetry({ botId, userId: "one", canonical: { ...conversation, botId, draft: null, readPosition: null }, blocked: false, resendable: true, report: vi.fn() });
      return null;
    };
    const show = (botId: string) => act(async () => root.render(createElement(View, { botId })));
    const sent = (botId: string) => vi.mocked(write).mock.calls.filter(([path]) => path === `/bots/${botId}/messages`);
    await show("shared");
    let first!: Promise<void>;
    await act(async () => { first = hook.run(hook.message!); });
    await waitForUi(() => expect(held.has("/bots/shared/messages")).toBe(true));
    await show("barn");
    expect(hook.busy).toBe(false);
    await act(async () => { void hook.run(hook.message!); });
    await waitForUi(() => expect(sent("barn")).toHaveLength(1));
    expect(hook.busy).toBe(true);
    // The first assistant's retry finishing leaves this one in flight, and it isn't sent twice.
    await act(async () => { held.get("/bots/shared/messages")!({ status: "accepted" }); await first; });
    expect(hook.busy).toBe(true);
    await act(async () => { await hook.run(hook.message!); });
    expect(sent("barn")).toHaveLength(1);
    await show("shared");
    expect(hook.message).toBeUndefined();
    await act(async () => held.get("/bots/barn/messages")!({ status: "accepted" }));
  });

  it("checks a retry with a lost response by its ID, slowing down, and sends only that ID again", async () => {
    const lookups = receipts(() => "uncertain");
    lost();
    await render();
    await act(async () => buttonText("Retry")!.click());
    await posted(1);
    await advance(0);
    expect(container.querySelector(".notice.error")?.textContent).toContain("Retry sends the same request again");
    expect(container.textContent).toContain("Checking whether the retry arrived…");
    const id = await turnId();
    // Checks at once, then after 2, 4, 8 and 16 seconds, then every 30.
    await advance(1);
    expect(lookups).toEqual([id]);
    await advance(2000 + 4000 + 8000 + 16000);
    expect(lookups).toHaveLength(5);
    await advance(29000);
    expect(lookups).toHaveLength(5);
    await advance(1000);
    expect(lookups).toHaveLength(6);
    expect(messagesWritten()).toHaveLength(1);
    await act(async () => buttonText("Retry")!.click());
    await posted(2);
    expect(messagesWritten()[1][1]).toEqual({ ...messagesWritten()[0][1] as object, reviewedUncertain: true });
    // Once the conversation moves on, checking stops.
    conversation = { ...conversation, activity: { state: "working", runId: "run-2" } };
    await changed();
    lookups.length = 0;
    await advance(120000);
    expect(lookups).toEqual([]);
  });

  it("explains an unconfirmed retry without offering to resend it when Hermes cannot look requests up", async () => {
    receipts(() => "uncertain");
    lost();
    bootstrap.capabilities = { ...bootstrap.capabilities, idempotency: { supported: false, reason: "This Hermes can't look up requests." } };
    try {
      await render();
      await act(async () => buttonText("Retry")!.click());
      await posted(1);
      await advance(0);
      const notice = container.querySelector(".notice.error")?.textContent ?? "";
      expect(notice).toContain("won't be sent again");
      expect(notice).not.toContain("Retry sends");
      expect(buttonText("Retry")!.disabled).toBe(true);
    } finally {
      bootstrap.capabilities = { ...bootstrap.capabilities, idempotency: { supported: true } };
    }
  });

  it("uses one ID for the same failed turn in every tab, whatever happened in the others", async () => {
    lost();
    const hooks: ReturnType<typeof useTurnRetry>[] = [];
    const Tab = ({ index }: { index: number }) => {
      hooks[index] = useTurnRetry({ botId: "shared", userId: "one", canonical: { ...conversation, draft: null, readPosition: null }, blocked: false, resendable: true, report: vi.fn() });
      return null;
    };
    await act(async () => root.render(createElement("div", {}, createElement(Tab, { index: 0 }), createElement(Tab, { index: 1 }))));
    await act(async () => { await hooks[0].run(hooks[0].message!); });
    await act(async () => { await hooks[1].run(hooks[1].message!); });
    const ids = messagesWritten().map(([, body]) => (body as { requestId: string }).requestId);
    expect(ids).toEqual([await turnId(), await turnId()]);
  });

  it("keeps Retry settled after a remount by the server's record of the retry, and follows the request that claimed the turn", async () => {
    const claimed = "0d6f7d2e-5a3c-8b1d-9e4f-2a6b8c0d1e3f";
    const lookups = receipts(() => "uncertain");
    // Another tab or person retried first: the server answers with that request's receipt.
    vi.mocked(write).mockImplementation(async <T>(path: string) => (path === "/bots/shared/messages"
      ? { requestId: claimed, status: "uncertain" } : {}) as T);
    await render();
    await act(async () => buttonText("Retry")!.click());
    await posted(1);
    await advance(1);
    expect(lookups).toEqual([claimed]);
    // Remounted against a snapshot still showing the failed run, which carries the server's record.
    await act(async () => root.render(createElement("div")));
    conversation = { ...conversation, retry: { requestId: claimed, status: "accepted", retryOf: "q1" } } as Conversation;
    await render();
    expect(buttonText("Retry")).toBeUndefined();
    conversation = { ...conversation, retry: { requestId: claimed, status: "uncertain", retryOf: "q1" } } as Conversation;
    lookups.length = 0;
    await changed();
    expect(container.textContent).toContain("Checking whether the retry arrived…");
    expect(lookups[0]).toBe(claimed);
    expect(messagesWritten()).toHaveLength(1);
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
    await typeInto(second.querySelector<HTMLTextAreaElement>('[aria-label="Your answer: Anything else?"]')!, "fresh greens");
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(write).toHaveBeenCalledWith("/bots/shared/requests/ask", { answers: { feed: "Pellets", extras: JSON.stringify(["Water", "Treats", "fresh greens"]) }, answerFormat: "json" });
  });

  it("moves on from an option question to a free-text question", async () => {
    conversation = { ...conversation, attention: [{ id: "ask", kind: "clarify", title: "Supplies", detail: "", questions: [
      { id: "feed", prompt: "Which feed?", options: ["Hay", "Pellets"] },
      { id: "where", prompt: "Where should it go?" },
    ] }] };
    await render();
    const first = container.querySelector<HTMLInputElement>('[data-question="0"] input')!;
    first.focus();
    await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true })));
    await act(async () => { vi.advanceTimersToNextFrame(); });
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Where should it go?"]'));
  });

  it("keeps a free-text field for a question without options", async () => {
    conversation = { ...conversation, attention: [{ id: "ask", kind: "clarify", title: "Name", detail: "", questions: [{ id: "name", prompt: "Gate name?" }] }] };
    await render();
    await typeInto(container.querySelector<HTMLTextAreaElement>('[aria-label="Gate name?"]')!, "North");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-attention-id="ask"] button[type="submit"]')!.click());
    expect(write).toHaveBeenCalledWith("/bots/shared/requests/ask", { answers: { name: "North" }, answerFormat: "json" });
  });

  it("addresses approval cards for the status dock", async () => {
    conversation = { ...conversation, approvals: [{ id: "gate", title: "Open the gate?", detail: "", status: "pending" }] };
    await render();
    expect(container.querySelector('[data-attention-id="gate"]')?.id).toBe("attention-approval-gate");
  });

  it("keeps line breaks and number keys in a written answer without selecting another option", async () => {
    conversation = { ...conversation, attention: [{ id: "ask", kind: "clarify", title: "Packing", detail: "", questions: [
      { id: "items", prompt: "What should come along?", options: ["Water", "Snacks"], multiple: true },
    ] }] };
    await render();
    const boxes = [...container.querySelectorAll<HTMLInputElement>('.question input[type="checkbox"]')];
    await act(async () => boxes[2].click());
    const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Your answer: What should come along?"]')!;
    await typeInto(field, "2 bottles of water\nA warm layer");
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true })));
    expect(boxes[1].checked).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('.attention-card button[type="submit"]')!.click());
    expect(write).toHaveBeenCalledWith("/bots/shared/requests/ask", { answers: { items: JSON.stringify(["2 bottles of water\nA warm layer"]) }, answerFormat: "json" });
    await act(async () => container.querySelector<HTMLFormElement>('.attention-card form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(vi.mocked(write).mock.calls.filter(([path]) => path === "/bots/shared/requests/ask")).toHaveLength(1);
    expect(container.querySelector<HTMLButtonElement>('.attention-card button[type="submit"]')?.textContent).toBe("Answers sent");
  });

  it("keeps answers editable while disconnected and sends only after reconnect", async () => {
    const { AttentionCard } = await import("../src/app/AttentionCard");
    const question = { id: "ask", kind: "clarify" as const, title: "Plan", detail: "", questions: [{ id: "note", prompt: "Your plan?" }] };
    const report = vi.fn();
    await act(async () => root.render(createElement(AttentionCard, { request: question, botId: "shared", report, disconnected: true })));
    const field = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await typeInto(field, "Bring water");
    expect(container.textContent).toContain("Reconnect before sending");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(write).not.toHaveBeenCalled();
    await act(async () => root.render(createElement(AttentionCard, { request: question, botId: "shared", report, disconnected: false })));
    expect(field.value).toBe("Bring water");
    expect(write).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(write).toHaveBeenCalledWith("/bots/shared/requests/ask", { answers: { note: "Bring water" }, answerFormat: "json" });
  });

  it("keeps written answers after a failure and clears the old error when retrying", async () => {
    conversation = { ...conversation, attention: [{ id: "ask", kind: "clarify", title: "Plan", detail: "", questions: [{ id: "note", prompt: "Your plan?" }] }] };
    vi.mocked(write).mockRejectedValueOnce(new Error("The connection was interrupted."));
    await render();
    const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Your plan?"]')!;
    await typeInto(field, "A slow morning\nBring water");
    const submit = container.querySelector<HTMLButtonElement>('.attention-card button[type="submit"]')!;
    await act(async () => submit.click());
    expect(container.querySelector(".notice.error")?.textContent).toContain("The connection was interrupted.");
    expect(field.value).toBe("A slow morning\nBring water");
    await act(async () => submit.click());
    expect(container.querySelector(".notice.error")).toBeNull();
    const payloads = vi.mocked(write).mock.calls.filter(([path]) => path === "/bots/shared/requests/ask");
    expect(payloads).toHaveLength(2);
    expect(payloads[0][1]).toEqual(payloads[1][1]);
    expect(submit.disabled).toBe(true);
  });
});

describe("approval decisions", () => {
  it("cheers the assistant on an approval, nods on a decline and folds a settled card away", async () => {
    const reactions: unknown[] = [];
    const heard = (event: Event) => reactions.push((event as CustomEvent).detail);
    window.addEventListener("wildbots:avatar-react", heard);
    try {
      conversation = { ...conversation, approvals: [
        { id: "gate", title: "Open the gate?", detail: "", status: "pending" },
        { id: "lights", title: "Turn on the lights?", detail: "", status: "pending" },
      ] };
      await render();
      const [first, second] = [...container.querySelectorAll(".approval-card")];
      await act(async () => first.querySelector<HTMLButtonElement>("button")!.click());
      await act(async () => second.querySelectorAll<HTMLButtonElement>("button")[1].click());
      expect(reactions).toEqual([{ botId: "shared", kind: "cheer" }, { botId: "shared", kind: "nod" }]);
      expect(first.getAttribute("data-settled")).toBe("approved");
      // Hermes stops listing the first: it stays a moment as a folding, inert card that no longer counts as pending.
      conversation = { ...conversation, approvals: conversation.approvals.filter(approval => approval.id !== "gate") };
      await act(async () => FakeEventSource.notifyAll());
      await advance(50);
      const leaving = container.querySelector(".approval-card.leaving");
      expect(leaving?.textContent).toContain("Open the gate?");
      expect(leaving?.hasAttribute("inert")).toBe(true);
      expect(leaving?.getAttribute("data-attention-id")).toBeNull();
      await advance(500);
      expect(container.querySelector(".approval-card.leaving")).toBeNull();
      // The declined one folds to a line saying the assistant stopped that step.
      expect([...container.querySelectorAll(".approval-card")].map(node => node.textContent)).toEqual(["Declined. Shared stopped that step."]);
    } finally { window.removeEventListener("wildbots:avatar-react", heard); }
  });
  for (const decision of ["approved", "denied"] as const) {
    it(`retries a failed ${decision} decision, clears the error and prevents another send`, async () => {
      conversation = { ...conversation, approvals: [{ id: "gate", title: "Create the reminder?", detail: "Notify both household members.", status: "pending" }] };
      vi.mocked(write).mockRejectedValueOnce(new ApiError("Could not send your decision.", 400));
      await render();
      const card = container.querySelector(".approval-card")!;
      const buttons = [...card.querySelectorAll<HTMLButtonElement>("button")];
      const button = buttons[decision === "approved" ? 0 : 1];
      await act(async () => button.click());
      expect(container.querySelector(".notice.error")?.textContent).toContain("Could not send your decision.");
      expect(button.disabled).toBe(false);
      await act(async () => button.click());
      expect(container.querySelector(".notice.error")).toBeNull();
      if (decision === "approved") {
        expect(button.disabled).toBe(true);
        expect(button.textContent).toContain("Approved");
        expect(card.querySelector('[role="status"]')?.textContent).toBe("Approval sent.");
        expect(card.querySelector(".decision-status.sr-only")).toBeNull();
        await act(async () => button.click());
      } else {
        expect(container.querySelector(".approval-card")?.textContent).toBe("Declined. Shared stopped that step.");
        expect(container.querySelector(".approval-card button")).toBeNull();
      }
      const calls = vi.mocked(write).mock.calls.filter(([path]) => path === "/bots/shared/approvals/gate");
      expect(calls).toHaveLength(2);
      expect(calls.map(([, body]) => body)).toEqual([{ decision }, { decision }]);
    });
  }
  it("blocks disconnected decisions and puts reconnection before the Review action", async () => {
    conversation = { ...conversation, approvals: [{ id: "offline-decision", title: "Open the gate?", detail: "", status: "pending" }] };
    const original = bootstrap.connection;
    try {
      await render();
      bootstrap.connection = { connected: false, code: "unreachable" };
      await advance(45_000);
      const buttons = [...container.querySelectorAll<HTMLButtonElement>(".approval-card button")];
      expect(buttons.every(button => button.disabled)).toBe(true);
      expect(container.querySelector(".approval-card")?.textContent).toContain("Reconnect to Hermes to answer.");
      expect(container.querySelector(".status-dock")?.firstElementChild?.className).toContain("dock-connection");
      await act(async () => buttons[0].click());
      expect(write).not.toHaveBeenCalled();
    } finally { bootstrap.connection = original; }
  });

  it("keeps an unclear approval across reload, never resends automatically and fences an opposite decision", async () => {
    conversation = { ...conversation, approvals: [{ id: "uncertain-decision", title: "Open the gate?", detail: "", status: "pending" }] };
    vi.mocked(write).mockRejectedValueOnce(new ApiError("Timed out", 504));
    await render();
    await act(async () => buttonText("Approve")!.click());
    expect(buttonText("Decline")?.disabled).toBe(true);
    expect(buttonText("Send approval again")?.disabled).toBe(false);
    expect(container.querySelector(".approval-card")?.getAttribute("aria-busy")).toBe("false");
    expect(container.querySelector(".approval-card")?.textContent).toContain("It may still go through");
    // A fresh read still showing pending does not prove the first POST stopped.
    await changed();
    await act(async () => root.unmount());
    await render();
    expect(buttonText("Decline")?.disabled).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    vi.mocked(write).mockRejectedValueOnce(new ApiError("This approval is no longer pending", 409));
    await act(async () => buttonText("Send approval again")!.click());
    expect(container.querySelector(".approval-card button")).toBeNull();
    expect(container.querySelector(".approval-card")?.textContent).toContain("Its status will update with the conversation.");
    const calls = vi.mocked(write).mock.calls.filter(([path]) => path === "/bots/shared/approvals/uncertain-decision");
    expect(calls.map(([, body]) => body)).toEqual([{ decision: "approved" }, { decision: "approved" }]);
  });

  it("retires an initially refused 409 decision while refreshing, without claiming it was sent", async () => {
    conversation = { ...conversation, approvals: [{ id: "no-longer-available", title: "Open the gate?", detail: "", status: "pending" }] };
    vi.mocked(write).mockRejectedValueOnce(new ApiError("This approval is no longer pending", 409));
    await render();
    await act(async () => buttonText("Approve")!.click());
    const card = container.querySelector(".approval-card")!;
    expect(card.querySelector("button")).toBeNull();
    expect(card.textContent).toContain("This request is no longer available to answer.");
    expect(card.textContent).not.toContain("Approval sent.");
    expect(write).toHaveBeenCalledTimes(1);
    conversation = { ...conversation, approvals: [] };
    await changed();
    expect(container.querySelector(".approval-card")).toBeNull();
  });

  it("leaves an approval answerable after a definite maintenance refusal", async () => {
    conversation = { ...conversation, approvals: [{ id: "maintenance-decision", title: "Open the gate?", detail: "", status: "pending" }] };
    vi.mocked(write).mockRejectedValueOnce(new ApiError("Hermes is being upgraded.", 409, "hermes_maintenance"));
    await render();
    await act(async () => buttonText("Approve")!.click());
    expect(buttonText("Approve")?.disabled).toBe(false);
    expect(buttonText("Decline")?.disabled).toBe(false);
    expect(container.textContent).toContain("Try your decision again when the update finishes.");
    expect(container.textContent).not.toContain("no longer available to answer");
    await act(async () => buttonText("Decline")!.click());
    expect(container.querySelector(".approval-card")?.textContent).toBe("Declined. Shared stopped that step.");
  });

  it("retains an earlier unclear choice when a resend meets maintenance", async () => {
    conversation = { ...conversation, approvals: [{ id: "uncertain-maintenance", title: "Open the gate?", detail: "", status: "pending" }] };
    vi.mocked(write).mockRejectedValueOnce(new ApiError("Timed out", 504));
    await render();
    await act(async () => buttonText("Approve")!.click());
    vi.mocked(write).mockRejectedValueOnce(new ApiError("Hermes is being upgraded.", 409, "hermes_maintenance"));
    await act(async () => buttonText("Send approval again")!.click());
    expect(buttonText("Send approval again")?.disabled).toBe(false);
    expect(buttonText("Decline")?.disabled).toBe(true);
    expect(container.textContent).not.toContain("no longer available to answer");
    expect(vi.mocked(write).mock.calls.map(([, body]) => body)).toEqual([{ decision: "approved" }, { decision: "approved" }]);
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
    // The title's parser loads on first save.
    await act(async () => { await vi.dynamicImportSettled(); });
    // A live save is titled like one from history: its first line, without Markdown.
    expect(write).toHaveBeenCalledWith("/saved", { kind: "session", botId: "shared", sessionId: "live", messageId: "a", title: "Pot roast tonight." });
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
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    conversation = { ...conversation, earlier: 4, messages: [prompt("q", "Is the north gate shut?"), answer("a", "The gate is shut."), answer("b", "Barn is fine.")] } as Conversation;
    searchHits = [
      { botId: "shared", botName: "Shared", sessionId: "live", title: "", snippet: "", messageId: "old", offset: 2 },
      { botId: "shared", botName: "Shared", sessionId: "live", title: "", snippet: "", messageId: "a" },
      { botId: "shared", botName: "Shared", sessionId: "earlier-session", title: "", snippet: "", messageId: "elsewhere" },
    ];
  });
  const find = () => container.querySelector<HTMLInputElement>('.find-bar input')!;
  const count = () => container.querySelector(".find-count")?.textContent;

  it("leaves Control+F alone on Mac and uses it on non-Apple platforms", async () => {
    await render();
    const press = () => {
      const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true });
      window.dispatchEvent(event); return event;
    };
    let event!: KeyboardEvent;
    await act(async () => { event = press(); });
    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector(".find-bar")).toBeNull();
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await act(async () => { event = press(); });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(find());
  });

  it("scrolls to the matching text inside a long message", async () => {
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    const previous = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    const rect = vi.fn(function (this: Range) {
      expect(this.toString().toLowerCase()).toBe("gate");
      return { top: 800 - (container.querySelector<HTMLElement>(".transcript")?.scrollTop ?? 0) };
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: rect });
    try {
      await render();
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, cancelable: true })));
      await typeInto(find(), "gate");
      expect(rect).toHaveBeenCalled();
      expect(container.querySelector<HTMLElement>(".transcript")!.scrollTop).toBe(700);
    } finally {
      if (previous) Object.defineProperty(Range.prototype, "getBoundingClientRect", previous);
      else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    }
  });

  it("keeps the selected match when a new matching reply arrives", async () => {
    await render();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, cancelable: true })));
    await typeInto(find(), "gate");
    await advance(300);
    expect(count()).toBe("3 of 3");
    conversation = { ...conversation, messages: [...conversation.messages, answer("newest", "Another gate update.")] };
    await changed();
    expect(count()).toBe("3 of 4");
  });

  it("pins a replacement when an edited message no longer matches", async () => {
    searchHits = [];
    await render();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, cancelable: true })));
    await typeInto(find(), "gate");
    await advance(300);
    expect(count()).toBe("2 of 2");
    conversation = { ...conversation, messages: conversation.messages.map(message => message.id === "a" ? answer("a", "No updates.") : message) };
    await changed();
    expect(count()).toBe("1 of 1");
    conversation = { ...conversation, messages: [...conversation.messages, answer("newest", "Another gate update.")] };
    await changed();
    expect(count()).toBe("1 of 2");
  });

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
    // Safari's Enter and Escape that end an IME composition report keyCode 229 and belong to the input method.
    await act(async () => find().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true })));
    await act(async () => find().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, bubbles: true })));
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

  it("opens an unloaded match even when a refresh is in flight", async () => {
    await render();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, cancelable: true })));
    await typeInto(find(), "gate");
    await advance(300);
    let finish!: (value: unknown) => void;
    const previous = vi.mocked(api).getMockImplementation()!;
    const older = { ...conversation, earlier: 0, messages: [prompt("old", "Which gate?"), ...conversation.messages] };
    vi.mocked(api).mockImplementation(async <T>(path: string, ...rest: unknown[]) => (path === "/bots/shared/conversation?start=q"
      ? new Promise(resolve => { finish = resolve; })
      : path === "/bots/shared/conversation?start=old" ? older : previous(path, ...rest as [])) as T);
    // A change notice starts a refresh of the loaded window, which stays in flight.
    await act(async () => FakeEventSource.notifyAll());
    expect(finish).toBeDefined();
    await act(async () => find().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => find().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(count()).toBe("1 of 3");
    // The refresh answers after the match was asked for: it neither moves the window nor uses up the target.
    await act(async () => finish({ ...conversation }));
    await advance(0);
    expect(api).toHaveBeenCalledWith("/bots/shared/conversation?start=old");
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === "/bots/shared/conversation?start=q")).toHaveLength(1);
    expect(container.querySelector('[data-message-id="old"]')?.hasAttribute("data-found")).toBe(true);
  });

  it("drops a search response for an older query", async () => {
    let first!: (value: unknown) => void;
    vi.mocked(api).mockImplementation(async <T>(path: string) => (path === "/search?q=ga&botId=shared"
      ? new Promise(resolve => { first = resolve; })
      : path === "/bootstrap?roster=lean" ? bootstrap : path === "/bots/shared/draft" ? savedDraft
      : path.startsWith("/search?") ? { hits: [], unavailableBots: [] } : conversation) as T);
    await render();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, cancelable: true })));
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

describe("progress lines", () => {
  const progress = (id: string, text: string, extra: Partial<Message> = {}): Message => answer(id, text, { interim: true, createdAt: "2026-10-01T16:00:03Z", ...extra });
  const call = { id: "c1", name: "terminal", status: "completed" as const };
  it("reads as the assistant talking before the work, apart from the answer, with no reply actions", async () => {
    conversation = { ...conversation, messages: [
      prompt("q", "Weather?", { createdAt: "2026-10-01T16:00:00Z" }),
      progress("n", "I'll check the forecast first."),
      { id: "t", role: "tool", text: "", toolCall: call },
      answer("a", "Sunny, 75.", { createdAt: "2026-10-01T16:00:30Z" }),
    ] };
    await render();
    const rows = [...container.querySelectorAll(".conversation-turn > *")].map(node => node.getAttribute("data-message-id") ?? node.className);
    // The progress line comes first, then the folded work, then the answer.
    expect(rows).toEqual(["q", "n", "turn-work", "a"]);
    const line = container.querySelector<HTMLElement>('[data-message-id="n"]')!;
    expect(line.classList.contains("message-interim")).toBe(true);
    expect(line.textContent).toBe("I'll check the forecast first.");
    // Nothing to copy, listen to or quote, and no time under it.
    expect(line.querySelector(".message-meta, .message-actions")).toBeNull();
    expect(container.querySelector('[data-message-id="a"] .message-actions')).not.toBeNull();
    expect(container.querySelector('[data-message-id="a"]')!.classList.contains("message-continued")).toBe(false);
    expect(container.querySelector(".turn-work summary")?.textContent).toBe("Worked for 30s · 1 tool call");
  });
  it("keeps the work row after the line while the turn is still running", async () => {
    conversation = { ...conversation, activity: { state: "working", runId: "r" }, messages: [
      prompt("q", "Weather?"),
      progress("n", "I'll check the forecast first."),
      { id: "t", role: "tool", text: "", toolCall: { ...call, status: "running" } },
    ] };
    await render();
    const rows = [...container.querySelectorAll(".conversation-turn > *")].map(node => node.getAttribute("data-message-id") ?? node.className);
    expect(rows).toEqual(["q", "n", "turn-work"]);
  });
  it("does not fold the work above a second progress line that comes after tools", async () => {
    conversation = { ...conversation, messages: [
      prompt("q", "Weather?"),
      progress("n1", "I'll check the forecast."),
      { id: "t1", role: "tool", text: "", toolCall: call },
      progress("n2", "Now the radar."),
      { id: "t2", role: "tool", text: "", toolCall: { ...call, id: "c2" } },
      answer("a", "Sunny."),
    ] };
    await render();
    const rows = [...container.querySelectorAll(".conversation-turn > *")].map(node => node.getAttribute("data-message-id") ?? node.className);
    expect(rows).toEqual(["q", "n1", "n2", "turn-work", "a"]);
  });
  it("places the work before the answer even when a progress line comes after the tools", async () => {
    conversation = { ...conversation, messages: [prompt("q", "Weather?"), { id: "t", role: "tool", text: "", toolCall: call },
      progress("n", "Now I'll write it up."), answer("a", "Sunny.")] };
    await render();
    const rows = [...container.querySelectorAll(".conversation-turn > *")].map(node => node.getAttribute("data-message-id") ?? node.className);
    expect(rows).toEqual(["q", "n", "turn-work", "a"]);
  });
  it("keeps a progress line apart from the answer beside it, with or without work between", async () => {
    conversation = { ...conversation, messages: [prompt("q", "Weather?"), progress("n", "I'll check the forecast."), answer("a", "Sunny.")] };
    await render();
    const line = container.querySelector('[data-message-id="n"]')!, reply = container.querySelector('[data-message-id="a"]')!;
    expect(reply.classList.contains("message-continued")).toBe(false);
    expect(line.classList.contains("message-continued")).toBe(false);
    // The answer keeps its own time, since the line above it is not one of its parts.
    expect(reply.querySelector(".message-meta")).not.toBeNull();
  });
  it("shows a historical line sensibly when it is the only assistant text of an old turn", async () => {
    conversation = { ...conversation, messages: [prompt("q", "Check search console"), progress("n", "I'll check Search Console and re-test the live site..."),
      { id: "t", role: "tool", text: "", toolCall: call }] };
    await render();
    expect(container.querySelector('[data-message-id="n"]')?.textContent).toBe("I'll check Search Console and re-test the live site...");
  });
  it("does not render inline pages from a progress line", async () => {
    const page = "```wildbots-html\n" + JSON.stringify({ version: 1, title: "Chart", html: "<p>hi</p>" }) + "\n```";
    conversation = { ...conversation, messages: [prompt("q", "Chart?"), progress("n", page)] };
    await render();
    expect(container.querySelector('[data-message-id="n"] iframe')).toBeNull();
  });
});

describe("turn work", () => {
  it("folds a finished turn's tools into one row with its duration, outside of which decisions stay", async () => {
    const call = { id: "c1", name: "terminal", status: "completed" as const, startedAt: "2026-10-01T16:00:05Z" };
    conversation = { ...conversation, approvals: [{ id: "gate", title: "Open the gate?", detail: "", status: "pending" }], messages: [
      prompt("q", "Check it", { createdAt: "2026-10-01T16:00:00Z" }),
      { id: "t", role: "tool", text: "", toolCall: call },
      // Hermes files a subagent's result as a user row; it is still this turn's work.
      { id: "s", role: "user", text: "Subagent Task Completed: Check", origin: { kind: "subagent", visibility: "activity" } },
      answer("a", "Checked.", { createdAt: "2026-10-01T16:02:14Z" }),
    ] };
    await render();
    expect(container.querySelectorAll(".turn-work")).toHaveLength(1);
    const fold = container.querySelector<HTMLDetailsElement>(".turn-work")!;
    expect(fold.querySelector("summary")?.textContent).toBe("Worked for 2m 14s · 1 tool call, 1 subagent");
    expect(fold.nextElementSibling?.getAttribute("data-message-id")).toBe("a");
    expect(fold.open).toBe(false);
    expect(fold.contains(container.querySelector(".approval-card"))).toBe(false);
  });

  it("shows the running tool's receipt beside the working avatar", async () => {
    conversation = { ...conversation, activity: { state: "working", runId: "r" }, messages: [prompt("q", "Check it")],
      toolCalls: [{ id: "c1", name: "calendar.create_event", status: "running" }] };
    await render();
    expect(container.querySelector(".turn-work summary")?.textContent).toBe("Working · 1 tool call");
    expect(container.querySelector(".activity-live-tool")?.textContent).toBe("Action in progress · calendar.create_event");
    expect(container.querySelector(".activity-watch")).toBeNull();
  });

  it("offers Watch while the running tool uses the household computer", async () => {
    conversation = { ...conversation, activity: { state: "working", runId: "r" }, messages: [prompt("q", "Check the order")],
      toolCalls: [{ id: "c1", name: "browser_navigate", status: "running" }] };
    await render();
    const opened = vi.fn();
    window.addEventListener("wildbots:computer", opened);
    try {
      const watch = container.querySelector<HTMLButtonElement>(".activity-watch")!;
      expect(watch.textContent).toBe("Watch");
      await act(async () => watch.click());
      expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ take: false });
    } finally { window.removeEventListener("wildbots:computer", opened); }
  });
});

describe("scroll intent", () => {
  const attentionLayout = () => {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(2600);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const id = (this as HTMLElement).dataset.attentionId;
      const offset = id === "first" ? 500 : id === "ask" ? 1000 : id === "gate" ? 1400 : (this as HTMLElement).dataset.messageId ? 200 : 0;
      const top = offset ? offset - (this.closest(".transcript")?.scrollTop ?? 0) : 0;
      return { top, bottom: top + 60, left: 0, right: 400, width: 400, height: 60, x: 0, y: top, toJSON() {} };
    });
  };
  it("opens a pending approval without a jump and follows after it is removed", async () => {
    attentionLayout();
    conversation = { ...conversation, approvals: [{ id: "gate", title: "Create the reminder?", detail: "Notify both members.", status: "pending" }] };
    await render();
    const transcript = container.querySelector<HTMLElement>(".transcript")!;
    expect(transcript.scrollTop).toBe(1400);
    expect(container.querySelector(".jump-latest")).toBeNull();
    conversation = { ...conversation, approvals: [], messages: [...conversation.messages, answer("after-approval", "Your decision was received.")] };
    await changed();
    expect(transcript.scrollTop).toBe(2600);
    expect(container.querySelector(".jump-latest")).toBeNull();
  });
  for (const kind of ["official", "secure"] as const) {
    it(kind === "secure" ? "preserves the explicit secure-request reveal ahead of a question" : "opens the question when an official card is listed before it", async () => {
      attentionLayout();
      const first: AttentionRequest = { id: "first", kind, title: "Earlier request", detail: "Still waiting." };
      if (kind === "secure") first.secure = { epoch: "fixture", sessionId: "live", method: "vault.code" };
      conversation = { ...conversation, attention: [first,
        { id: "ask", kind: "clarify", title: "A plan", detail: "", questions: [{ id: "plan", prompt: "Your plan?" }] },
      ] };
      await render();
      if (kind === "secure") expect(container.querySelector(".secure-request")).not.toBeNull();
      expect(container.querySelector<HTMLElement>(".transcript")!.scrollTop).toBe(kind === "secure" ? 500 : 1000);
      if (kind === "official") expect(container.querySelector(".jump-latest")).toBeNull();
    });
  }

  it("opens a pending question at its beginning and preserves the reader's position on refresh", async () => {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(2600);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const offset = this.matches(".attention-card") ? 1000 : (this as HTMLElement).dataset.messageId ? 200 : 0;
      const top = offset ? offset - (this.closest(".transcript")?.scrollTop ?? 0) : 0;
      return { top, bottom: top + 60, left: 0, right: 400, width: 400, height: 60, x: 0, y: top, toJSON() {} };
    });
    conversation = { ...conversation, activity: { state: "blocked" }, attention: [
      { id: "ask", kind: "clarify", title: "A plan", detail: "", questions: [{ id: "plan", prompt: "Your plan?" }] },
    ] };
    await render();
    const transcript = container.querySelector<HTMLElement>(".transcript")!;
    expect(transcript.scrollTop).toBe(1000);
    expect(container.querySelector(".jump-latest")).toBeNull();
    await act(async () => { transcript.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 })); });
    expect(container.querySelector(".jump-latest")).not.toBeNull();
    transcript.scrollTop = 850;
    conversation = { ...conversation, activity: { state: "blocked", detail: "Still waiting" } };
    await changed();
    expect(transcript.scrollTop).toBe(850);
  });

  it("follows the reply when the opened question is removed", async () => {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(2600);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const offset = this.matches(".attention-card") ? 1000 : (this as HTMLElement).dataset.messageId ? 200 : 0;
      const top = offset ? offset - (this.closest(".transcript")?.scrollTop ?? 0) : 0;
      return { top, bottom: top + 60, left: 0, right: 400, width: 400, height: 60, x: 0, y: top, toJSON() {} };
    });
    conversation = { ...conversation, activity: { state: "blocked" }, attention: [
      { id: "ask", kind: "clarify", title: "A plan", detail: "", questions: [{ id: "plan", prompt: "Your plan?" }] },
    ] };
    await render();
    const transcript = container.querySelector<HTMLElement>(".transcript")!;
    expect(transcript.scrollTop).toBe(1000);
    conversation = { ...conversation, attention: [], messages: [...conversation.messages, answer("after-question", "Here is the plan.")] };
    await changed();
    expect(transcript.scrollTop).toBe(2600);
    expect(container.querySelector(".jump-latest")).toBeNull();
  });

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

  // A phone's keyboard or a taller composer shrinks the view and moves no content. A browser keeps
  // scrollTop, so the end drops below the fold unless the view itself is observed.
  describe("when the view shrinks", () => {
    let viewHeight = 300;
    const observed: { target: Element; callback: () => void }[] = [];
    const shrink = (to: number) => act(async () => {
      viewHeight = to;
      for (const { target, callback } of observed) if (target.classList.contains("transcript")) callback();
    });
    beforeEach(() => {
      viewHeight = 300;
      observed.length = 0;
      vi.stubGlobal("ResizeObserver", class {
        constructor(private callback: () => void) {}
        observe(target: Element) { observed.push({ target, callback: this.callback }); }
        disconnect() {}
      });
      vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) { return this.classList.contains("transcript") ? 2000 : 0; });
      vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) { return this.classList.contains("transcript") ? viewHeight : 0; });
      conversation = { ...conversation, messages: [prompt("q", "Hello"), answer("a", "Hi")] };
    });

    it("keeps a follower at the latest message", async () => {
      await render();
      const transcript = container.querySelector<HTMLElement>(".transcript")!;
      // Where the browser leaves a view that was at the end before it lost 150px.
      transcript.scrollTop = 2000 - 300;
      await shrink(150);
      expect(transcript.scrollTop).toBe(2000);
    });

    it("leaves a reader who scrolled up where they were", async () => {
      await render();
      const transcript = container.querySelector<HTMLElement>(".transcript")!;
      transcript.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      transcript.scrollTop = 900;
      await shrink(150);
      expect(transcript.scrollTop).toBe(900);
    });
  });
});

describe("send anchor", () => {
  // Rows sit at fixed offsets in the transcript; the view's scrollTop moves them.
  const layout = (positions: Record<string, number>) => {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(2600);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(400);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const id = (this as HTMLElement).dataset.messageId;
      const top = id ? positions[id] - (this.closest(".transcript")?.scrollTop ?? 0) : 0;
      return { top, bottom: top + 60, left: 0, right: 400, width: 400, height: 60, x: 0, y: top, toJSON() {} };
    });
  };
  let hook!: ReturnType<typeof useConversation>;
  const Harness = () => {
    hook = useConversation("shared", "one");
    return createElement("div", { className: "transcript", ref: hook.scroll },
      createElement("div", { ref: hook.content }, hook.conversation?.messages.map(message =>
        createElement("article", { key: message.id, "data-message-id": message.id, className: `message-${message.role}` }, message.text))),
      createElement("div", { ref: hook.endSpace }));
  };
  const top = (id: string) => container.querySelector(`[data-message-id="${id}"]`)!.getBoundingClientRect().top;
  const other = (id: string) => prompt(id, "Another member's guidance", { sender: { id: "two", name: "Two" } });
  const show = (messages: Message[]) => act(async () => hook.setConversation({ ...conversation, messages, draft: null, readPosition: null }));

  it("never reserves end space again once what follows the sent message has filled the view", async () => {
    layout({ q: 400, a: 600, mine: 1800 });
    let content = 2000;
    const reserved = () => Number.parseFloat(hook.endSpace.current?.style.height || "0") || 0;
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(() => content + reserved());
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this === hook.endSpace.current ? reserved() : 0;
    });
    conversation = { ...conversation, messages: [prompt("q", "Question"), answer("a", "Reply")] };
    await act(async () => root.render(createElement(Harness)));
    await act(async () => hook.history.anchorSend("request-1"));
    const own = [...conversation.messages, prompt("mine", "Check the feed order")];
    await show(own);
    expect(hook.endSpace.current!.style.height).toBe("176px");
    // A tall secure request card arrives below it, then is answered and leaves.
    content = 2800;
    await show([...own]);
    expect(hook.endSpace.current!.style.height).toBe("");
    content = 2000;
    await show([...own, answer("reply", "Two bags of pellets")]);
    expect(hook.endSpace.current!.style.height).toBe("");
  });

  // A phone's keyboard opening and closing shrinks and restores the view while nothing new arrives. A smaller view
  // needs less space below the message, which is not what follows the message filling the view.
  it("gives the reserved space back when a view that shrank grows again", async () => {
    layout({ q: 400, a: 600, mine: 1800 });
    let view = 400;
    const reserved = () => Number.parseFloat(hook.endSpace.current?.style.height || "0") || 0;
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(() => 2000 + reserved());
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) { return this.classList.contains("transcript") ? view : 0; });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this === hook.endSpace.current ? reserved() : 0;
    });
    const observed: { target: Element; callback: () => void }[] = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: () => void) {}
      observe(target: Element) { observed.push({ target, callback: this.callback }); }
      disconnect() {}
    });
    const resize = (to: number) => act(async () => {
      view = to;
      for (const { target, callback } of observed) if (target.classList.contains("transcript")) callback();
    });
    conversation = { ...conversation, messages: [prompt("q", "Question"), answer("a", "Reply")] };
    await act(async () => root.render(createElement(Harness)));
    await act(async () => hook.history.anchorSend("request-1"));
    await show([...conversation.messages, prompt("mine", "Check the feed order")]);
    expect(hook.endSpace.current!.style.height).toBe("176px");
    await resize(200);
    expect(hook.endSpace.current!.style.height).toBe("");
    await resize(400);
    expect(hook.endSpace.current!.style.height).toBe("176px");
    expect(top("mine")).toBe(24);
  });

  it("keeps this person's sent message near the top when another member posts after it", async () => {
    layout({ q: 400, a: 600, mine: 1800, theirs: 2200 });
    conversation = { ...conversation, messages: [prompt("q", "Question"), answer("a", "Reply")] };
    await act(async () => root.render(createElement(Harness)));
    await act(async () => hook.history.anchorSend("request-1"));
    // Hermes's copy has its own ID; it is this person's first message since the send.
    const own = [...conversation.messages, prompt("mine", "My new question")];
    await show(own);
    expect(top("mine")).toBe(24);
    await show([...own, other("theirs")]);
    expect(top("mine")).toBe(24);
  });

  it("follows the ID the receipt names, past this person's message from another device and later rows", async () => {
    layout({ q: 400, a: 600, elsewhere: 1400, mine: 1800, theirs: 2200 });
    conversation = { ...conversation, messages: [prompt("q", "Question"), answer("a", "Reply")] };
    await act(async () => root.render(createElement(Harness)));
    await act(async () => hook.history.anchorSend("request-1"));
    hook.history.sentAs("request-1", "mine");
    // A message from this same person on another device lands first; it is not this send.
    const elsewhere = prompt("elsewhere", "From my phone");
    await show([...conversation.messages, elsewhere, prompt("mine", "My new question"), other("theirs")]);
    expect(top("mine")).toBe(24);
  });

  it("waits for the message the receipt names when another of this person's messages arrives first", async () => {
    layout({ q: 400, a: 600, elsewhere: 1400, mine: 1800 });
    conversation = { ...conversation, messages: [prompt("q", "Question"), answer("a", "Reply")] };
    await act(async () => root.render(createElement(Harness)));
    await act(async () => hook.history.anchorSend("request-1"));
    hook.history.sentAs("request-1", "mine");
    const interim = [...conversation.messages, prompt("elsewhere", "From my phone")];
    await show(interim);
    await show([...interim, prompt("mine", "My new question")]);
    expect(top("mine")).toBe(24);
  });

  it("replaces a guessed message with the one a later receipt names", async () => {
    layout({ q: 400, a: 600, elsewhere: 1400, mine: 1800 });
    conversation = { ...conversation, messages: [prompt("q", "Question"), answer("a", "Reply")] };
    await act(async () => root.render(createElement(Harness)));
    await act(async () => hook.history.anchorSend("request-1"));
    // Before the receipt, this person's first new message is the best guess.
    const interim = [...conversation.messages, prompt("elsewhere", "From my phone")];
    await show(interim);
    expect(top("elsewhere")).toBe(24);
    hook.history.sentAs("request-1", "mine");
    await show([...interim, prompt("mine", "My new question")]);
    expect(top("mine")).toBe(24);
  });
});

describe("live work", () => {
  it("shows the turn's tools as a tape, docks a live desktop while a computer tool runs and tints the chat", async () => {
    const original = bootstrap.bots;
    bootstrap.bots = [{ ...original[0], avatar: { mode: "mascot", family: "fox", color: "#C46F2C", eyes: "round", accessory: "none" } }];
    // The desktop ticket never arrives here, so the preview stays as it first appears.
    const fallback = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string, init?: RequestInit) =>
      path === "/computer/desktop" ? new Promise<T>(() => {}) : fallback(path, init) as Promise<T>);
    try {
      conversation = { ...conversation, activity: { state: "working" }, messages: [prompt("q", "Find the feed store's hours")], toolCalls: [
        { id: "search", name: "web_search", status: "completed" },
        { id: "browse", name: "browser_navigate", status: "running" },
      ] };
      await render();
      expect([...container.querySelectorAll(".work-tape li")].map(item => item.className)).toEqual(["work-tape-step is-completed", "work-tape-step is-running"]);
      expect(labelled("Watch Shared on the computer")).not.toBeNull();
      expect(container.querySelector(".computer-peek")).not.toBeNull();
      const panel = container.querySelector<HTMLElement>(".conversation-panel")!;
      expect(panel.hasAttribute("data-tint")).toBe(true);
      expect(panel.style.getPropertyValue("--bot-tint")).toBe("#C46F2C");
      await act(async () => container.querySelector<HTMLButtonElement>(".computer-peek-close")!.click());
      expect(container.querySelector(".computer-peek")).toBeNull();
      // The run ends: the tape and the preview go with it.
      conversation = { ...conversation, activity: { state: "idle" }, toolCalls: [] };
      await changed();
      expect(container.querySelector(".work-tape")).toBeNull();
    } finally { bootstrap.bots = original; }
  });
});

describe("T3 Code threads", () => {
  // As Hermes records an MCP call to T3 Code's t3_thread_launch: the tool's text wrapped as {"result": ...}.
  const launch = (status: "running" | "completed" | "failed", extra: Partial<ToolCall> = {}): ToolCall => ({ id: "launch", name: "mcp_t3code_t3_thread_launch", status,
    arguments: JSON.stringify({ title: "Fix the gate sensor", message: "Find out why the north gate reads open.", workspaceStrategy: { type: "worktree", branch: "fix/gate" } }),
    ...status === "completed" ? { result: JSON.stringify({ result: JSON.stringify({ threadId: "t-1", link: "https://app.t3.codes/threads/env-1/t-1", projectId: "p",
      modelSelection: { model: "claude-opus-5-5" }, runId: "r", status: "queued" }) }) } : {}, ...extra });

  it("shows the started thread between the folded work and the reply, with Open in T3 Code", async () => {
    conversation = { ...conversation, messages: [prompt("q", "Start a thread to fix the gate"), { id: "t", role: "tool", text: "", toolCall: launch("completed") },
      answer("a", "Started a thread for it.")] };
    await render();
    const fold = container.querySelector(".turn-work")!;
    const card = container.querySelector<HTMLElement>(".t3-thread-card")!;
    expect(fold.nextElementSibling).toBe(card);
    expect(card.nextElementSibling?.getAttribute("data-message-id")).toBe("a");
    expect(fold.contains(card)).toBe(false);
    expect(card.textContent).toContain("T3 Code thread started");
    expect(card.querySelector("h3")?.textContent).toBe("Fix the gate sensor");
    expect([...card.querySelectorAll(".t3-thread-facts li")].map(item => item.textContent)).toEqual(["Claude Opus 5.5", "New worktree on fix/gate"]);
    const open = card.querySelector<HTMLAnchorElement>("a")!;
    expect(open.textContent?.trim()).toBe("Open in T3 Code");
    expect(open.href).toBe("https://app.t3.codes/threads/env-1/t-1");
    expect(open.target).toBe("_blank");
    expect(open.rel).toContain("noopener");
  });

  it("shows the thread starting while the call runs, then its link once T3 Code answers", async () => {
    conversation = { ...conversation, activity: { state: "working", runId: "r" }, messages: [prompt("q", "Start a thread")], toolCalls: [launch("running")] };
    await render();
    const card = () => container.querySelector<HTMLElement>(".t3-thread-card")!;
    expect(card().textContent).toContain("Starting a T3 Code thread");
    expect(card().querySelector("a")).toBeNull();
    conversation = { ...conversation, activity: { state: "idle" }, toolCalls: [launch("completed")] };
    await changed();
    expect(card().textContent).toContain("T3 Code thread started");
    expect(card().querySelector("a")?.getAttribute("href")).toBe("https://app.t3.codes/threads/env-1/t-1");
  });

  it("says why a launch failed and offers no link", async () => {
    conversation = { ...conversation, messages: [prompt("q", "Start a thread"),
      { id: "t", role: "tool", text: "", toolCall: launch("failed", { error: "Runtime mode exceeds this client's ceiling" }) }, answer("a", "That didn't work.")] };
    await render();
    const card = container.querySelector<HTMLElement>(".t3-thread-card")!;
    expect(card.textContent).toContain("T3 Code thread didn't start");
    expect(card.querySelector(".form-error")?.textContent).toBe("Runtime mode exceeds this client's ceiling");
    expect(card.querySelector("a")).toBeNull();
  });
});

describe("form replies", () => {
  const form = { id: "trip", type: "form", title: "Trip details", fields: [
    { id: "city", label: "Destination", kind: "text", required: true },
    { id: "pace", label: "Pace", kind: "choice", options: ["Relaxed", "Packed"], value: "Relaxed" },
    { id: "dog", label: "Bringing the dog", kind: "toggle" },
  ] };
  const reply = (card: object = form) => answer("a", "A few details first.\n\n```agent-ui\n" + JSON.stringify({ version: 1, cards: [card] }) + "\n```");
  const composer = () => container.querySelector<HTMLTextAreaElement>("#message")!;
  const card = () => container.querySelector<HTMLElement>(".reply-card-form")!;
  const field = (label: string) => [...card().querySelectorAll("label")].find(item => item.textContent?.startsWith(label))!;
  const send = () => act(async () => buttonText("Send answers")!.click());
  const sent = () => card().querySelector(".form-reply-sent")?.textContent?.trim();
  const answers = 'My answers to "Trip details":\n- Destination: Marfa\n- Pace: Packed\n- Bringing the dog: Yes';
  const saved = "agent-interface:form-reply:one:shared:a:trip";
  // The ID every tab and device derives for this person's attempt at this form.
  const formId = (attempt: number) => formRequestId("form-key-one", "shared", "a", "trip", attempt);
  /**
   * A form first looks up whether its answers already went, with its fields and Send disabled. The
   * lookup derives its ID with Web Crypto, which settles in real time, outside the pinned clock, so
   * a test waits for Send to be enabled, as the person does. Text still lands in a disabled field
   * in jsdom, but clicks don't: a click before then does nothing, and filling sends other answers.
   */
  const ready = () => waitForUi(() => expect(buttonText("Send answers")?.disabled).toBe(false));
  const fill = async () => {
    await ready();
    await typeInto(card().querySelector<HTMLInputElement>('input[type="text"]')!, "Marfa");
    await act(async () => field("Packed").querySelector("input")!.click());
    await act(async () => field("Bringing the dog").querySelector("input")!.click());
  };
  // The ID is derived with Web Crypto, which settles outside fake timers.
  const posted = (count: number) => waitForUi(() => expect(messagesWritten()).toHaveLength(count));
  const reload = async () => { await act(async () => root.unmount()); await render(); };
  /** Answers GET /submissions/:id from a table of receipts by ID, "uncertain" for any other. Returns the IDs looked up, in order. */
  const receipts = (statuses: Map<string, string>, otherwise = "uncertain") => {
    const looked: string[] = [];
    const previous = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string, ...rest: unknown[]) => {
      if (!path.startsWith("/submissions/")) return previous(path, ...rest as []) as T;
      const id = path.split("/")[2];
      looked.push(id);
      return { requestId: id, status: statuses.get(id) ?? otherwise } as T;
    });
    return looked;
  };
  const accept = () => vi.mocked(write).mockImplementation(async <T>(path: string, body: unknown) =>
    (path === "/bots/shared/messages" ? { requestId: (body as { requestId: string }).requestId, status: "accepted" } : {}) as T);
  beforeEach(() => { conversation = { ...conversation, messages: [prompt("q", "Plan a trip"), reply()] }; });

  it("sends the answers as the person's message under the form's own ID, never touching the draft", async () => {
    accept();
    await render();
    expect(composer().value).toBe("My saved draft");
    await fill();
    await send();
    await posted(1);
    const body = messagesWritten()[0][1] as Record<string, unknown>;
    expect(body).toEqual({ requestId: await formId(0), text: answers, attachments: [] });
    await waitForUi(() => expect(sent()).toBe("Sent"));
    expect(card().querySelector("form")).toBeNull();
    expect(card().querySelector(".form-reply-answers")?.textContent).toContain("Marfa");
    expect(composer().value).toBe("My saved draft");
    expect(vi.mocked(write).mock.calls.some(([path]) => String(path).endsWith("/draft"))).toBe(false);
  });

  it("starts over from the card's suggestions when the saved answers are malformed", async () => {
    localStorage.setItem(saved, JSON.stringify({ attempt: -1, answers: { city: "Marfa" }, state: "sent" }));
    await render();
    await ready();
    expect(card().querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("");
    expect(field("Relaxed").querySelector("input")!.checked).toBe(true);
  });

  it("keeps unsent answers across leaving the chat", async () => {
    await render();
    await fill();
    await reload();
    await waitForUi(() => expect(card().querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("Marfa"));
    expect(field("Packed").querySelector("input")!.checked).toBe(true);
    expect(messagesWritten()).toHaveLength(0);
  });

  it("names a required field left empty and sends nothing", async () => {
    await render();
    await ready();
    await send();
    expect(messagesWritten()).toHaveLength(0);
    const input = card().querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe("This one needs an answer.");
    expect(document.activeElement).toBe(input);
  });

  it("shows a form sent from another tab or device as sent, and sends nothing", async () => {
    receipts(new Map([[await formId(0), "rejected"], [await formId(1), "accepted"]]));
    await render();
    await waitForUi(() => expect(sent()).toBe("Sent"));
    expect(card().textContent).toContain("Your answers were sent from another tab or device.");
    expect(messagesWritten()).toHaveLength(0);
  });

  it("finds a form sent after many refusals, however many", async () => {
    const statuses = new Map<string, string>();
    for (let attempt = 0; attempt < 7; attempt++) statuses.set(await formId(attempt), "rejected");
    statuses.set(await formId(7), "accepted");
    receipts(statuses);
    await render();
    await waitForUi(() => expect(sent()).toBe("Sent"));
    expect(messagesWritten()).toHaveLength(0);
  });

  it("stops looking after 100 refused attempts and offers the next one", async () => {
    const looked = receipts(new Map(), "rejected");
    accept();
    await render();
    await waitForUi(() => expect(buttonText("Send answers")?.disabled).toBe(false), 5000);
    expect(looked).toHaveLength(100);
    await fill();
    await send();
    await posted(1);
    expect((messagesWritten()[0][1] as { requestId: string }).requestId).toBe(await formId(100));
  });

  it("treats a Hermes restart as maybe arrived, and sends again only when the person says so", async () => {
    receipts(new Map([[await formId(0), "interrupted"]]));
    accept();
    await render();
    await waitForUi(() => expect(card().textContent).toContain("may or may not have arrived"));
    expect(buttonText("Send answers")).toBeUndefined();
    expect(messagesWritten()).toHaveLength(0);
    await act(async () => buttonText("They didn't arrive. Edit and send again")!.click());
    await fill();
    await send();
    await posted(1);
    expect((messagesWritten()[0][1] as { requestId: string }).requestId).toBe(await formId(1));
  });

  it("follows the attempt it sent, not a refused earlier one, while Hermes hasn't confirmed it", async () => {
    const statuses = new Map<string, string>();
    const looked = receipts(statuses);
    let status = "rejected";
    vi.mocked(write).mockImplementation(async <T>(path: string, body: unknown) =>
      (path === "/bots/shared/messages" ? { requestId: (body as { requestId: string }).requestId, status } : {}) as T);
    await render();
    await fill();
    await send();
    await waitForUi(() => expect(card().querySelector('[role="alert"]')?.textContent).toBe("Hermes didn't take your answers."));
    statuses.set(await formId(0), "rejected");
    status = "uncertain";
    await send();
    await posted(2);
    const checkedFrom = looked.length;
    await advance(2100);
    await advance(4100);
    // Attempt 0's refusal must not reopen the form while attempt 1 is unconfirmed.
    expect(buttonText("Checking…")?.disabled).toBe(true);
    expect(buttonText("Send answers")).toBeUndefined();
    expect(messagesWritten()).toHaveLength(2);
    // Every check after the second send asks about the request that send made.
    expect(looked.slice(checkedFrom).length).toBeGreaterThan(0);
    expect(new Set(looked.slice(checkedFrom))).toEqual(new Set([(messagesWritten()[1][1] as { requestId: string }).requestId]));
  });

  it.each([["no", undefined], ["an empty", ""], ["a malformed", "not-an-id"]])("checks a saved request with %s ID under the ID its attempt derives, keeping its answers", async (_, requestId) => {
    const looked = receipts(new Map([[await formId(1), "accepted"]]));
    localStorage.setItem(saved, JSON.stringify({ attempt: 1, answers: { city: "Marfa", pace: "Packed", dog: true }, state: "checking", ...(requestId !== undefined && { requestId }) }));
    await render();
    await advance(2100);
    await waitForUi(() => expect(sent()).toBe("Sent"));
    expect(looked).toContain(await formId(1));
    expect(card().querySelector(".form-reply-answers")?.textContent).toContain("Marfa");
    expect(messagesWritten()).toHaveLength(0);
  });

  it("never lets a late answer to an earlier attempt overwrite a newer attempt's saved record", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(write).mockImplementation(async <T>(path: string) => path === "/bots/shared/messages"
      ? await new Promise<T>(resolve => { finish = value => resolve(value as T); }) : {} as T);
    await render();
    await fill();
    await send();
    await posted(1);
    // Another copy of this card moved on to attempt 1 while attempt 0 was out.
    const newer = { attempt: 1, answers: { city: "Austin", pace: "Relaxed", dog: false }, state: "editing" };
    localStorage.setItem(saved, JSON.stringify(newer));
    await act(async () => finish({ requestId: await formId(0), status: "accepted" }));
    expect(JSON.parse(localStorage.getItem(saved)!)).toEqual(newer);
  });

  it("lets a stale copy of the card undo no other copy's progress", () => {
    const record = (attempt: number, state: Saved["state"], requestId?: string): Saved => ({ attempt, answers: {}, state, ...(requestId && { requestId }) });
    const cases: [string, Saved | null, Saved, Parameters<typeof mayReplace>[2], boolean][] = [
      ["nothing saved yet", null, record(0, "editing"), {}, true],
      ["a later attempt's record", record(1, "sent"), record(0, "sent"), {}, false],
      ["moving on from the attempt saved", record(0, "checking", "a"), record(1, "editing"), { from: 0 }, true],
      ["moving on from an attempt another copy already moved past", record(1, "sent"), record(1, "editing"), { from: 0 }, false],
      ["typing over a sent record of the same attempt", record(1, "sent"), record(1, "editing"), {}, false],
      ["typing over another copy's request on its way", record(1, "checking", "a"), record(1, "editing"), {}, false],
      ["typing over an interrupted record", record(1, "interrupted"), record(1, "editing"), {}, false],
      ["sending again over a sent record of the same attempt", record(1, "sent"), record(1, "checking", "a"), {}, false],
      ["the owner's request refused outright", record(1, "checking", "a"), record(1, "editing"), { owns: "a" }, true],
      ["another request's refusal", record(1, "checking", "a"), record(1, "editing"), { owns: "b" }, false],
      ["sending from editing", record(1, "editing"), record(1, "checking", "a"), {}, true],
      ["a request settling as sent", record(1, "checking", "a"), record(1, "sent"), {}, true],
      ["only knowing the answers went, over a record that holds them", record(1, "sent"), { ...record(1, "sent"), elsewhere: true }, {}, false],
      ["the answers that went, over a record that only knows they went", { ...record(1, "sent"), elsewhere: true }, record(1, "sent"), {}, true],
      ["a restart, which only ever follows acceptance, over a sent record", record(1, "sent"), { ...record(1, "interrupted"), elsewhere: true }, {}, true],
      ["a stale acceptance over a restart", record(1, "interrupted"), record(1, "sent"), {}, false],
    ];
    for (const [name, stored, next, change, allowed] of cases) expect(mayReplace(stored, next, change), name).toBe(allowed);
  });

  it("keeps the answers another copy saw admitted when this one only knows they went", () => {
    const known: Saved = { attempt: 1, answers: { city: "Austin" }, state: "sent" };
    const restart: Saved = { attempt: 1, answers: { city: "" }, state: "interrupted", elsewhere: true };
    expect(keepKnownAnswers(known, restart)).toEqual({ attempt: 1, answers: { city: "Austin" }, state: "interrupted" });
    // Nothing known to keep: another attempt, an unconfirmed request, or a record that only knew it went too.
    for (const stored of [{ ...known, attempt: 0 }, { ...known, state: "checking" as const }, { ...known, elsewhere: true }, null])
      expect(keepKnownAnswers(stored, restart)).toBe(restart);
    expect(keepKnownAnswers(known, { ...restart, elsewhere: undefined })).toEqual({ ...restart, elsewhere: undefined });
  });

  it("keeps another copy's sent record when a stale copy is edited after a late refusal", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(write).mockImplementation(async <T>(path: string) => path === "/bots/shared/messages"
      ? await new Promise<T>(resolve => { finish = value => resolve(value as T); }) : {} as T);
    await render();
    await fill();
    await send();
    await posted(1);
    const newer = { attempt: 1, answers: { city: "Austin", pace: "Relaxed", dog: false }, state: "sent" };
    localStorage.setItem(saved, JSON.stringify(newer));
    await act(async () => finish({ requestId: await formId(0), status: "rejected" }));
    // This copy moved on to attempt 1 and is editable; typing in it must not reopen the sent form.
    await typeInto(card().querySelector<HTMLInputElement>('input[type="text"]')!, "Marfa2");
    expect(JSON.parse(localStorage.getItem(saved)!)).toEqual(newer);
  });

  it("shows another copy's different answers as sent from elsewhere, not its own, after losing its response", async () => {
    // Another copy sent other answers under this attempt's ID; this copy's own request got no answer.
    const theirs = 'My answers to "Trip details":\n- Destination: Austin\n- Pace: Relaxed\n- Bringing the dog: No';
    const previous = vi.mocked(api).getMockImplementation()!;
    // Until this copy sends, the lookup on open finds nothing; after, the server holds the admitted text.
    let tried = false;
    vi.mocked(api).mockImplementation(async <T>(path: string, ...rest: unknown[]) => path.startsWith("/submissions/")
      ? { requestId: path.split("/")[2], status: tried ? "accepted" : "uncertain", ...(tried && { text: theirs }) } as T : previous(path, ...rest as []) as T);
    vi.mocked(write).mockImplementation(async <T>(path: string) => {
      if (path === "/bots/shared/messages") { tried = true; throw new TypeError("Failed to fetch"); }
      return {} as T;
    });
    await render();
    await fill();
    await send();
    await posted(1);
    await advance(2100);
    await waitForUi(() => expect(sent()).toBe("Sent"));
    expect(card().textContent).toContain("Your answers were sent from another tab or device.");
    expect(card().querySelector(".form-reply-answers")).toBeNull();
    expect(JSON.parse(localStorage.getItem(saved)!)).toMatchObject({ state: "sent", elsewhere: true });
  });

  it("merges admitted answers into a record that only knew they went, whichever arrives first", () => {
    const record = (state: Saved["state"], answers: Record<string, string>, elsewhere?: boolean): Saved =>
      ({ attempt: 0, answers, state, ...(elsewhere && { elsewhere: true }) });
    const marfa = { city: "Marfa" }, blank = { city: "" };
    // The known acceptance arrives after the restart was saved: the status stays, the answers join it.
    expect(nextRecord(record("interrupted", blank, true), record("sent", marfa))).toEqual(record("interrupted", marfa));
    // The restart arrives after the known acceptance: the status moves on, the answers stay.
    expect(nextRecord(record("sent", marfa), record("interrupted", blank, true))).toEqual(record("interrupted", marfa));
    // Nothing admitted to merge: another copy's unconfirmed or unknown answers, or another attempt's.
    expect(nextRecord(record("interrupted", blank, true), record("checking", marfa))).toBeNull();
    expect(nextRecord(record("interrupted", blank, true), record("sent", blank, true))).toBeNull();
    expect(nextRecord(record("interrupted", blank, true), { ...record("sent", marfa), attempt: 1 }, { from: 0 })).toEqual({ ...record("sent", marfa), attempt: 1 });
  });

  it("keeps this copy's admitted answers when a restart was saved before its acceptance arrived", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(write).mockImplementation(async <T>(path: string) => path === "/bots/shared/messages"
      ? await new Promise<T>(resolve => { finish = value => resolve(value as T); }) : {} as T);
    await render();
    await fill();
    await send();
    await posted(1);
    // Meanwhile another copy learned of a restart and saved it, knowing only that answers went.
    localStorage.setItem(saved, JSON.stringify({ attempt: 0, answers: { city: "", pace: "Relaxed", dog: false }, state: "interrupted", elsewhere: true }));
    await act(async () => finish({ requestId: await formId(0), status: "accepted" }));
    expect(JSON.parse(localStorage.getItem(saved)!)).toEqual({ attempt: 0, answers: { city: "Marfa", pace: "Packed", dog: true }, state: "interrupted" });
    await reload();
    await waitForUi(() => expect(buttonText("They didn't arrive. Edit and send again")).toBeDefined());
    await act(async () => buttonText("They didn't arrive. Edit and send again")!.click());
    expect(card().querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("Marfa");
  });

  it("records a restart learned from another copy's request through a reload, keeping that copy's answers", async () => {
    const austin = { city: "Austin", pace: "Relaxed", dog: false };
    const theirs = 'My answers to "Trip details":\n- Destination: Austin\n- Pace: Relaxed\n- Bringing the dog: No';
    let tried = false;
    const previous = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string, ...rest: unknown[]) => path.startsWith("/submissions/")
      ? { requestId: path.split("/")[2], status: tried ? "interrupted" : "uncertain", ...(tried && { text: theirs }) } as T : previous(path, ...rest as []) as T);
    vi.mocked(write).mockImplementation(async <T>(path: string) => {
      if (path === "/bots/shared/messages") { tried = true; throw new TypeError("Failed to fetch"); }
      return {} as T;
    });
    await render();
    await fill();
    // Another copy sent Austin and saw it accepted, while this one fills in Marfa.
    localStorage.setItem(saved, JSON.stringify({ attempt: 0, answers: austin, state: "sent" }));
    await send();
    await posted(1);
    await advance(2100);
    await waitForUi(() => expect(card().textContent).toContain("may or may not have arrived"));
    expect(JSON.parse(localStorage.getItem(saved)!)).toEqual({ attempt: 0, answers: austin, state: "interrupted" });
    await reload();
    await waitForUi(() => expect(buttonText("They didn't arrive. Edit and send again")).toBeDefined());
    expect(sent()).toBeUndefined();
  });

  it("shows its own answers as sent when the server's text is theirs", async () => {
    const previous = vi.mocked(api).getMockImplementation()!;
    // Until this copy sends, the lookup on open finds nothing; after, the server holds the admitted text.
    let tried = false;
    vi.mocked(api).mockImplementation(async <T>(path: string, ...rest: unknown[]) => path.startsWith("/submissions/")
      ? { requestId: path.split("/")[2], status: tried ? "accepted" : "uncertain", ...(tried && { text: answers }) } as T : previous(path, ...rest as []) as T);
    vi.mocked(write).mockImplementation(async <T>(path: string) => {
      if (path === "/bots/shared/messages") { tried = true; throw new TypeError("Failed to fetch"); }
      return {} as T;
    });
    await render();
    await fill();
    await send();
    await posted(1);
    await advance(2100);
    await waitForUi(() => expect(sent()).toBe("Sent"));
    expect(card().querySelector(".form-reply-answers")?.textContent).toContain("Marfa");
  });

  it("never lets a late refusal of an earlier attempt overwrite a later attempt that was sent", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(write).mockImplementation(async <T>(path: string) => path === "/bots/shared/messages"
      ? await new Promise<T>(resolve => { finish = value => resolve(value as T); }) : {} as T);
    await render();
    await fill();
    await send();
    await posted(1);
    // Another copy of this card saw attempt 0 refused and sent attempt 1.
    const newer = { attempt: 1, answers: { city: "Austin", pace: "Relaxed", dog: false }, state: "sent" };
    localStorage.setItem(saved, JSON.stringify(newer));
    await act(async () => finish({ requestId: await formId(0), status: "rejected" }));
    expect(JSON.parse(localStorage.getItem(saved)!)).toEqual(newer);
  });

  it("keeps a refused answer's words in the form across leaving the chat, under the same ID", async () => {
    vi.mocked(write).mockImplementation(async <T>(path: string) => {
      if (path === "/bots/shared/messages") throw new ApiError("Review the interrupted task before starting another message.", 409);
      return {} as T;
    });
    await render();
    await fill();
    await send();
    await waitForUi(() => expect(card().querySelector('[role="alert"]')?.textContent).toBe("Review the interrupted task before starting another message."));
    expect(buttonText("Send answers")!.disabled).toBe(false);
    await reload();
    await waitForUi(() => expect(card().querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("Marfa"));
    expect(field("Packed").querySelector("input")!.checked).toBe(true);
    await send();
    await posted(2);
    // The server never recorded the refused request, so the same attempt is free.
    expect(messagesWritten().map(([, body]) => (body as { requestId: string }).requestId)).toEqual([await formId(0), await formId(0)]);
  });

  it("moves to a new attempt only after Hermes refuses one", async () => {
    let status = "rejected";
    vi.mocked(write).mockImplementation(async <T>(path: string, body: unknown) =>
      (path === "/bots/shared/messages" ? { requestId: (body as { requestId: string }).requestId, status, message: "Hermes is busy." } : {}) as T);
    await render();
    await fill();
    await send();
    await waitForUi(() => expect(card().querySelector('[role="alert"]')?.textContent).toBe("Hermes didn't take your answers. Hermes is busy."));
    status = "accepted";
    await send();
    await posted(2);
    expect(messagesWritten().map(([, body]) => (body as { requestId: string }).requestId)).toEqual([await formId(0), await formId(1)]);
    await waitForUi(() => expect(sent()).toBe("Sent"));
  });

  it("sends the same request again when browser storage failed, so the server admits it once", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
    vi.mocked(write).mockImplementation(async <T>(path: string) => {
      if (path === "/bots/shared/messages") throw new TypeError("Failed to fetch");
      return {} as T;
    });
    await render();
    await fill();
    await send();
    await posted(1);
    await reload();
    await waitForUi(() => expect(buttonText("Send answers")?.disabled).toBe(false));
    await fill();
    await send();
    await posted(2);
    const [firstId, secondId] = messagesWritten().map(([, body]) => (body as { requestId: string }).requestId);
    expect(secondId).toBe(firstId);
  });

  it("checks answers whose outcome is unknown by their ID, across a reload, and never sends them twice", async () => {
    const statuses = new Map<string, string>();
    receipts(statuses);
    vi.mocked(write).mockImplementation(async <T>(path: string) => {
      if (path === "/bots/shared/messages") throw new TypeError("Failed to fetch");
      return {} as T;
    });
    await render();
    await fill();
    await send();
    await waitForUi(() => expect(card().querySelector('[role="alert"]')?.textContent).toContain("won't be sent twice"));
    expect(buttonText("Checking…")!.disabled).toBe(true);
    await reload();
    await advance(2100);
    expect(buttonText("Send answers")).toBeUndefined();
    statuses.set(await formId(0), "accepted");
    await advance(4100);
    await waitForUi(() => expect(sent()).toBe("Sent"));
    expect(card().querySelector(".form-reply-answers")?.textContent).toContain("Marfa");
    expect(messagesWritten()).toHaveLength(1);
  });

  it("follows another tab's different answers under the same ID instead of reporting a failure", async () => {
    const statuses = new Map<string, string>();
    receipts(statuses);
    vi.mocked(write).mockImplementation(async <T>(path: string) => {
      if (path === "/bots/shared/messages") throw new ApiError("This submission ID was already used for different content", 409, "submission_conflict");
      return {} as T;
    });
    await render();
    await fill();
    await send();
    await waitForUi(() => expect(buttonText("Checking…")).toBeDefined());
    expect(card().querySelector('[role="alert"]')).toBeNull();
    statuses.set(await formId(0), "accepted");
    await advance(2100);
    await waitForUi(() => expect(sent()).toBe("Sent"));
    expect(card().textContent).toContain("Your answers were sent from another tab or device.");
  });

  it("sends under the person's review of an interrupted task", async () => {
    accept();
    conversation = { ...conversation, activity: { state: "interrupted", runId: "r" } };
    await render();
    const review = [...container.querySelectorAll("label")].find(label => label.textContent?.includes("I've reviewed the task's last actions"))!;
    await act(async () => review.querySelector("input")!.click());
    await fill();
    await send();
    await posted(1);
    expect(messagesWritten()[0][1]).toMatchObject({ reviewedInterruption: true });
  });

  it("works with field IDs that name what every object inherits", async () => {
    accept();
    conversation = { ...conversation, messages: [prompt("q", "Plan"), reply({ ...form, fields: [
      { id: "__proto__", label: "Destination", kind: "text", required: true }, { id: "constructor", label: "Notes", kind: "text" },
    ] })] };
    await render();
    await ready();
    await send();
    expect(messagesWritten()).toHaveLength(0);
    await typeInto(card().querySelector<HTMLInputElement>('input[type="text"]')!, "Marfa");
    await send();
    await posted(1);
    expect((messagesWritten()[0][1] as { text: string }).text).toBe('My answers to "Trip details":\n- Destination: Marfa');
  });

  it("refuses answers longer than a message can be, saying by how much", async () => {
    conversation = { ...conversation, messages: [prompt("q", "Plan"), reply({ ...form, fields: Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, label: `Field ${i}`, kind: "textarea" })) })] };
    await render();
    await ready();
    for (const area of card().querySelectorAll("textarea")) await typeInto(area, "x".repeat(3000));
    await send();
    expect(messagesWritten()).toHaveLength(0);
    expect(card().querySelector('[role="alert"]')?.textContent).toMatch(/^Your answers are [\d,]+ characters too long to send\./);
  });
});

describe("email drafts", () => {
  it("opens the draft in the mail app or Gmail and copies it, saying nothing was sent", async () => {
    const draft = { id: "reply", type: "email", title: "Reply to Sam", to: ["sam@example.com"], subject: "Saturday", body: "Hi Sam,\nSee you then." };
    conversation = { ...conversation, messages: [prompt("q", "Draft a reply to Sam"), answer("a", "Here's a draft.\n\n```agent-ui\n" + JSON.stringify({ version: 1, cards: [draft] }) + "\n```")] };
    await render();
    const card = container.querySelector<HTMLElement>(".reply-card-email")!;
    const links = Object.fromEntries([...card.querySelectorAll("a")].map(link => [link.textContent?.trim(), link.getAttribute("href")]));
    expect(links["Open in Mail"]).toBe("mailto:sam@example.com?subject=Saturday&body=Hi%20Sam%2C%0D%0ASee%20you%20then.");
    expect(new URL(links["Open in Gmail"]!).searchParams.get("su")).toBe("Saturday");
    expect(card.textContent).toContain("Nothing has been sent.");
    await act(async () => buttonText("Copy")!.click());
    expect(writeText).toHaveBeenCalledWith("To: sam@example.com\nSubject: Saturday\n\nHi Sam,\nSee you then.");
    expect(buttonText("Copied")).toBeDefined();
  });
});

describe("approval scopes, the decline handoff, recommended answers and steering", () => {
  const scoped = { id: "wipe", title: "Action approval", detail: "recursive delete", command: "rm -rf ./build", status: "pending" as const,
    choices: ["once", "session", "always", "deny"] as ("once" | "session" | "always" | "deny")[], patterns: ["recursive delete"] };
  const decisions = () => vi.mocked(write).mock.calls.filter(([path]) => path === "/bots/shared/approvals/wipe").map(([, body]) => body);
  const dialog = () => document.querySelector<HTMLElement>(".always-allow-confirm");
  beforeEach(() => {
    for (const [name, open] of [["showModal", true], ["close", false]] as const)
      Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, value: function(this: HTMLDialogElement) { this.open = open; } });
  });

  it("offers each scope Hermes allows and says what one for this conversation granted", async () => {
    conversation = { ...conversation, approvals: [scoped] };
    await render();
    const card = container.querySelector(".approval-card")!;
    expect([...card.querySelectorAll(".actions > button")].map(button => button.textContent)).toEqual(["Allow once", "Allow for this conversation", "Decline"]);
    expect(card.querySelector(".approval-command")?.textContent).toBe("rm -rf ./build");
    expect(card.textContent).toContain("covers every command Hermes flags as “recursive delete”, not only this one");
    await act(async () => buttonText("Allow for this conversation")!.click());
    expect(decisions()).toEqual([{ decision: "approved", scope: "session" }]);
    expect(card.querySelector('[role="status"]')?.textContent).toBe("Allowed for this conversation.");
    expect(buttonText("Allow once")?.disabled).toBe(true);
  });

  it("asks before Always allow, naming the pattern and the command, and Cancel sends nothing", async () => {
    conversation = { ...conversation, approvals: [scoped] };
    await render();
    await act(async () => labelled("More choices").click());
    await act(async () => buttonText("Always allow…")!.click());
    expect(dialog()?.textContent).toContain("Always allow this for Shared?");
    expect(dialog()?.textContent).toContain("any command Hermes flags as “recursive delete” without asking, in every conversation");
    expect(dialog()?.querySelector(".approval-command")?.textContent).toBe("rm -rf ./build");
    expect(dialog()?.textContent).toContain("Always-allowed commands");
    await act(async () => [...dialog()!.querySelectorAll("button")].find(button => button.textContent === "Cancel")!.click());
    expect(dialog()).toBeNull();
    expect(decisions()).toEqual([]);
    await act(async () => labelled("More choices").click());
    await act(async () => buttonText("Always allow…")!.click());
    await act(async () => [...dialog()!.querySelectorAll("button")].find(button => button.textContent === "Always allow")!.click());
    expect(decisions()).toEqual([{ decision: "approved", scope: "always" }]);
    expect(container.querySelector(".approval-card")?.textContent).toContain("Always allowed for Shared.");
  });

  it("shows only Allow once and Decline when Hermes limits the request to one operation", async () => {
    conversation = { ...conversation, approvals: [{ ...scoped, choices: ["once", "deny"] }] };
    await render();
    const card = container.querySelector(".approval-card")!;
    expect([...card.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Allow once", "Decline"]);
    expect(card.textContent).not.toContain("covers every command");
  });

  it("keeps the card answerable when the server refuses a choice Hermes no longer offers", async () => {
    conversation = { ...conversation, approvals: [scoped] };
    vi.mocked(write).mockRejectedValueOnce(new ApiError("Hermes didn't offer Allow for this conversation for this request.", 409, "approval_choice_unavailable"));
    await render();
    await act(async () => buttonText("Allow for this conversation")!.click());
    expect(container.querySelector(".notice.error")?.textContent).toContain("Hermes didn't offer Allow for this conversation");
    expect(buttonText("Allow once")?.disabled).toBe(false);
    expect(buttonText("Decline")?.disabled).toBe(false);
  });

  it("keeps the declined line and the message box's question until the next message is accepted", async () => {
    conversation = { ...conversation, activity: { state: "waiting" }, approvals: [scoped] };
    vi.mocked(write).mockImplementation(async <T>(path: string, body: unknown) =>
      (path === "/bots/shared/messages" || path === "/bots/shared/steer" ? { requestId: (body as { requestId: string }).requestId, status: "accepted" } : {}) as T);
    await render();
    await act(async () => buttonText("Decline")!.click());
    expect(decisions()).toEqual([{ decision: "denied" }]);
    await act(async () => { vi.advanceTimersToNextFrame(); });
    expect(document.activeElement).toBe(textarea());
    // Hermes stops listing the request; the line stays with the transcript.
    conversation = { ...conversation, activity: { state: "thinking" }, approvals: [] };
    await changed();
    await advance(500);
    expect(container.querySelector(".approval-card")?.textContent).toBe("Declined. Shared stopped that step.");
    await typeInto(textarea(), "Just clean the cache folder");
    await act(async () => labelled("Send guidance").click());
    await waitForUi(() => expect(container.querySelector(".approval-card")).toBeNull());
    await typeInto(textarea(), "");
    expect(textarea().placeholder).not.toBe("Tell Shared what to do instead");
  });

  it("keeps the decline's question in the message box when the chat opens again over an earlier accepted message", async () => {
    conversation = { ...conversation, activity: { state: "waiting" }, approvals: [scoped] };
    vi.mocked(write).mockImplementation(async <T>(path: string, body: unknown) =>
      (path.endsWith("/messages") || path.endsWith("/steer") ? { requestId: (body as { requestId: string }).requestId, status: "accepted" } : {}) as T);
    await render();
    await typeInto(textarea(), "Before the approval");
    await act(async () => labelled("Send guidance").click());
    await waitForUi(() => expect(textarea().value).toBe(""));
    await act(async () => buttonText("Decline")!.click());
    await act(async () => root.unmount());
    ({ container, root } = mountRoot());
    await render();
    await waitForUi(() => expect(textarea().placeholder).toBe("Tell Shared what to do instead"));
  });

  it("ends the decline's question once a lost send turns out accepted", async () => {
    conversation = { ...conversation, activity: { state: "waiting" }, approvals: [scoped] };
    vi.mocked(write).mockImplementation(async <T>(path: string) => {
      if (path.endsWith("/steer") || path.endsWith("/messages")) throw new TypeError("Failed to fetch");
      return {} as T;
    });
    const previous = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string, ...rest: unknown[]) => path.startsWith("/submissions/")
      ? { requestId: path.split("/")[2], status: "accepted" } as T : previous(path, ...rest as []) as T);
    await render();
    await act(async () => buttonText("Decline")!.click());
    conversation = { ...conversation, activity: { state: "thinking" }, approvals: [] };
    await changed();
    await typeInto(textarea(), "Only the cache folder");
    await act(async () => labelled("Send guidance").click());
    // The response was lost; the receipt check learns Hermes accepted it.
    await waitForUi(() => expect(container.querySelector(".approval-card")).toBeNull(), 20_000);
    expect(textarea().placeholder).not.toBe("Tell Shared what to do instead");
  });

  it("tags and pre-selects the recommended answer for one choice, sends its raw text, and never pre-selects several", async () => {
    conversation = { ...conversation, activity: { state: "blocked" }, attention: [{ id: "ask", kind: "clarify", title: "Supplies", detail: "", questions: [
      { id: "feed", prompt: "Which feed?", options: ["Hay (Recommended)", "Pellets"], recommended: 0 },
      { id: "extras", prompt: "Anything else?", options: ["Water (Recommended)", "Salt"], multiple: true, recommended: 0 },
    ] }] };
    await render();
    const card = container.querySelector<HTMLElement>('[data-attention-id="ask"]')!;
    const first = card.querySelector<HTMLElement>('[data-question="0"]')!;
    expect(first.querySelector("input:checked")?.closest("label")?.querySelector(".option-label")?.textContent).toBe("Hay");
    expect(first.querySelector(".option-tag")?.closest("label")?.textContent).toContain("Hay");
    const second = card.querySelector<HTMLElement>('[data-question="1"]')!;
    expect(second.querySelector("input:checked")).toBeNull();
    expect(second.querySelector(".option-tag")?.closest("label")?.querySelector(".option-label")?.textContent).toBe("Water");
    await act(async () => second.querySelector<HTMLInputElement>("input")!.click());
    await act(async () => card.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(write).toHaveBeenCalledWith("/bots/shared/requests/ask", { answers: { feed: "Hay (Recommended)", extras: JSON.stringify(["Water (Recommended)"]) }, answerFormat: "json" });
  });

  it("shows no tag where nothing is recommended", async () => {
    conversation = { ...conversation, attention: [{ id: "ask", kind: "clarify", title: "Pick", detail: "", questions: [
      { id: "pick", prompt: "Which?", options: ["A (Recommended)", "B (Recommended)"] },
    ] }] };
    await render();
    expect(container.querySelector(".option-tag")).toBeNull();
    expect(container.querySelector('[data-question="0"] input:checked')).toBeNull();
    expect([...container.querySelectorAll(".option-label")].map(node => node.textContent)).toEqual(["A (Recommended)", "B (Recommended)", "Write my own answer"]);
  });

  it("says a steered message was added to the current task, and only that one", async () => {
    conversation = { ...conversation, messages: [prompt("start", "Fix the fence"), prompt("guide", "Use the north gate", { steered: true }), answer("a", "Done.")] };
    await render();
    const steered = [...container.querySelectorAll("[data-message-id]")].filter(node => node.querySelector(".message-steered")).map(node => node.getAttribute("data-message-id"));
    expect(steered).toEqual(["guide"]);
    expect(container.querySelector(".message-steered")?.textContent).toBe("Added to the current task");
  });
});

describe("email draft revisions", () => {
  const card = (cards: object[]) => "Here's the draft.\n\n```agent-ui\n" + JSON.stringify({ version: 1, cards }) + "\n```";
  const first = { id: "d1", type: "email", title: "Reply to Sam", to: ["sam@example.com"], subject: "Saturday", body: "See you Saturday at noon." };
  const marks = (root: Element) => [...root.querySelectorAll("ins, del")].map(node => `${node.tagName.toLowerCase()}:${node.textContent}`);
  it("marks what a revision changed, and hides and shows the changes", async () => {
    conversation = { ...conversation, messages: [prompt("q1", "Draft it"), answer("a1", card([first])),
      prompt("q2", "Make it Sunday and copy Kim"), answer("a2", card([{ ...first, id: "d2__revises__d1", to: ["sam@example.com", "kim@example.com"], body: "See you Sunday at noon." }]))] };
    await render();
    const [original, revised] = [...container.querySelectorAll<HTMLElement>(".reply-card-email")];
    // The first draft revises nothing.
    expect(original.querySelector(".email-draft-revision")).toBeNull();
    expect(revised.textContent).toContain("Revises “Reply to Sam”");
    expect(marks(revised)).toEqual(["ins:Added: kim@example.com", "del:Removed: Saturday", "ins:Added: Sunday"]);
    await act(async () => [...revised.querySelectorAll("button")].find(button => button.textContent?.includes("Hide changes"))!.click());
    expect(marks(revised)).toEqual([]);
    expect(revised.querySelector(".email-draft-body")!.textContent).toBe("See you Sunday at noon.");
    await act(async () => [...revised.querySelectorAll("button")].find(button => button.textContent?.includes("Show changes"))!.click());
    expect(marks(revised)).toHaveLength(3);
    // Mail still opens with the new draft, never the marks.
    expect(revised.querySelector<HTMLAnchorElement>("a")!.getAttribute("href")).toContain("Sunday");
  });
  it("links drafts only through revises, never by subject or recipients", async () => {
    conversation = { ...conversation, messages: [prompt("q1", "Draft it"), answer("a1", card([first])),
      prompt("q2", "Again"), answer("a2", card([{ ...first, id: "d2", body: "See you Sunday at noon." }])),
      prompt("q3", "Same again"), answer("a3", card([{ ...first, id: "d3__revises__d2", body: "See you Sunday at noon." }]))] };
    await render();
    const [, unlinked, same] = [...container.querySelectorAll<HTMLElement>(".reply-card-email")];
    expect(unlinked.querySelector(".email-draft-revision")).toBeNull();
    expect(same.textContent).toContain("Same as “Reply to Sam”");
    expect(same.textContent).not.toContain("Hide changes");
  });
});

describe("reply file chips", () => {
  const png = (id: string) => ({ id, name: `${id}.png`, mime: "image/png", url: `/api/files/${id}` });
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  });
  const chips = () => [...container.querySelectorAll<HTMLButtonElement>(".reply-file")];
  const scrolled: string[] = [];
  beforeEach(() => {
    scrolled.length = 0;
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: function(this: Element) { scrolled.push(this.getAttribute("data-file-id") ?? this.tagName); } });
  });
  afterEach(() => { Reflect.deleteProperty(Element.prototype, "scrollIntoView"); });
  it("shows a turn's generated files under its last reply and opens the panel on the one chosen", async () => {
    conversation = { ...conversation, messages: [
      prompt("q1", "Photos please", { files: [png("mine")] }),
      { id: "t1", role: "tool", text: "rendered", files: [png("tool-made"), png("p1"), png("p2"), png("p3"), png("p4"), png("p5")] },
      answer("a1", "Working on it", { files: [png("draft")] }),
      answer("a2", "Here they are", { files: [png("final"), png("p1")] }),
      prompt("q2", "Thanks"), answer("a3", "Anytime"),
    ] };
    await render();
    // Only the turn's last reply carries them; the person's own photo is never one, and neither is a
    // file a reply row already shows as its attachment.
    const group = container.querySelector('[data-message-id="a2"] .reply-files')!;
    expect(container.querySelectorAll(".reply-files")).toHaveLength(1);
    expect([...group.querySelectorAll(".reply-file-name")].map(name => name.textContent)).toEqual(["tool-made.png", "p2.png", "p3.png", "p4.png"]);
    const shownOnce = (name: string) => [...container.querySelectorAll('[data-message-id="a2"] .file-link span, [data-message-id="a2"] .reply-file-name')]
      .filter(node => node.textContent?.trim() === name).length;
    expect([shownOnce("final.png"), shownOnce("p1.png")]).toEqual([1, 1]);
    const more = chips().at(-1)!;
    expect(more.textContent).toBe("+1 more");
    await act(async () => chips()[2].click());
    // The panel loads on first use.
    await waitForUi(() => expect(container.querySelector(".artifacts-dialog")).not.toBeNull(), 5000);
    const dialog = container.querySelector<HTMLDialogElement>(".artifacts-dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('[aria-current="true"]')!.textContent).toContain("p3.png");
    // Its row is scrolled into the list's view, which on a phone shows only the first rows.
    await waitForUi(() => expect(scrolled).toEqual(["p3"]));
    expect(dialog.querySelector(".artifact-detail h3")!.textContent).toBe("p3.png");
    await act(async () => labelled("Close artifacts").click());
    expect(container.querySelector(".artifacts-dialog")).toBeNull();
    // "+N more" opens the whole list on its first file.
    await act(async () => more.click());
    await waitForUi(() => expect(container.querySelector(".artifacts-dialog")).not.toBeNull());
    expect(container.querySelector('.artifacts-dialog [aria-current="true"]')!.textContent).toContain("mine.png");
  });
  it("attributes a window's files from the history before it, as the panel does, and shows none until that is known", async () => {
    const photo = png("photo"), fixed = png("fixed");
    let earlierFiles!: (value: unknown) => void;
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string) => path.startsWith("/bots/shared/files")
      ? new Promise<T>(resolve => { earlierFiles = resolve as (value: unknown) => void; }) : original(path) as Promise<T>);
    // The person shared the photo before the loaded window; the assistant hands it back with a fix.
    conversation = { ...conversation, earlier: 6, earlierFiles: 0, files: [photo, fixed],
      messages: [prompt("q9", "Fix the photo I sent"), { id: "t9", role: "tool", text: "", files: [photo, fixed] }, answer("a9", "Fixed")] } as typeof conversation;
    await render();
    expect(vi.mocked(api).mock.calls.some(([path]) => path === "/bots/shared/files?before=q9")).toBe(true);
    // Not known yet: no chip rather than a Generated one for the person's own photo.
    expect(container.querySelector(".reply-files")).toBeNull();
    await act(async () => earlierFiles({ messages: [{ id: "q2", role: "user", files: [photo] }] }));
    await advance(20);
    expect([...container.querySelectorAll(".reply-file-name")].map(name => name.textContent)).toEqual(["fixed.png"]);
    // The panel, opened from the chip, reads the same history and calls the photo Shared.
    await act(async () => chips()[0].click());
    await waitForUi(() => expect(container.querySelector(".artifacts-dialog")).not.toBeNull(), 5000);
    const sources = Object.fromEntries([...container.querySelectorAll(".artifact-item")].map(item => [item.querySelector("strong")!.textContent, item.querySelector("small")!.textContent!.split(" · ")[0]]));
    expect(sources).toEqual({ "photo.png": "Shared", "fixed.png": "Generated" });
  });
  it("shows no chips for a turn that produced no files or has no reply yet", async () => {
    conversation = { ...conversation, activity: { state: "working", runId: "r" }, messages: [
      prompt("q1", "Hi"), answer("a1", "Hello"),
      prompt("q2", "Make one"), { id: "t1", role: "tool", text: "", files: [png("pending")] },
    ] };
    await render();
    expect(container.querySelector(".reply-files")).toBeNull();
  });
});
