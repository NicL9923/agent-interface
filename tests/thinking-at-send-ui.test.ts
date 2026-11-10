// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api, ApiError, write } from "../src/client-api";
import { COPY_HANDOFF_MS, ECHO_PATIENCE, SENDING_ROW_MS } from "../src/app/sent-echo";
import { defaultPreferences } from "../src/shared/types";
import type { ActivityState, Bootstrap, Conversation, SubmissionReceipt } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { advance, mountRoot, stubMatchMedia, waitForUi } from "./ui-harness";

// Only the client API is faked. Each fake throws on a call the test did not configure.
vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest({
  ...await original<typeof import("../src/client-api")>(),
  api: vi.fn(), write: vi.fn(), uploadFile: vi.fn(), clearResponseCache: vi.fn(),
}));

const bootstrap: Bootstrap = {
  user: { id: "one", name: "One", email: "one@example.test" },
  household: [],
  preferences: { ...defaultPreferences, startPage: "assistant" },
  bots: [{ id: "shared", name: "Shared", shared: true, model: "test", activity: "idle" }],
  capabilities: Object.fromEntries(["chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration", "tools", "skills",
    "routines", "durableEvents", "idempotency", "imageGeneration", "stop", "portraitGeneration", "avatarMetadata"]
    .map(key => [key, { supported: true }])) as Bootstrap["capabilities"],
  connection: { connected: true },
  csrfToken: "test",
};
const prompt = { id: "u0", role: "user" as const, text: "Check the fence", sender: { id: "one", name: "One" } };
const answer = { id: "a0", role: "assistant" as const, text: "The fence is fine." };
let conversation: Conversation;
/** Assistants in the roster; a test that switches chats adds a second. */
let bots: Bootstrap["bots"];
let readFails = false;
let root: Root;
let container: HTMLElement;
/** The message POST, held until the test answers it. */
let sent: { body: { requestId: string; text: string }; resolve(receipt: Partial<SubmissionReceipt>): void; reject(error: Error): void } | undefined;
/** Receipt checks for a send that ended without one. */
let lookup: (requestId: string) => SubmissionReceipt | Promise<SubmissionReceipt>;
/** Requests no test served. The app swallows some failures, so they are also checked after each test. */
let unexpected: string[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 10, 15));
  vi.clearAllMocks();
  unexpected = [];
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia();
  // jsdom lays out no SVG; the avatar measures its paths.
  Object.assign(SVGElement.prototype, { getTotalLength: () => 100, getPointAtLength: (length: number) => ({ x: length, y: 0 }) });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  history.replaceState(null, "", "/");
  localStorage.clear();
  readFails = false;
  sent = undefined;
  lookup = requestId => { throw new Error(`Unexpected receipt check for ${requestId}`); };
  conversation = { botId: "shared", messages: [prompt, answer], approvals: [], files: [], activity: { state: "idle" } };
  bots = bootstrap.bots;
  vi.mocked(api).mockImplementation(async <T>(path: string) => {
    if (path === "/bootstrap?roster=lean") return { ...bootstrap, bots } as T;
    if (bots.some(bot => bot.id === "corral")) {
      if (path === "/bots/corral/draft") return { text: "", attachments: [], revision: 0 } as T;
      if (path.startsWith("/bots/corral/conversation?")) return { botId: "corral", messages: [], approvals: [], files: [], activity: { state: "idle" } } as T;
      if (path === "/bots/corral/routine-runs") return { runs: [], unavailable: [] } as T;
    }
    if (path === "/bots/shared/draft") return { text: "Feed the horses", attachments: [], revision: 0 } as T;
    if (path.startsWith("/bots/shared/conversation?")) {
      if (readFails) throw new ApiError("Can't reach the app right now.", 503);
      return conversation as T;
    }
    if (path.startsWith("/submissions/")) return await lookup(decodeURIComponent(path.slice("/submissions/".length))) as T;
    if (path === "/bots/shared/routine-runs") return { runs: [], unavailable: [] } as T;
    if (path === "/groups") return { supported: true, canSend: true, rooms: [] } as T;
    unexpected.push(`GET ${path}`);
    throw new Error(`This test serves no GET ${path}`);
  });
  vi.mocked(write).mockImplementation(async <T>(path: string, body?: unknown, method = "POST") => {
    // Presence and device activity report on their own schedule.
    if (method === "PUT" && (/^\/bots\/(shared|corral)\/(presence|read-position)$/.test(path) || path === "/devices/activity")) return {} as T;
    if (path === "/bots/shared/messages") return await new Promise<T>((resolve, reject) => {
      const request = body as { requestId: string; text: string };
      sent = { body: request, resolve: receipt => resolve({ requestId: request.requestId, status: "accepted", runId: "run", ...receipt } as T), reject };
    });
    unexpected.push(`${method} ${path}`);
    throw new Error(`This test serves no ${method} ${path}`);
  });
  ({ container, root } = mountRoot());
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "onLine");
  expect(unexpected).toEqual([]);
});

async function open() {
  await act(async () => root.render(createElement(App)));
  await waitForUi(() => expect(sendButton().disabled).toBe(false));
}
// Send reads "Send guidance" while the assistant works.
const sendButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"], [aria-label="Send guidance"]')!;
/** Sends the draft. The echo starts between the click and the request, so these bracket its start. */
async function send() {
  const clicked = Date.now();
  await act(async () => sendButton().click());
  // The draft's digest settles in real time; the request leaves once it has.
  await waitForUi(() => expect(sent).toBeDefined());
  return { clicked, requested: Date.now() };
}
/** Moves the pinned clock to an absolute time. */
const advanceTo = (time: number) => advance(time - Date.now());
/** Every status node the activity row has mounted, so a second announcement shows as a second node. */
function watchStatusNodes() {
  const nodes: Element[] = [];
  const record = () => {
    const node = row()?.querySelector('[role="status"]');
    if (node && !nodes.includes(node)) nodes.push(node);
  };
  const observer = new MutationObserver(record);
  observer.observe(container, { childList: true, subtree: true });
  record();
  return { nodes, stop: () => observer.disconnect() };
}
/** The sidebar row's activity for the assistant, as its class names it. */
const sidebarState = () => container.querySelector(".bot-activity")?.className.match(/state-(\w+)/)?.[1] ?? null;
/** The activity row under the transcript, and what its status line says. */
const row = () => container.querySelector<HTMLElement>(".conversation-activity");
/** What the row's status says to assistive technology: its text without the parts hidden from it. */
const status = () => {
  const line = row()?.querySelector('[role="status"]')?.cloneNode(true) as HTMLElement | undefined;
  line?.querySelectorAll('[aria-hidden="true"]').forEach(hidden => hidden.remove());
  return line?.textContent ?? null;
};
const echo = () => [...container.querySelectorAll<HTMLElement>(".message-user")].find(item => item.textContent?.includes("Feed the horses"));
/** Hermes reports a change to the conversation, and the chat reads it. */
async function report(next: Partial<Conversation> & { state?: ActivityState }) {
  const { state, ...rest } = next;
  conversation = { ...conversation, ...rest, ...state ? { activity: { state, runId: "run" } } : {} };
  await act(async () => FakeEventSource.notifyAll());
  await advance(1500);
}
const notice = (label: string) => [...container.querySelectorAll<HTMLButtonElement>(".notice button")].find(button => button.textContent?.trim() === label)!;
const copy = () => ({ id: "u1", role: "user" as const, text: "Feed the horses", sender: { id: "one", name: "One" } });

describe("the assistant's thinking row from the moment a message is sent", () => {
  it("appears with the echo and becomes Hermes's own row, in the same node, without a second announcement", async () => {
    await open();
    expect(row()).toBeNull();
    await send();
    expect(echo()).toBeDefined();
    const early = row();
    expect(status()).toBe("Shared is thinking...");
    const line = early!.querySelector('[role="status"]');
    await act(async () => sent!.resolve({}));
    expect(row()).toBe(early);
    await report({ state: "thinking", messages: [prompt, answer, copy()] });
    expect(row()).toBe(early);
    // The status node and its words are the same, so a screen reader hears "thinking" once.
    expect(row()!.querySelector('[role="status"]')).toBe(line);
    expect(status()).toBe("Shared is thinking...");
    await report({ state: "working" });
    expect(row()).toBe(early);
    expect(status()).toBe("Shared is working...");
    await report({ state: "done", messages: [prompt, answer, copy(), { id: "a1", role: "assistant", text: "Fed." }] });
    expect(row()).toBeNull();
  });

  // Stop acts on what Hermes runs. Offered on the early row, a stop could reach Hermes before the turn does and miss it.
  it("offers Stop only once Hermes reports the turn", async () => {
    await open();
    await send();
    await act(async () => sent!.resolve({}));
    expect(container.querySelector("textarea")!.value).toBe("");
    expect(status()).toBe("Shared is thinking...");
    expect(container.querySelector('[aria-label="Stop response"]')).toBeNull();
    await report({ state: "thinking", messages: [prompt, answer, copy()] });
    expect(container.querySelector('[aria-label="Stop response"]')).not.toBeNull();
  });

  // Each send that will not start a turn ends with no row, and nothing left of the early one.
  it("goes when Hermes refuses the message", async () => {
    await open();
    await send();
    expect(status()).toBe("Shared is thinking...");
    await act(async () => sent!.resolve({ status: "rejected", message: "Hermes is finishing the preceding task." }));
    expect(row()).toBeNull();
    expect(echo()).toBeUndefined();
  });

  it("goes when the app refuses the send", async () => {
    await open();
    await send();
    await act(async () => sent!.reject(new ApiError("Message cannot be empty", 400)));
    expect(row()).toBeNull();
    expect(echo()).toBeUndefined();
  });

  it("goes when the send fails without an answer, comes back with its retry, and goes for good once the person gives it up", async () => {
    await open();
    await send();
    lookup = () => new Promise(() => {});
    await act(async () => sent!.reject(new ApiError("Hermes is unavailable.", 503)));
    // The message waits, unconfirmed, and the chat does not claim the assistant is on it.
    expect(echo()?.textContent).toContain("Not confirmed yet");
    expect(row()).toBeNull();
    const first = sent!;
    sent = undefined;
    await act(async () => notice("Retry this saved message").click());
    await waitForUi(() => expect(sent?.body.requestId).toBe(first.body.requestId));
    expect(status()).toBe("Shared is thinking...");
    await act(async () => sent!.reject(new ApiError("Hermes is unavailable.", 503)));
    expect(row()).toBeNull();
    await act(async () => notice("Discard").click());
    await act(async () => notice("Discard and keep my text in the draft").click());
    expect(echo()).toBeUndefined();
    expect(row()).toBeNull();
    expect(container.querySelector("textarea")!.value).toBe("Feed the horses");
  });

  it("goes when Hermes's answer is uncertain", async () => {
    await open();
    await send();
    lookup = () => new Promise(() => {});
    await act(async () => sent!.resolve({ status: "uncertain" }));
    expect(echo()).toBeDefined();
    expect(row()).toBeNull();
  });

  it("never adds a row for guidance sent while the assistant works, before or after the task ends", async () => {
    conversation = { ...conversation, activity: { state: "working", runId: "run" } };
    await open();
    const working = row();
    expect(status()).toBe("Shared is working...");
    await send();
    expect(container.querySelectorAll(".conversation-activity")).toHaveLength(1);
    expect(row()).toBe(working);
    // The task ends before Hermes answers: the guidance was sent into work, so nothing claims a new turn.
    await report({ state: "done" });
    expect(row()).toBeNull();
    await act(async () => sent!.resolve({ steered: true }));
    expect(row()).toBeNull();
  });

  it("hands a message Hermes queued behind another task to that task's row, and leaves none after it", async () => {
    await open();
    await send();
    const early = row();
    // Another client's task was already starting; Hermes queues this message behind it.
    await report({ state: "working" });
    await act(async () => sent!.resolve({ steered: false }));
    expect(row()).toBe(early);
    expect(status()).toBe("Shared is working...");
    await report({ state: "done", messages: [prompt, answer, { id: "a1", role: "assistant", text: "Other task done." }] });
    // The queued message's own turn has shown work already, so the chat waits for Hermes to report it.
    expect(row()).toBeNull();
  });

  // A healthy admission answers in well under a second. Past the bound the request is in trouble, and the
  // message's own "Sending…" says so without the chat claiming the assistant is on it, as main does.
  it("leaves a send whose request has not answered to its Sending… state once the bound passes, and shows the row again when Hermes accepts it", async () => {
    await open();
    const { clicked, requested } = await send();
    expect(status()).toBe("Shared is thinking...");
    expect(sidebarState()).toBe("thinking");
    const early = row();
    await advanceTo(clicked + SENDING_ROW_MS - 1);
    expect(row()).toBe(early);
    expect(echo()?.textContent).toContain("Sending…");
    await advanceTo(requested + SENDING_ROW_MS);
    expect(row()).toBeNull();
    expect(sidebarState()).toBeNull();
    expect(echo()?.textContent).toContain("Sending…");
    await act(async () => sent!.resolve({}));
    expect(status()).toBe("Shared is thinking...");
    expect(echo()?.textContent).not.toContain("Sending…");
  });

  // Hermes's saved copy can arrive in one read and the turn's report in the next.
  it("keeps one row and one announcement when Hermes's copy arrives before the turn's report", async () => {
    await open();
    await send();
    const watch = watchStatusNodes();
    await act(async () => sent!.resolve({}));
    const early = row();
    await report({ messages: [prompt, answer, copy()] });
    expect(row()).toBe(early);
    expect(status()).toBe("Shared is thinking...");
    await report({ state: "thinking" });
    expect(row()).toBe(early);
    expect(status()).toBe("Shared is thinking...");
    watch.stop();
    expect(watch.nodes).toHaveLength(1);
  });

  it("drops the row a bounded time after Hermes's copy arrives when no turn follows", async () => {
    await open();
    await send();
    await act(async () => sent!.resolve({}));
    // The chat reads the copy within report()'s 1.5 s, so these bracket its arrival.
    const notified = Date.now();
    await report({ messages: [prompt, answer, copy()] });
    const read = Date.now();
    await advanceTo(notified + COPY_HANDOFF_MS - 1);
    expect(status()).toBe("Shared is thinking...");
    await advanceTo(read + COPY_HANDOFF_MS);
    expect(row()).toBeNull();
    expect(echo()).toBeDefined();
  });

  it("drops the row at once when Hermes's copy arrives with the turn's reply already after it", async () => {
    await open();
    await send();
    await act(async () => sent!.resolve({}));
    await report({ messages: [prompt, answer, copy(), { id: "a1", role: "assistant", text: "Fed." }] });
    expect(row()).toBeNull();
  });

  it("shows the chat disconnected, not thinking, when the connection drops while a message is on its way", async () => {
    await open();
    await send();
    expect(status()).toBe("Shared is thinking...");
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    await act(async () => { window.dispatchEvent(new Event("offline")); });
    expect(row()?.className).toContain("state-disconnected");
    expect(status()).toBeNull();
  });

  it("goes after the echo's patience when an accepted message never starts a turn, as a typed stop phrase does from an older add-on", async () => {
    await open();
    await send();
    await act(async () => sent!.resolve({}));
    expect(status()).toBe("Shared is thinking...");
    await advance(ECHO_PATIENCE + 200);
    expect(row()).toBeNull();
    expect(echo()).toBeUndefined();
  });

  it("goes at once, with the message, when Hermes says a typed stop phrase admitted nothing, and says why", async () => {
    await open();
    await send();
    expect(status()).toBe("Shared is thinking...");
    await act(async () => sent!.resolve({ turn: "none", message: "Hermes ended its voice chat. Nothing was sent to the assistant." }));
    expect(row()).toBeNull();
    expect(echo()).toBeUndefined();
    expect(container.querySelector(".composer-area [role='status']")?.textContent).toBe("Hermes ended its voice chat. Nothing was sent to the assistant.");
  });

  it("adds no row once Hermes says it put the message into the running turn", async () => {
    await open();
    await send();
    await act(async () => sent!.resolve({ steered: false, turn: "joined" }));
    expect(row()).toBeNull();
    expect(echo()).toBeDefined();
    expect(echo()!.textContent).not.toContain("Added to the current task");
  });

  it("refuses a send during a failed read, so no row appears", async () => {
    await open();
    readFails = true;
    await act(async () => FakeEventSource.notifyAll());
    await advance(1500);
    await act(async () => sendButton().click());
    await advance(100);
    expect(sent).toBeUndefined();
    expect(row()).toBeNull();
  });

  it("steps a failed turn's Retry aside while the new message starts, and brings it back when the message is refused", async () => {
    conversation = { ...conversation, messages: [answer, prompt], activity: { state: "failed", runId: "old" } };
    await open();
    const retry = () => [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Retry");
    expect(status()).toBe("Shared couldn't finish.");
    expect(retry()).toBeDefined();
    await send();
    expect(status()).toBe("Shared is thinking...");
    expect(retry()).toBeUndefined();
    await act(async () => sent!.resolve({ status: "rejected", message: "Hermes is finishing the preceding task." }));
    expect(status()).toBe("Shared couldn't finish.");
    expect(retry()).toBeDefined();
  });

  it("keeps a failed turn's Retry away once Hermes accepts the new message, through its own report", async () => {
    conversation = { ...conversation, messages: [answer, prompt], activity: { state: "failed", runId: "old" } };
    await open();
    await send();
    await act(async () => sent!.resolve({}));
    expect(status()).toBe("Shared is thinking...");
    expect([...container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Retry")).toBe(false);
    await report({ state: "thinking", messages: [answer, prompt, copy()] });
    expect(status()).toBe("Shared is thinking...");
    expect([...container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Retry")).toBe(false);
  });
  // A turn can end before the chat ever reads it running. The read that brings the copy may still report the turn
  // before, so the row stays through it, and the turn's own outcome replaces it from the next read.
  it.each<[string, "failed" | "interrupted" | "done", (shown: HTMLElement | null) => void]>([
    ["failed, with its Retry", "failed", shown => {
      expect(shown?.textContent).toContain("Shared couldn't finish.");
      expect([...shown!.querySelectorAll("button")].some(button => button.textContent?.trim() === "Retry")).toBe(true);
    }],
    ["interrupted", "interrupted", shown => expect(shown?.textContent).toContain("Shared's task was interrupted.")],
    ["finished", "done", shown => expect(shown).toBeNull()],
  ])("keeps thinking, without Retry, through a %s report in the read that brings the copy, and shows it from the next read", async (_, state, check) => {
    conversation = { ...conversation, version: "boot:0:4" };
    await open();
    await send();
    await act(async () => sent!.resolve({}));
    expect(status()).toBe("Shared is thinking...");
    // A settled turn's report carries no run ID, as Hermes reports one. The chat showed an idle assistant at the send,
    // so this outcome differs from it, and it can still be the last turn's.
    await report({ messages: [prompt, answer, copy()], activity: { state }, version: "boot:0:5" });
    expect(status()).toBe("Shared is thinking...");
    expect([...container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Retry")).toBe(false);
    await report({ version: "boot:0:6" });
    check(row());
  });

  it("keeps thinking through the last turn's failure in the read that brings the copy, and shows this turn's failure from a later read", async () => {
    conversation = { ...conversation, messages: [answer, prompt], activity: { state: "failed" }, version: "boot:0:4" };
    await open();
    const retry = () => [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Retry");
    expect(status()).toBe("Shared couldn't finish.");
    expect(retry()).toBeDefined();
    await send();
    const watch = watchStatusNodes();
    await act(async () => sent!.resolve({}));
    // Hermes saved the message but had not opened its run when this read began, so the failure is the last turn's.
    await report({ messages: [answer, prompt, copy()], version: "boot:0:5" });
    expect(status()).toBe("Shared is thinking...");
    expect(retry()).toBeUndefined();
    await report({ version: "boot:0:6" });
    expect(row()?.textContent).toContain("Shared couldn't finish.");
    expect(retry()).toBeDefined();
    watch.stop();
    expect(watch.nodes).toHaveLength(1);
  });

  // Two reads asked while Hermes admits the message both report the last turn's failure, the second ordered after the
  // first. Hermes's answer says the turn started, at the version it reached the server, so neither ends the row.
  it("keeps thinking through the last turn's failure in every read asked during a started turn's admission, and shows this turn's from the first read after", async () => {
    conversation = { ...conversation, messages: [answer, prompt], activity: { state: "failed" }, version: "boot:0:4" };
    await open();
    const retry = () => [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Retry");
    await send();
    const watch = watchStatusNodes();
    await act(async () => sent!.resolve({ turn: "started", admittedVersion: "boot:0:7" }));
    await report({ messages: [answer, prompt, copy()], version: "boot:0:5" });
    expect(status()).toBe("Shared is thinking...");
    await report({ version: "boot:0:6" });
    expect(status()).toBe("Shared is thinking...");
    expect(retry()).toBeUndefined();
    await report({ version: "boot:0:8" });
    expect(row()?.textContent).toContain("Shared couldn't finish.");
    expect(retry()).toBeDefined();
    watch.stop();
    expect(watch.nodes).toHaveLength(1);
  });

  it("shows a started turn's failure at once when the read that brings the copy was asked after its admission", async () => {
    conversation = { ...conversation, version: "boot:0:4" };
    await open();
    await send();
    await act(async () => sent!.resolve({ turn: "started", admittedVersion: "boot:0:7" }));
    await report({ messages: [prompt, answer, copy()], activity: { state: "failed" }, version: "boot:0:8" });
    expect(row()?.textContent).toContain("Shared couldn't finish.");
    expect([...container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Retry")).toBe(true);
  });

  it("never paints thinking on returning to the chat after the handoff bound passed in another chat", async () => {
    bots = [...bootstrap.bots, { id: "corral", name: "Corral", shared: true, model: "test", activity: "idle" }];
    await open();
    await send();
    await act(async () => sent!.resolve({}));
    await report({ messages: [prompt, answer, copy()] });
    expect(status()).toBe("Shared is thinking...");
    const choose = (name: string) => act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>(".bot-row")].find(button => button.textContent?.includes(name))!.click());
    const current = () => container.querySelector(".bot-row[aria-current='page']")?.textContent;
    await choose("Corral");
    await waitForUi(() => expect(current()).toContain("Corral"));
    await waitForUi(() => expect(vi.mocked(api).mock.calls.some(([path]) => path.startsWith("/bots/corral/conversation?"))).toBe(true));
    await advance(COPY_HANDOFF_MS + 1000);
    // Every status line drawn from the moment the person comes back, whether or not it stays.
    const drawn: string[] = [];
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        for (const line of [node, ...node.querySelectorAll("*")].filter(item => item.getAttribute("role") === "status")) drawn.push(line.textContent ?? "");
      }
    });
    observer.observe(container, { childList: true, subtree: true });
    await choose("Shared");
    await waitForUi(() => expect(current()).toContain("Shared"));
    await waitForUi(() => expect(echo()).toBeDefined());
    observer.disconnect();
    expect(drawn.filter(line => line.includes("thinking"))).toEqual([]);
    expect(row()).toBeNull();
  });
});
