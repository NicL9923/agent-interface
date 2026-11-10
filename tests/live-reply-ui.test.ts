// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { clearResponseCache } from "../src/client-api";
import { CATCH_UP_MS } from "../src/components/streaming-reveal";
import { defaultPreferences, type Bootstrap, type Conversation, type Inflight, type InflightDelta, type Message } from "../src/shared/types";
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
  unexpected = [];
  server = { botId: "home", messages: [question], approvals: [], files: [], activity: running };
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
async function send(type: "inflight" | "inflight-delta", value: Inflight | InflightDelta) {
  await act(async () => stream().emit(type, JSON.stringify(value)));
}
/** The turn ends: the next read has Hermes's saved copy, and the stream says something changed. */
async function save(messages: Message[]) {
  server = { ...server, messages: [question, ...messages], activity: { state: "idle" } };
  await act(async () => stream().emit("message", "change"));
  await advance(0);
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
