// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { clearResponseCache } from "../src/client-api";
import { CATCH_UP_MS } from "../src/components/streaming-reveal";
import { defaultPreferences, type Bootstrap, type Conversation, type Inflight, type InflightDelta, type Message, type ToolCall, type TurnEvent } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { advance, mountRoot, stubMatchMedia } from "./ui-harness";
import type { Mount } from "./ui-harness";

// The app runs whole, through the real client API, against a fake server at fetch and a fake
// event stream. A request the test did not configure is refused, and the test fails on it.
const NOW = Date.UTC(2026, 10, 10, 15);
const bootstrap: Bootstrap = {
  user: { id: "one", name: "One", email: "one@example.test" },
  household: [],
  preferences: { ...defaultPreferences, startPage: "assistant", defaultBotId: "home" },
  bots: [{ id: "home", name: "Home", shared: true, model: "test", activity: "idle" }],
  capabilities: Object.fromEntries(["chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration", "tools", "skills",
    "routines", "durableEvents", "idempotency", "stop"].map(key => [key, { supported: true }])) as Bootstrap["capabilities"],
  connection: { connected: true },
  csrfToken: "csrf",
};
const question: Message = { id: "u1", role: "user", text: "Is the north gate latched?", sender: { id: "one", name: "One" }, createdAt: "2026-11-10T14:59:00Z" };
const running = { state: "working", runId: "run-1" } as const;
let server: Conversation;
// Reads and turn events carry a structural version, `boot:epoch:generation`, as the server sends them.
let generation: number;
const version = () => `boot:0:${generation}`;
let unexpected: string[];
let mount: Mount;
const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  clearResponseCache();
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia(false);
  // Browser APIs jsdom lacks, which the real Avatar uses.
  Object.assign(SVGElement.prototype, { getTotalLength: () => 100, getPointAtLength: (length: number) => ({ x: length, y: 0 }) });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  // jsdom has no layout. The Quote button measures a selection in a reply.
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  unexpected = [];
  generation = 1;
  server = { botId: "home", messages: [question], approvals: [], files: [], activity: running, version: version() };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, location.origin);
    const call = `${init.method ?? "GET"} ${url.pathname.replace(/^\/api/, "")}`;
    if (call === "GET /bootstrap") return respond(bootstrap);
    if (call === "GET /bots/home/conversation") return respond(server);
    const empty: Record<string, unknown> = {
      "GET /auth/config": { localDevAuth: true },
      "GET /groups": { supported: false, canSend: false, rooms: [], reason: "Not in this test." },
      "GET /usage/accounts": { accounts: [], unavailableBots: [] },
      "GET /mac/devices": { available: false, reason: "Not in this test.", devices: [] },
      "GET /bots/home/draft": null,
      "GET /bots/home/routine-runs": { runs: [], unavailable: [] },
    };
    if (call in empty) return respond(empty[call]);
    if (/^PUT \/(bots\/[^/]+\/(presence|read-position)|devices\/activity)$/.test(call)) return respond({});
    unexpected.push(call);
    throw new TypeError(`Unexpected request ${call}`);
  }));
  mount = mountRoot();
});
afterEach(() => { expect(unexpected).toEqual([]); });

const stream = () => [...FakeEventSource.streams].find(item => item.url.startsWith("/api/bots/home/events"))!;
async function open() {
  history.replaceState(null, "", "/?bot=home");
  await act(async () => mount.root.render(createElement(App)));
  await advance(0);
  await act(async () => stream().connect());
  await advance(0);
}
const live = (text: string): Inflight => ({ botId: "home", message: { id: "s1-inflight", role: "assistant", text }, activity: running, toolCalls: [] });
async function send(type: "inflight" | "inflight-delta" | "turn", value: Inflight | InflightDelta | TurnEvent) {
  await act(async () => stream().emit(type, JSON.stringify(value)));
}
/** The next read has these rows after the question, and the stream says something changed. */
async function save(messages: Message[], activity: Conversation["activity"] = { state: "idle" }) {
  generation++;
  server = { ...server, messages: [question, ...messages], activity, version: version() };
  await act(async () => stream().emit("message", "change"));
  await advance(0);
}
/**
 * A change to the running turn's structure as a `?inflight=3` stream sends it: the turn's saved rows
 * after the question, and its live reply, from one read at a newer version.
 */
async function turn(messages: Message[], text: string, activity: Conversation["activity"] = running) {
  generation++;
  server = { ...server, messages: [question, ...messages], activity, version: version() };
  await send("turn", { botId: "home", message: { id: "s1-inflight", role: "assistant", text }, activity, toolCalls: [], version: version(),
    messages, after: question.id });
}
const row = (id: string) => mount.container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
const replyText = (id: string) => row(id)?.querySelector(".message-markdown")?.textContent;

describe("a live reply in the transcript", () => {
  it("is revealed at a steady pace with a caret, and shows whole with no caret the moment it is saved", async () => {
    await open();
    await send("inflight", live("The north gate"));
    expect(replyText("s1-inflight")).toBe("The north gate");
    expect(row("s1-inflight")?.querySelector(".streaming-caret")?.getAttribute("aria-hidden")).toBe("true");
    const rest = " is latched, and the chain is through the second post where the mare cannot reach it.";
    await send("inflight-delta", { botId: "home", messageId: "s1-inflight", baseTextLength: 14, baseReasoningLength: 0, appendText: rest, activity: running });
    await advance(CATCH_UP_MS / 3);
    const partial = replyText("s1-inflight")!;
    expect(partial.length).toBeGreaterThan("The north gate".length);
    expect(partial.length).toBeLessThan(`The north gate${rest}`.length);
    // Saved before the reveal caught up: the whole reply shows at once, with no caret and no pacing.
    await save([{ id: "m2", role: "assistant", text: `The north gate${rest}`, createdAt: "2026-11-10T15:00:00Z" }]);
    expect(row("s1-inflight")).toBeNull();
    expect(replyText("m2")).toBe(`The north gate${rest}`);
    expect(mount.container.querySelector(".streaming-caret")).toBeNull();
  });
});

const saved = (id: string, text: string): Message => ({ id, role: "assistant", text, runId: "run-1", createdAt: "2026-11-10T15:00:00Z" });
const toolRow = (status: ToolCall["status"]): Message => ({ id: "t1", role: "tool", text: "", runId: "run-1", createdAt: "2026-11-10T14:59:30Z",
  toolCall: { id: "call-1", name: "terminal", status, startedAt: "2026-11-10T14:59:30Z" } });
const meta = (element: Element) => element.querySelector(".message-meta");

describe("a live reply's row when it is saved", () => {
  it("keeps the reply's nodes and a selection in it, takes the saved ID, and reveals its meta row in the place it held", async () => {
    await open();
    await send("inflight", live("The north gate is latched."));
    const live1 = row("s1-inflight")!, body = live1.querySelector(".message-markdown")!;
    // The meta row already takes its place, hidden from people and assistive technology.
    const held = meta(live1)!;
    expect(held.getAttribute("aria-hidden")).toBe("true");
    expect(held.hasAttribute("inert")).toBe(true);
    const words = body.querySelector("p")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(words, 4);
    range.setEnd(words, 14);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    expect(document.getSelection()!.toString()).toBe("north gate");

    await save([saved("m2", "The north gate is latched.")]);
    expect(row("m2")).toBe(live1);
    expect(live1.dataset.messageId).toBe("m2");
    expect(row("m2")!.querySelector(".message-markdown")).toBe(body);
    expect(document.getSelection()!.toString()).toBe("north gate");
    expect(meta(live1)).toBe(held);
    expect(held.hasAttribute("inert")).toBe(false);
    expect(held.querySelector('button[aria-label="Copy reply"]')).not.toBeNull();
  });

  it("gives the saved copy of the last segment the live node, and keeps an earlier segment in its own", async () => {
    server = { ...server, messages: [question, saved("m2", "Checking the gate log."), toolRow("completed")] };
    await open();
    await send("inflight", live("The north gate is latched."));
    const first = row("m2")!, last = row("s1-inflight")!;
    expect(last).not.toBe(first);
    // The turn ends with a turn event that saves the last segment.
    await turn([saved("m2", "Checking the gate log."), toolRow("completed"), saved("m3", "The north gate is latched.")], "", { state: "idle" });
    expect(row("s1-inflight")).toBeNull();
    expect(row("m2")).toBe(first);
    expect(row("m3")).toBe(last);
    expect(replyText("m2")).toBe("Checking the gate log.");
    expect(replyText("m3")).toBe("The north gate is latched.");
  });

  it("hands the live node to the segment a tool call saves, and starts the next live reply in a new node", async () => {
    await open();
    await send("inflight", live("Checking the gate log."));
    const segment = row("s1-inflight")!;
    // Hermes saves the reply so far when a tool starts; the turn is still running, its live reply empty.
    await turn([saved("m2", "Checking the gate log."), toolRow("running")], "");
    expect(row("m2")).toBe(segment);
    expect(row("s1-inflight")).toBeNull();
    // Text resumes after the tool as growth of the turn event's empty live reply.
    await send("inflight-delta", { botId: "home", messageId: "s1-inflight", baseTextLength: 0, baseReasoningLength: 0,
      appendText: "The north gate is latched.", activity: running });
    const next = row("s1-inflight")!;
    expect(next).not.toBe(segment);
    expect(row("m2")).toBe(segment);
    expect(replyText("m2")).toBe("Checking the gate log.");
    expect(replyText("s1-inflight")).toBe("The north gate is latched.");
  });

  it("removes the live row when the reply ends with nothing saved", async () => {
    await open();
    await send("inflight", live("Let me look"));
    await save([]);
    expect(mount.container.querySelector(".message-assistant")).toBeNull();
    expect(mount.container.querySelector(".streaming-caret")).toBeNull();
  });

  it("keeps the node when a failed turn saves the reply so far, showing its raw text and its meta row", async () => {
    await open();
    await send("inflight", live("Checking the **north"));
    const partial = row("s1-inflight")!;
    // Live, the unfinished bold is held back.
    expect(replyText("s1-inflight")).toBe("Checking the");
    await save([saved("m2", "Checking the **north")], { state: "failed" });
    expect(row("m2")).toBe(partial);
    // Saved, the reply shows as written, with no hold-back.
    expect(replyText("m2")).toBe("Checking the **north");
    expect(meta(partial)!.hasAttribute("inert")).toBe(false);
    expect(mount.container.querySelector(".streaming-caret")).toBeNull();
  });
});
