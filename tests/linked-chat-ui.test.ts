// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { clearResponseCache } from "../src/client-api";
import { signInHintKey } from "../src/app/storage";
import { SESSION_MAX_AGE_MS } from "../src/shared/session";
import { defaultPreferences, type Bootstrap, type Conversation } from "../src/shared/types";
import { quietConsoleErrors } from "./act-guard";
import { FakeEventSource } from "./fake-event-source";
import { advance, button, mountRoot, stubMatchMedia } from "./ui-harness";

// The app runs whole, through the real client API, against a fake server at fetch. A request the
// test did not configure is recorded and refused, and the test fails on it after it ends.
const NOW = Date.UTC(2026, 10, 9, 15);
const bootstrap: Bootstrap = {
  user: { id: "one", name: "One", email: "one@example.test" },
  household: [],
  preferences: { ...defaultPreferences, startPage: "assistant", defaultBotId: "home" },
  bots: [
    { id: "home", name: "Home", shared: true, model: "test", activity: "idle" },
    { id: "ranch", name: "Ranch Hand", shared: true, model: "test", activity: "idle" },
  ],
  capabilities: Object.fromEntries(["chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration", "tools", "skills",
    "routines", "durableEvents", "idempotency", "imageGeneration", "stop", "portraitGeneration", "avatarMetadata"].map(key => [key, { supported: true }])) as Bootstrap["capabilities"],
  connection: { connected: true },
  csrfToken: "csrf",
};
const two: Bootstrap = { ...bootstrap, user: { id: "two", name: "Two", email: "two@example.test" } };
const page = (botId: string, text: string): Conversation => ({
  botId, messages: [{ id: `${botId}-1`, role: "assistant", text }], approvals: [], files: [], activity: { state: "idle" },
});
/** A refusal as the server sends it. */
const refused = (status: number, error: string, code: string) => ({ status, body: { error, code } });
type Answer = { status: number; body: unknown };
type Reply = { resolve(value: unknown): void; refuse(answer: Answer): void };

let root: Root, container: HTMLDivElement;
let bootstrapReplies: Reply[];
let conversationReplies: Record<string, Reply[]>;
let calls: string[];
let unexpected: string[];
const respond = ({ status, body }: Answer) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function held() {
  let settle!: (answer: Answer) => void;
  const response = new Promise<Response>(resolve => { settle = answer => resolve(respond(answer)); });
  return { response, reply: { resolve: (body: unknown) => settle({ status: 200, body }), refuse: settle } };
}
const conversationReads = () => calls.filter(call => call.startsWith("GET /bots/") && call.includes("/conversation"));
const hint = () => JSON.parse(localStorage.getItem(signInHintKey) ?? "null") as { until: number; user?: string; bots: string[] } | null;
const saveHint = (value: unknown) => localStorage.setItem(signInHintKey, typeof value === "string" ? value : JSON.stringify(value));
const transcript = () => container.querySelector(".transcript")?.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  // Module state outlives a test: each one starts as a fresh page would, with no reads to join.
  clearResponseCache();
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia();
  // Browser APIs jsdom lacks, which the real Avatar uses: SVG geometry to animate its shape, and
  // visibility to pause offscreen.
  Object.assign(SVGElement.prototype, { getTotalLength: () => 100, getPointAtLength: (length: number) => ({ x: length, y: 0 }) });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  calls = [];
  unexpected = [];
  bootstrapReplies = [];
  conversationReplies = {};
  // Bootstrap and conversation reads stay open until a test answers them, so their order is the test's to set.
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, location.origin);
    const call = `${init.method ?? "GET"} ${url.pathname.replace(/^\/api/, "")}${url.search}`;
    calls.push(call);
    if (call === "GET /bootstrap?roster=lean") {
      const { response, reply } = held();
      bootstrapReplies.push(reply);
      return response;
    }
    const chat = /^GET \/bots\/([^/]+)\/conversation\?/.exec(call)?.[1];
    if (chat) {
      const { response, reply } = held();
      (conversationReplies[chat] ??= []).push(reply);
      return response;
    }
    // What else the open app reads, empty: these tests look only at the chat.
    const empty: Record<string, unknown> = {
      "GET /auth/config": { localDevAuth: true },
      "GET /groups": { supported: false, canSend: false, rooms: [], reason: "Not in this test." },
      "GET /usage/accounts": { accounts: [], unavailableBots: [] },
      "GET /mac/devices": { available: false, reason: "Not in this test.", devices: [] },
    };
    if (call in empty) return respond({ status: 200, body: empty[call] });
    if (/^GET \/bots\/[^/]+\/draft$/.test(call)) return respond({ status: 200, body: null });
    if (/^GET \/bots\/[^/]+\/routine-runs$/.test(call)) return respond({ status: 200, body: { runs: [], unavailable: [] } });
    // Reading reports and sign-in and out, which these tests do not inspect.
    if (/^PUT \/(bots\/[^/]+\/presence|devices\/activity)$/.test(call) || call === "POST /auth/local" || call === "POST /auth/logout")
      return respond({ status: 200, body: {} });
    unexpected.push(call);
    throw new TypeError(`Unexpected request ${call}`);
  }));
  ({ container, root } = mountRoot());
});

afterEach(() => {
  expect(unexpected).toEqual([]);
});

async function open(url: string) {
  history.replaceState(null, "", url);
  await act(async () => root.render(createElement(App)));
}
async function answer(reply: Reply | undefined, value: unknown, refusal?: Answer) {
  expect(reply, "a request waiting for its answer").toBeDefined();
  await act(async () => { if (refusal) reply!.refuse(refusal); else reply!.resolve(value); });
  await advance(0);
}
const answerBootstrap = (value: Bootstrap | Answer) =>
  "status" in value ? answer(bootstrapReplies.at(-1), undefined, value) : answer(bootstrapReplies.at(-1), value);
const answerChat = (botId: string, value: Conversation | Answer, index = -1) =>
  "status" in value ? answer(conversationReplies[botId]?.at(index), undefined, value) : answer(conversationReplies[botId]?.at(index), value);

describe("a link that names a chat", () => {
  it("reads the chat while bootstrap is on its way, and the chat shows that same read", async () => {
    saveHint({ until: NOW + 60_000, user: "one", bots: ["home", "ranch"] });
    await open("/?bot=ranch");
    expect(calls).toContain("GET /bootstrap?roster=lean");
    expect(conversationReads()).toEqual(["GET /bots/ranch/conversation?turns=20"]);
    await answerChat("ranch", page("ranch", "The north gate is latched."));
    await answerBootstrap(bootstrap);
    expect(transcript()).toContain("The north gate is latched.");
    // The opened chat joined the read already made rather than asking again.
    expect(conversationReads()).toEqual(["GET /bots/ranch/conversation?turns=20"]);
  });

  it("joins the read when bootstrap answers first", async () => {
    saveHint({ until: NOW + 60_000, user: "one", bots: ["ranch"] });
    await open("/?bot=ranch");
    await answerBootstrap(bootstrap);
    expect(conversationReads()).toHaveLength(1);
    await answerChat("ranch", page("ranch", "Fence check is done."));
    expect(transcript()).toContain("Fence check is done.");
    expect(conversationReads()).toHaveLength(1);
  });

  // Another tab signed the browser in as someone else after this page read the hint, so the chat
  // read went out as the last account and bootstrap as the new one. Nothing of the read may show.
  it.each([
    ["before", true],
    ["after", false],
  ])("never shows a read made as another account, answered %s bootstrap", async (_when, readFirst) => {
    saveHint({ until: NOW + 60_000, user: "one", bots: ["home", "ranch"] });
    await open("/?bot=ranch");
    if (readFirst) await answerChat("ranch", page("ranch", "One's private draft"));
    await answerBootstrap({ ...two, preferences: { ...two.preferences, defaultBotId: "ranch" } });
    if (!readFirst) await answerChat("ranch", page("ranch", "One's private draft"), 0);
    expect(transcript()).not.toContain("One's private draft");
    // Read again, as the person bootstrap signed in.
    expect(conversationReads()).toEqual(["GET /bots/ranch/conversation?turns=20", "GET /bots/ranch/conversation?turns=20"]);
    await answerChat("ranch", page("ranch", "Two's own chat"));
    expect(transcript()).toContain("Two's own chat");
    expect(transcript()).not.toContain("One's private draft");
  });

  it.each([
    ["removes the sign-in record", null],
    ["writes a new sign-in", JSON.stringify({ until: NOW + SESSION_MAX_AGE_MS, bots: [] })],
  ])("drops its read when another tab %s while it is out", async (_name, newValue) => {
    saveHint({ until: NOW + 60_000, user: "one", bots: ["home", "ranch"] });
    await open("/?bot=ranch");
    const oldValue = localStorage.getItem(signInHintKey);
    await act(async () => {
      if (newValue) localStorage.setItem(signInHintKey, newValue); else localStorage.removeItem(signInHintKey);
      window.dispatchEvent(new StorageEvent("storage", { key: signInHintKey, oldValue, newValue, storageArea: localStorage }));
    });
    await answerChat("ranch", page("ranch", "Read before the switch"));
    await answerBootstrap(bootstrap);
    expect(transcript()).not.toContain("Read before the switch");
    expect(conversationReads()).toHaveLength(2);
    await answerChat("ranch", page("ranch", "Read after the switch"));
    expect(transcript()).toContain("Read after the switch");
  });

  it.each([
    ["the same account's chat list", signInHintKey, JSON.stringify({ until: NOW + 60_000, user: "one", bots: ["ranch"] })],
    ["something other than the sign-in", "agent-interface:unrelated", "{}"],
  ])("keeps its read when another tab changes %s", async (_name, key, newValue) => {
    saveHint({ until: NOW + 60_000, user: "one", bots: ["home", "ranch"] });
    await open("/?bot=ranch");
    await act(async () => {
      localStorage.setItem(key, newValue);
      window.dispatchEvent(new StorageEvent("storage", { key, oldValue: null, newValue, storageArea: localStorage }));
    });
    await answerChat("ranch", page("ranch", "Still mine"));
    await answerBootstrap(bootstrap);
    expect(transcript()).toContain("Still mine");
    expect(conversationReads()).toHaveLength(1);
  });

  it("shows sign-in to a signed-out person without reading the chat or reporting an error", async () => {
    const errors = quietConsoleErrors();
    await open("/?bot=ranch");
    await answerBootstrap(refused(401, "Sign in required", "session_expired"));
    expect(button("Enter local workspace")).toBeDefined();
    expect(conversationReads()).toEqual([]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([
    ["no earlier sign-in on this browser", undefined, "/?bot=ranch"],
    ["a sign-in that has lapsed", { until: NOW, user: "one", bots: ["ranch"] }, "/?bot=ranch"],
    ["a sign-in whose account no bootstrap has named yet", { until: NOW + 60_000, bots: ["ranch"] }, "/?bot=ranch"],
    ["a chat the last sign-in could not open", { until: NOW + 60_000, user: "one", bots: ["home"] }, "/?bot=ranch"],
    ["an unreadable record", "{not json", "/?bot=ranch"],
    ["a lapse time that is not a number", { until: String(NOW + 60_000), user: "one", bots: ["ranch"] }, "/?bot=ranch"],
    ["an account that is not an ID", { until: NOW + 60_000, user: 1, bots: ["ranch"] }, "/?bot=ranch"],
    ["a record whose chats are not a list of IDs", { until: NOW + 60_000, user: "one", bots: "ranch" }, "/?bot=ranch"],
    ["a link to a message, which opens around it instead", { until: NOW + 60_000, user: "one", bots: ["ranch"] }, "/?bot=ranch&message=ranch-1"],
    ["a link to Today", { until: NOW + 60_000, user: "one", bots: ["ranch"] }, "/?bot=ranch&view=today"],
  ])("waits for bootstrap with %s", async (_name, stored, url) => {
    if (stored !== undefined) saveHint(stored);
    await open(url);
    expect(calls).toContain("GET /bootstrap?roster=lean");
    expect(conversationReads()).toEqual([]);
  });

  it("opens a message link at that message after bootstrap", async () => {
    saveHint({ until: NOW + 60_000, user: "one", bots: ["ranch"] });
    await open("/?bot=ranch&message=ranch-1");
    await answerBootstrap(bootstrap);
    expect(conversationReads()).toEqual(["GET /bots/ranch/conversation?start=ranch-1"]);
  });

  it("drops a read for a chat the person can no longer see, says so once, and stops reading it next time", async () => {
    saveHint({ until: NOW + 60_000, user: "one", bots: ["home", "ranch"] });
    await open("/?bot=ranch");
    await answerChat("ranch", refused(404, "Assistant not found", "assistant_not_found"));
    await answerBootstrap({ ...bootstrap, bots: [bootstrap.bots[0]] });
    // The app's existing notice, and the main assistant opens instead.
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("That assistant is no longer available to you.");
    expect(conversationReads()).toEqual(["GET /bots/ranch/conversation?turns=20", "GET /bots/home/conversation?turns=20"]);
    expect(hint()?.bots).toEqual(["home"]);
  });
});

describe("what this browser remembers about its sign-in", () => {
  it("starts at sign-in, learns the account and chats from bootstrap, and is forgotten when the session is refused", async () => {
    await open("/");
    await answerBootstrap(refused(401, "Sign in required", "session_expired"));
    await act(async () => button("Enter local workspace").click());
    await advance(0);
    expect(hint()).toEqual({ until: NOW + SESSION_MAX_AGE_MS - 60_000, bots: [] });
    await answerBootstrap(bootstrap);
    expect(hint()).toEqual({ until: NOW + SESSION_MAX_AGE_MS - 60_000, user: "one", bots: ["home", "ranch"] });
    // A bootstrap that cannot reach Hermes lists no chats; that is no reason to forget them.
    await act(async () => window.dispatchEvent(new Event("online")));
    await answerBootstrap({ ...bootstrap, bots: [], connection: { connected: false } });
    expect(hint()?.bots).toEqual(["home", "ranch"]);
    await act(async () => window.dispatchEvent(new Event("online")));
    await answerBootstrap(refused(401, "Sign in required", "session_expired"));
    expect(hint()).toBeNull();
  });

  it("is forgotten when bootstrap names an account other than the one it recorded", async () => {
    saveHint({ until: NOW + 60_000, user: "one", bots: ["home"] });
    await open("/");
    await answerBootstrap(two);
    expect(hint()).toBeNull();
  });

  it("is forgotten when the person signs out", async () => {
    for (const [name, opened] of [["showModal", true], ["close", false]] as const)
      Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, value: function(this: HTMLDialogElement) { this.open = opened; } });
    saveHint({ until: NOW + 60_000, user: "one", bots: ["home"] });
    await open("/");
    await answerBootstrap(bootstrap);
    await answerChat("home", page("home", "Morning."));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Account"]')!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.startsWith("Sign out"))!.click());
    await act(async () => { await vi.dynamicImportSettled(); });
    await act(async () => document.querySelector<HTMLButtonElement>('[role="alertdialog"] button.danger')!.click());
    await advance(0);
    expect(calls).toContain("POST /auth/logout");
    expect(container.querySelector(".sign-in")).not.toBeNull();
    expect(hint()).toBeNull();
  });

  it("does not invent a sign-in for a session this browser did not see start", async () => {
    await open("/");
    await answerBootstrap(bootstrap);
    expect(hint()).toBeNull();
  });
});
