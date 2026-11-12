// @vitest-environment jsdom
import { StrictMode, act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { clearResponseCache } from "../src/client-api";
import { CATCH_UP_MS } from "../src/components/streaming-reveal";
import { defaultPreferences, type Bootstrap, type Conversation, type Inflight, type InflightDelta, type Message, type ToolCall, type TurnEvent } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { advance, mountRoot, stubMatchMedia, waitForUi } from "./ui-harness";
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
// The replies saved with "Save reply", and the messages a Retry named, by ID.
let saves: string[] = [], retries: string[] = [];
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
  saves = [];
  retries = [];
  generation = 1;
  server = { botId: "home", messages: [question], approvals: [], files: [], activity: running, version: version() };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, location.origin);
    const call = `${init.method ?? "GET"} ${url.pathname.replace(/^\/api/, "")}`;
    if (call === "GET /bootstrap") return respond(bootstrap);
    if (call === "GET /bots/home/conversation") {
      // A page before a message holds only what comes before it, as the server answers it.
      const before = url.searchParams.get("before"), at = before ? server.messages.findIndex(message => message.id === before) : -1;
      return respond(at >= 0 ? { ...server, messages: server.messages.slice(0, at), earlier: 0, before } : server);
    }
    const empty: Record<string, unknown> = {
      "GET /auth/config": { localDevAuth: true },
      "GET /groups": { supported: false, canSend: false, rooms: [], reason: "Not in this test." },
      "GET /usage/accounts": { accounts: [], unavailableBots: [] },
      "GET /mac/devices": { available: false, reason: "Not in this test.", devices: [] },
      "GET /bots/home/draft": null,
      "GET /bots/home/routine-runs": { runs: [], unavailable: [] },
    };
    if (call in empty) return respond(empty[call]);
    if (call === "POST /saved") { saves.push((JSON.parse(String(init.body)) as { messageId: string }).messageId); return respond({}); }
    if (call === "POST /bots/home/messages") {
      const body = JSON.parse(String(init.body)) as { requestId: string; retryOf?: string };
      if (body.retryOf) retries.push(body.retryOf);
      return respond({ requestId: body.requestId, status: "accepted", runId: "run-2" });
    }
    if (/^PUT \/(bots\/[^/]+\/(presence|read-position)|devices\/activity)$/.test(call)) return respond({});
    unexpected.push(call);
    throw new TypeError(`Unexpected request ${call}`);
  }));
  mount = mountRoot();
});
afterEach(() => { expect(unexpected).toEqual([]); });

const stream = () => [...FakeEventSource.streams].find(item => item.url.startsWith("/api/bots/home/events"))!;
/** Opens the chat, under StrictMode as the app's entry renders it when `strict`, so renders and effects run twice. */
async function open(strict = false) {
  history.replaceState(null, "", "/?bot=home");
  await act(async () => mount.root.render(strict ? createElement(StrictMode, null, createElement(App)) : createElement(App)));
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
/** Selects characters of a row's first paragraph, as a person dragging over the reply would. */
function select(element: Element, from: number, to: number) {
  const words = element.querySelector(".message-markdown p")!.firstChild as Text;
  const range = document.createRange();
  range.setStart(words, from);
  range.setEnd(words, to);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
}

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

  it.each(["failed", "interrupted"] as const)("keeps the node when a turn ends %s, as a stopped one does, with the reply so far saved, showing its raw text and its meta row", async state => {
    await open();
    await send("inflight", live("Checking the **north"));
    const partial = row("s1-inflight")!;
    // Live, the unfinished bold is held back.
    expect(replyText("s1-inflight")).toBe("Checking the");
    await save([saved("m2", "Checking the **north")], { state });
    expect(row("m2")).toBe(partial);
    // Saved, the reply shows as written, with no hold-back.
    expect(replyText("m2")).toBe("Checking the **north");
    expect(meta(partial)!.hasAttribute("inert")).toBe(false);
    expect(mount.container.querySelector(".streaming-caret")).toBeNull();
  });

  it("never hands the live node to a progress line saved before the final reply, and rebuilds the reply as main does", async () => {
    server = { ...server, messages: [question, saved("m2", "First segment."), toolRow("completed")] };
    await open();
    await send("inflight", live("Second live."));
    const first = row("m2")!, liveNode = row("s1-inflight")!;
    select(liveNode, 0, 6);
    expect(document.getSelection()!.toString()).toBe("Second");
    // Two rows appear where the live one was, so neither may claim its node.
    await save([saved("m2", "First segment."), toolRow("completed"), { ...saved("p1", "Checking the gate."), interim: true }, saved("m3", "Second live.")]);
    expect(row("p1")).not.toBe(liveNode);
    expect(row("m3")).not.toBe(liveNode);
    expect(liveNode.isConnected).toBe(false);
    expect(row("m2")).toBe(first);
    // The selection went with the node, rather than moving to another message's text.
    expect(document.getSelection()!.toString()).toBe("");
    expect(replyText("p1")).toBe("Checking the gate.");
    expect(replyText("m3")).toBe("Second live.");
  });

  it("keeps each reply's own node and actions when redaction hides an earlier reply", async () => {
    server = { ...server, sessionId: "session-1", activity: { state: "idle" }, messages: [question, saved("m2", "The gate is latched."), saved("m3", "The trough is full.")] };
    saves = [];
    await open();
    const second = row("m3")!;
    await act(async () => row("m2")!.querySelector<HTMLButtonElement>('button[aria-label="Save reply"]')!.click());
    // Saving loads the reply titler first, which takes real time.
    await waitForUi(() => expect(row("m2")!.querySelector('button[aria-label="Reply saved"]')).not.toBeNull());
    expect(saves).toEqual(["m2"]);
    // The first reply turns out to be another member's private assistant, and becomes a hidden activity row.
    await save([{ ...saved("m2", "Message from another member's assistant: This message is private."), origin: { kind: "agent", visibility: "activity" } }, saved("m3", "The trough is full.")]);
    expect(row("m2")).toBeNull();
    expect(row("m3")).toBe(second);
    expect(row("m3")!.querySelector('button[aria-label="Save reply"]')).not.toBeNull();
    expect(row("m3")!.querySelector('button[aria-label="Reply saved"]')).toBeNull();
  });

  it("hands each live node to its own saved segment across several segments", async () => {
    await open();
    await send("inflight", live("Checking the gate log."));
    const one = row("s1-inflight")!;
    await turn([saved("m2", "Checking the gate log."), toolRow("running")], "");
    await send("inflight-delta", { botId: "home", messageId: "s1-inflight", baseTextLength: 0, baseReasoningLength: 0, appendText: "Now the trough.", activity: running });
    const two = row("s1-inflight")!;
    await turn([saved("m2", "Checking the gate log."), toolRow("running"), saved("m3", "Now the trough."), { ...toolRow("running"), id: "t2" }], "");
    await send("inflight-delta", { botId: "home", messageId: "s1-inflight", baseTextLength: 0, baseReasoningLength: 0, appendText: "All latched.", activity: running });
    const three = row("s1-inflight")!;
    await turn([saved("m2", "Checking the gate log."), toolRow("completed"), saved("m3", "Now the trough."), { ...toolRow("completed"), id: "t2" },
      saved("m4", "All latched.")], "", { state: "idle" });
    expect(new Set([one, two, three]).size).toBe(3);
    expect([row("m2"), row("m3"), row("m4")]).toEqual([one, two, three]);
    expect([replyText("m2"), replyText("m3"), replyText("m4")]).toEqual(["Checking the gate log.", "Now the trough.", "All latched."]);
  });

  it("hands the live node to the segment a tool call saves when the next live reply starts in the same update", async () => {
    await open();
    await send("inflight", live("Checking the gate log."));
    const segment = row("s1-inflight")!;
    await turn([saved("m2", "Checking the gate log."), toolRow("completed")], "The north gate is latched.");
    expect(row("m2")).toBe(segment);
    // The new live reply is another message, so it never takes over the node that showed the segment.
    expect(row("s1-inflight")).not.toBe(segment);
    expect(replyText("s1-inflight")).toBe("The north gate is latched.");
    expect(replyText("m2")).toBe("Checking the gate log.");
  });

  it("hands the live node and its selection to the saved reply, and starts a new live reply that begins the same way in a new node", async () => {
    await open(true);
    await send("inflight", live("Here is the result.\n\n"));
    const before = row("s1-inflight")!;
    select(before, 0, 4);
    expect(document.getSelection()!.toString()).toBe("Here");
    // One update saves the reply, after a tool call, and starts the next live reply with the same opening.
    const update = () => turn([saved("m2", "Here is the result.\n\nThe north gate is latched."), toolRow("completed")], "Here is the result.\n\nThe east gate is open.");
    await update();
    expect(row("m2")).toBe(before);
    expect(document.getSelection()!.toString()).toBe("Here");
    const next = row("s1-inflight")!;
    expect(next).not.toBe(before);
    // The same update again moves nothing.
    await update();
    expect(row("m2")).toBe(before);
    expect(row("s1-inflight")).toBe(next);
    expect(replyText("m2")).toBe("Here is the result.The north gate is latched.");
    await advance(CATCH_UP_MS + 100);
    expect(replyText("s1-inflight")).toBe("Here is the result.The east gate is open.");
  });

  it("never hands the live node to a progress line, even one that continues the live text", async () => {
    await open();
    await send("inflight", live("Gate report.\n\n"));
    const before = row("s1-inflight")!;
    select(before, 0, 4);
    expect(document.getSelection()!.toString()).toBe("Gate");
    await turn([{ ...saved("p1", "Gate report.\n\nChecking the east gate."), interim: true }], "The north gate is latched.");
    expect(row("p1")).not.toBe(before);
    expect(before.isConnected).toBe(false);
    // The selection went with the node, rather than moving to the progress line's text.
    expect(document.getSelection()!.toString()).toBe("");
    expect(replyText("p1")).toBe("Gate report.\nChecking the east gate.");
    expect(replyText("s1-inflight")).toBe("The north gate is latched.");
  });

  it("streams a retried turn's reply in a new node and hands it to that reply's saved copy", async () => {
    await open();
    await send("inflight", live("Let me look"));
    const failed = row("s1-inflight")!;
    await save([], { state: "failed" });
    expect(failed.isConnected).toBe(false);
    await act(async () => mount.container.querySelector<HTMLButtonElement>("button.retry-turn")!.click());
    // The retry's ID is derived with Web Crypto, which settles in real time, outside the pinned
    // clock. Retry leaves once the server takes the retry, as the person sees it.
    await waitForUi(() => expect(mount.container.querySelector("button.retry-turn")).toBeNull());
    expect(retries).toEqual([question.id]);
    await save([], { state: "working", runId: "run-2" });
    await send("inflight", { ...live("The gate is latched."), activity: { state: "working", runId: "run-2" } });
    const retried = row("s1-inflight")!;
    expect(retried).not.toBe(failed);
    await save([{ ...saved("m3", "The gate is latched."), runId: "run-2" }]);
    expect(row("m3")).toBe(retried);
  });

  it("rebuilds the live reply when a steer starts a new turn below it, as main does, and hands no node to another message", async () => {
    await open();
    await send("inflight", live("The north gate"));
    const before = row("s1-inflight")!;
    const steer: Message = { id: "u2", role: "user", text: "Check the east gate too.", steered: true, sender: { id: "one", name: "One" }, createdAt: "2026-11-10T15:00:10Z" };
    await save([steer], running);
    await send("inflight", live("The north gate is latched. The east gate too."));
    await advance(CATCH_UP_MS + 100);
    expect(before.isConnected).toBe(false);
    expect(row("u2")).not.toBe(before);
    expect(replyText("s1-inflight")).toBe("The north gate is latched. The east gate too.");
  });

  it("keeps the live node and its selection when an earlier page of history loads above", async () => {
    const older: Message[] = [{ ...question, id: "u0", text: "Did the hay come?" }, saved("m0", "It came this morning.")];
    // The route tells the client how many messages lie before the page it sent.
    server = Object.assign({}, server, { earlier: 2 });
    await open();
    await send("inflight", live("The north gate is latched."));
    const node = row("s1-inflight")!;
    select(node, 4, 14);
    server = Object.assign({}, server, { earlier: 0, messages: [...older, ...server.messages] });
    await act(async () => [...mount.container.querySelectorAll("button")].find(item => item.textContent === "Show earlier messages")!.click());
    await advance(0);
    expect(replyText("m0")).toBe("It came this morning.");
    expect(row("s1-inflight")).toBe(node);
    generation++;
    server = { ...server, messages: [...older, question, saved("m2", "The north gate is latched.")], activity: { state: "idle" }, version: version() };
    await act(async () => stream().emit("message", "change"));
    await advance(0);
    expect(replyText("m0")).toBe("It came this morning.");
    expect(row("m2")).toBe(node);
    expect(document.getSelection()!.toString()).toBe("north gate");
  });
});

// While a reply streams, work over the saved rows is done once and kept until a read changes them.
const card = (id: string, body: string) => `\`\`\`agent-ui\n${JSON.stringify({ version: 1, cards: [{ id, type: "email", title: "Gate note", body }] })}\n\`\`\``;
const draft = (id: string, cardId: string, body: string): Message => ({ id, role: "assistant", text: `Here is the note.\n\n${card(cardId, body)}`, createdAt: "2026-11-10T14:00:00Z" });
const revision = (id: string) => row(id)?.querySelector(".email-draft-revision")?.textContent;
async function grow(text: string, from: number) {
  await send("inflight-delta", { botId: "home", messageId: "s1-inflight", baseTextLength: from, baseReasoningLength: 0, appendText: text, activity: running });
}

describe("the saved rows while a reply streams", () => {
  it("reads the saved drafts once, not again on each delta", async () => {
    server = { ...server, messages: [draft("d0", "fence-0", "Two posts."), ...[1, 2, 3, 4].map(at => draft(`d${at}`, `fence-${at}__revises__fence-${at - 1}`, `Posts ${at}.`)), question] };
    await open();
    await send("inflight", live("The"));
    const parse = vi.spyOn(JSON, "parse");
    let text = "The";
    for (let at = 0; at < 10; at++) { await grow(" gate", text.length); text += " gate"; }
    const cardReads = parse.mock.calls.filter(([value]) => typeof value === "string" && value.includes('"type":"email"'));
    parse.mockRestore();
    expect(cardReads).toEqual([]);
    expect(revision("d4")).toContain("Revises “Gate note”");
  });

  it("marks a live draft against the earlier one as a read during the reply last changed it", async () => {
    server = { ...server, messages: [draft("d0", "fence-0", "Meet at noon."), question] };
    await open();
    const reply = `Updated.\n\n${card("fence-1__revises__fence-0", "Meet at one.")}`;
    await send("inflight", live(reply));
    await advance(CATCH_UP_MS * 4);
    expect(revision("s1-inflight")).toContain("Revises “Gate note”");
    // The earlier draft is edited under the same ID; the live draft now matches it.
    generation++;
    server = { ...server, messages: [draft("d0", "fence-0", "Meet at one."), question], version: version() };
    await act(async () => stream().emit("message", "change"));
    await advance(0);
    expect(revision("s1-inflight")).toContain("Same as “Gate note”");
  });

  it("drops a reply a read redacts, with its file chip, and keeps another reply with the same words", async () => {
    const chart = { id: "chart", name: "chart.png", mime: "image/png" };
    const ask = (id: string): Message => ({ id, role: "user", text: "Chart the gates", sender: { id: "one", name: "One" }, createdAt: "2026-11-10T13:00:00Z" });
    const done = (id: string, text = "Here is the chart."): Message => ({ id, role: "assistant", text, createdAt: "2026-11-10T13:01:00Z" });
    const made: Message = { id: "t0", role: "tool", text: "", files: [chart], toolCall: { id: "call-0", name: "terminal", status: "completed" }, createdAt: "2026-11-10T13:00:30Z" };
    server = { ...server, messages: [ask("q0"), made, done("r0"), ask("q1"), done("r1"), question], files: [chart] };
    await open();
    await send("inflight", live("The north"));
    const chips = (id: string) => [...row(id)?.querySelectorAll(".reply-file-name") ?? []].map(name => name.textContent);
    expect(chips("r0")).toEqual(["chart.png"]);
    expect(chips("r1")).toEqual([]);
    generation++;
    server = { ...server, messages: [ask("q0"), made, done("r0", ""), ask("q1"), done("r1"), question], version: version() };
    await act(async () => stream().emit("message", "change"));
    await advance(0);
    expect(row("r0")).toBeNull();
    expect(mount.container.querySelector(".reply-files")).toBeNull();
    expect(replyText("r1")).toBe("Here is the chart.");
    expect(replyText("s1-inflight")).toBe("The north");
  });
});
