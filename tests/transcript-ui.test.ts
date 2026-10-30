// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { ApiError, api, write } from "../src/client-api";
import { defaultPreferences } from "../src/shared/types";
import type { AttentionRequest, Bootstrap, Conversation, Message } from "../src/shared/types";
import { useConversation } from "../src/app/use-conversation";
import { useTurnRetry } from "../src/app/use-turn-retry";
import { retryRequestId } from "../src/shared/retry-id";
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
  const posted = (count: number) => vi.waitFor(() => expect(messagesWritten()).toHaveLength(count));
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
    await vi.waitFor(() => expect(held.has("/bots/shared/messages")).toBe(true));
    await show("barn");
    expect(hook.busy).toBe(false);
    await act(async () => { void hook.run(hook.message!); });
    await vi.waitFor(() => expect(sent("barn")).toHaveLength(1));
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
    expect(write).toHaveBeenCalledWith("/bots/shared/requests/ask", { answers: { feed: "Pellets", extras: "Water, Treats, fresh greens" } });
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
    expect(write).toHaveBeenCalledWith("/bots/shared/requests/ask", { answers: { name: "North" } });
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
    expect(write).toHaveBeenCalledWith("/bots/shared/requests/ask", { answers: { items: "2 bottles of water\nA warm layer" } });
    await act(async () => container.querySelector<HTMLFormElement>('.attention-card form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(vi.mocked(write).mock.calls.filter(([path]) => path === "/bots/shared/requests/ask")).toHaveLength(1);
    expect(container.querySelector<HTMLButtonElement>('.attention-card button[type="submit"]')?.textContent).toBe("Answers sent");
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
  for (const decision of ["approved", "denied"] as const) {
    it(`retries a failed ${decision} decision, clears the error and prevents another send`, async () => {
      conversation = { ...conversation, approvals: [{ id: "gate", title: "Create the reminder?", detail: "Notify both household members.", status: "pending" }] };
      vi.mocked(write).mockRejectedValueOnce(new Error("Could not send your decision."));
      await render();
      const card = container.querySelector(".approval-card")!;
      const buttons = [...card.querySelectorAll<HTMLButtonElement>("button")];
      const button = buttons[decision === "approved" ? 0 : 1];
      await act(async () => button.click());
      expect(container.querySelector(".notice.error")?.textContent).toContain("Could not send your decision.");
      expect(button.disabled).toBe(false);
      await act(async () => button.click());
      expect(container.querySelector(".notice.error")).toBeNull();
      expect(button.disabled).toBe(true);
      expect(button.textContent).toContain(decision === "approved" ? "Approved" : "Declined");
      expect(card.querySelector('[role="status"]')?.textContent).toBe(decision === "approved" ? "Approval sent." : "Decline sent.");
      expect(card.querySelector(".decision-status.sr-only")).toBeNull();
      await act(async () => button.click());
      const calls = vi.mocked(write).mock.calls.filter(([path]) => path === "/bots/shared/approvals/gate");
      expect(calls).toHaveLength(2);
      expect(calls.map(([, body]) => body)).toEqual([{ decision }, { decision }]);
    });
  }
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
