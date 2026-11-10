// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { clearResponseCache } from "../src/client-api";
import { savedRosterKey, signInHintKey } from "../src/app/storage";
import type { GroupCatalog } from "../src/shared/collaboration";
import { defaultPreferences, type Bootstrap, type Conversation } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { advance, button, mountRoot, stubMatchMedia } from "./ui-harness";

// The whole app, through the real client API, against a fake server at fetch; browser storage is
// jsdom's. Bootstrap and the group catalog stay open until a test answers them, so a test sees what
// a person sees before they do. A request the test did not configure fails the test.
const NOW = Date.UTC(2026, 10, 10, 15);
const capabilities = Object.fromEntries(["chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration", "tools", "skills",
  "routines", "durableEvents", "idempotency", "imageGeneration", "stop", "portraitGeneration", "avatarMetadata"].map(key => [key, { supported: true }])) as Bootstrap["capabilities"];
const one: Bootstrap = {
  user: { id: "one", name: "Sam Rivers", email: "sam@example.test", picture: "https://lh3.googleusercontent.com/sam" },
  household: [],
  preferences: { ...defaultPreferences, theme: "dark", favorites: ["home"], sections: [{ id: "work", name: "Ranch work", botIds: ["ranch"] }],
    mainSuggestionDismissed: true, followBots: ["ranch"], defaultBotId: "home" },
  bots: [
    { id: "home", name: "Home", shared: true, model: "gpt", activity: "working", lastMessage: { text: "Grocery list sent.", at: "2026-11-10T14:00:00Z" } },
    { id: "ranch", name: "Ranch Hand", shared: false, model: "gpt", activity: "idle", unread: true,
      avatar: { mode: "portrait", src: "/api/files/ranch.png", origin: "uploaded" }, lastMessage: { text: "Fence check is done.", at: "2026-11-10T13:00:00Z" } },
    { id: "trail", name: "Trail Cook", shared: true, model: "gpt", activity: "idle", description: "Plans camp meals." },
  ],
  capabilities,
  connection: { connected: true },
  csrfToken: "csrf",
};
const two: Bootstrap = { ...one, user: { id: "two", name: "Jo Rivers", email: "jo@example.test" }, preferences: { ...defaultPreferences, startPage: "assistant" },
  bots: [{ id: "garden", name: "Garden Helper", shared: false, model: "gpt", activity: "idle" }] };
const catalog: GroupCatalog = { supported: true, canSend: true, rooms: [{ room_id: "supper", name: "Supper plans",
  members: [{ member_id: "home", profile: "home", handle: "home", display_name: "Home" }, { member_id: "trail", profile: "trail", handle: "trail", display_name: "Trail Cook" }],
  latest: { text: "Beans at six.", at: "2026-11-10T12:00:00Z", author: "You" } }] };
/** What a visit with `one` signed in leaves on this device, written out so the test pins the format. */
const savedOne = {
  v: 1, user: "one",
  me: { name: "Sam Rivers", picture: "https://lh3.googleusercontent.com/sam" },
  bots: [
    { id: "home", name: "Home", shared: true },
    { id: "ranch", name: "Ranch Hand", shared: false, avatar: { mode: "portrait", src: "/api/files/ranch.png", origin: "uploaded" } },
    { id: "trail", name: "Trail Cook", shared: true },
  ],
  order: { favorites: ["home"], sections: [{ id: "work", name: "Ranch work", botIds: ["ranch"] }], mainSuggestionDismissed: true },
  rooms: [{ room_id: "supper", name: "Supper plans", members: [{ member_id: "home", profile: "home", handle: "home", display_name: "Home" },
    { member_id: "trail", profile: "trail", handle: "trail", display_name: "Trail Cook" }] }],
};
const hintFor = (user: string | undefined, bots = ["home", "ranch", "trail"]) => ({ until: NOW + 60_000, ...user ? { user } : {}, bots });
const store = (key: string, value: unknown) => localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
const savedRoster = () => JSON.parse(localStorage.getItem(savedRosterKey) ?? "null") as unknown;
const page = (botId: string, text: string): Conversation => ({
  botId, messages: [{ id: `${botId}-1`, role: "assistant", text }], approvals: [], files: [], activity: { state: "idle" },
});

type Reply = (status: number, body: unknown) => Promise<void>;
let root: Root, container: HTMLDivElement;
let calls: string[], unexpected: string[];
let held: Record<string, Reply[]>;
const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const reads = (prefix: string) => calls.filter(call => call.startsWith(prefix));

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  clearResponseCache();
  window.__wildbotsStartup = undefined;
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia();
  Object.assign(SVGElement.prototype, { getTotalLength: () => 100, getPointAtLength: (length: number) => ({ x: length, y: 0 }) });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  calls = [];
  unexpected = [];
  held = {};
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, location.origin);
    const call = `${init.method ?? "GET"} ${url.pathname.replace(/^\/api/, "")}${url.search}`;
    calls.push(call);
    // Bootstrap and the group catalog wait for the test.
    if (call === "GET /bootstrap?roster=lean" || call === "GET /groups") {
      let settle!: (response: Response) => void;
      const response = new Promise<Response>(resolve => { settle = resolve; });
      (held[call] ??= []).push(async (status, body) => { await act(async () => settle(respond(status, body))); await advance(0); });
      return response;
    }
    const chat = /^GET \/bots\/([^/]+)\/conversation\?/.exec(call)?.[1];
    if (chat) return respond(200, page(chat, `${chat} says morning.`));
    const empty: Record<string, unknown> = {
      "GET /auth/config": { localDevAuth: true },
      "GET /usage/accounts": { accounts: [], unavailableBots: [] },
      "GET /mac/devices": { available: false, reason: "Not in this test.", devices: [] },
    };
    if (call in empty) return respond(200, empty[call]);
    if (/^GET \/bots\/[^/]+\/(draft|routine-runs)$/.test(call)) return respond(200, call.endsWith("draft") ? null : { runs: [], unavailable: [] });
    if (/^PUT \/(bots\/[^/]+\/presence|devices\/activity)$/.test(call) || call === "POST /auth/local" || call === "POST /auth/logout") return respond(200, {});
    unexpected.push(call);
    throw new TypeError(`Unexpected request ${call}`);
  }));
  ({ container, root } = mountRoot());
});
afterEach(() => { expect(unexpected).toEqual([]); });

async function open(url = "/") {
  history.replaceState(null, "", url);
  await act(async () => root.render(createElement(App)));
}
const answer = async (call: "GET /bootstrap?roster=lean" | "GET /groups", status: number, body: unknown) => {
  const reply = held[call]?.shift();
  expect(reply, `${call} waiting for its answer`).toBeDefined();
  await reply!(status, body);
};
const rail = () => container.querySelector<HTMLElement>(".bot-rail");
const railText = () => rail()?.textContent ?? "";
const row = (name: string) => [...rail()!.querySelectorAll<HTMLButtonElement>("button.bot-item")].find(item => item.textContent?.includes(name))!;
const welcome = () => container.querySelector(".welcome");
/** Home's rows top to bottom, by name. */
const order = () => [...rail()!.querySelectorAll(".pinned-name, .bot-row-name strong")].map(item => item.textContent);

describe("the home this device saved", () => {
  it("is drawn at once, before bootstrap answers, with only what the copy can know", async () => {
    store(signInHintKey, hintFor("one"));
    store(savedRosterKey, savedOne);
    await open();
    expect(reads("GET /bootstrap")).toHaveLength(1);
    expect(order()).toEqual(["Home", "Ranch Hand", "Trail Cook", "Supper plans"]);
    expect(railText()).toContain("Ranch work");
    // No message, time, unread mark or activity from the last visit is shown as if current.
    expect(railText()).not.toMatch(/Fence check|Grocery list|Beans at six|Working/);
    expect(rail()!.querySelectorAll("time, .unread-mark, .bot-activity")).toHaveLength(0);
    expect(row("Ranch Hand").textContent).toContain("Personal assistant");
    expect(row("Supper plans").textContent).toContain("Group chat with Home and Trail Cook");
    expect(row("Supper plans").textContent).not.toContain("No messages yet");
    expect(rail()!.querySelector('[role="status"]')?.textContent).toBe("Connecting");
    // What needs the server waits for it, as it did when the page showed nothing.
    for (const name of ["Account", "Search & saved", "New assistant"])
      expect(rail()!.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)?.disabled, name).toBe(true);
    await act(async () => row("Ranch Hand").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await act(async () => row("Trail Cook").dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // Pointing at a row reads nothing before bootstrap says whose session this is.
    expect(reads("GET /bots/")).toEqual([]);
  });

  it("is redrawn in place when bootstrap answers, keeping the rows and focus, then the rooms when the catalog does", async () => {
    store(signInHintKey, hintFor("one"));
    store(savedRosterKey, savedOne);
    await open();
    const scroller = rail()!.querySelector(".home-scroll"), ranch = row("Ranch Hand");
    ranch.focus();
    await answer("GET /bootstrap?roster=lean", 200, one);
    expect(rail()!.querySelector(".home-scroll")).toBe(scroller);
    expect(row("Ranch Hand")).toBe(ranch);
    expect(document.activeElement).toBe(ranch);
    expect(ranch.textContent).toContain("Fence check is done.");
    expect(ranch.querySelector(".unread-mark")).not.toBeNull();
    expect(rail()!.querySelector('[role="status"]')).toBeNull();
    // The rooms stay as saved until the catalog answers, rather than leaving and coming back, and stay saved.
    expect(row("Supper plans").textContent).toContain("Group chat with Home and Trail Cook");
    expect((savedRoster() as typeof savedOne).rooms).toEqual(savedOne.rooms);
    await answer("GET /groups", 200, catalog);
    expect(row("Supper plans").textContent).toContain("You: Beans at six.");
    expect(order()).toEqual(["Home", "Ranch Hand", "Trail Cook", "Supper plans"]);
  });

  it("is what home draws, and nothing said in a chat", async () => {
    store(signInHintKey, hintFor("one"));
    await open();
    expect(welcome()).not.toBeNull();
    await answer("GET /bootstrap?roster=lean", 200, one);
    // Bots and order are kept as soon as bootstrap answers; rooms once the catalog has.
    expect(savedRoster()).toEqual({ ...savedOne, rooms: [] });
    await answer("GET /groups", 200, catalog);
    expect(savedRoster()).toEqual(savedOne);
    expect(localStorage.getItem(savedRosterKey)).not.toMatch(/Fence check|Grocery|Beans|sam@example|Plans camp|unread|working/);
  });

  it("is not kept from a bootstrap that could not reach Hermes", async () => {
    store(signInHintKey, hintFor("one"));
    await open();
    // Its roster is the server's last snapshot, not Hermes's.
    await answer("GET /bootstrap?roster=lean", 200, { ...one, connection: { connected: false } });
    expect(savedRoster()).toBeNull();
  });

  it("draws none of what a copy should not hold, even when one holds it", async () => {
    store(signInHintKey, hintFor("one"));
    store(savedRosterKey, { ...savedOne,
      bots: savedOne.bots.map(bot => ({ ...bot, activity: "working", unread: true, lastMessage: { text: "Fence check is done.", at: "2026-11-10T13:00:00Z" } })),
      rooms: savedOne.rooms.map(room => ({ ...room, latest: { text: "Beans at six.", at: "2026-11-10T12:00:00Z", author: "You" } })) });
    await open();
    expect(order()).toEqual(["Home", "Ranch Hand", "Trail Cook", "Supper plans"]);
    expect(railText()).not.toMatch(/Fence check|Beans at six|Working/);
    expect(rail()!.querySelectorAll("time, .unread-mark, .bot-activity")).toHaveLength(0);
  });

  // Each falls back to the page without it: the welcome screen until bootstrap answers.
  it.each([
    ["no sign-in on this browser", null, savedOne],
    ["a lapsed sign-in", { ...hintFor("one"), until: NOW }, savedOne],
    ["a sign-in no bootstrap has named yet", hintFor(undefined), savedOne],
    ["a copy saved for another account", hintFor("two"), savedOne],
    ["a copy from a future format", hintFor("one"), { ...savedOne, v: 2 }],
    ["an unreadable copy", hintFor("one"), "{not json"],
    ["a copy with no assistants", hintFor("one"), { ...savedOne, bots: [] }],
    ["an assistant with no name", hintFor("one"), { ...savedOne, bots: [{ id: "home", shared: true }] }],
    ["a portrait from outside the app's files", hintFor("one"), { ...savedOne, bots: [{ id: "home", name: "Home", shared: true, avatar: { mode: "portrait", src: "https://elsewhere.test/x.png", origin: "uploaded" } }] }],
    ["an avatar of an unknown kind", hintFor("one"), { ...savedOne, bots: [{ id: "home", name: "Home", shared: true, avatar: { mode: "hologram" } }] }],
    ["sections that are not a list", hintFor("one"), { ...savedOne, order: { ...savedOne.order, sections: "work" } }],
    ["a room member with no profile", hintFor("one"), { ...savedOne, rooms: [{ room_id: "supper", name: "Supper plans", members: [{ member_id: "home", handle: "home" }] }] }],
    ["no account name", hintFor("one"), { ...savedOne, me: {} }],
  ])("is not drawn for %s", async (_name, hint, saved) => {
    if (hint) store(signInHintKey, hint);
    store(savedRosterKey, saved);
    await open();
    expect([!!welcome(), !!rail()]).toEqual([true, false]);
  });

  it("is not drawn, and nothing breaks, when storage is blocked", async () => {
    store(signInHintKey, hintFor("one"));
    store(savedRosterKey, savedOne);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    await open();
    expect(welcome()).not.toBeNull();
    await answer("GET /bootstrap?roster=lean", 200, one);
    expect(order()).toEqual(["Home", "Ranch Hand", "Trail Cook"]);
  });

  it("is not saved, and nothing breaks, when storage is full", async () => {
    store(signInHintKey, hintFor("one"));
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function(this: Storage, key: string, value: string) {
      if (key === savedRosterKey) throw new DOMException("Full", "QuotaExceededError");
      setItem.call(this, key, value);
    });
    await open();
    await answer("GET /bootstrap?roster=lean", 200, one);
    expect([order(), savedRoster(), container.querySelector('[role="alert"]')]).toEqual([["Home", "Ranch Hand", "Trail Cook"], null, null]);
  });
});

describe("whose saved home it is", () => {
  it("is gone, from the page and the device, when bootstrap answers as someone else", async () => {
    store(signInHintKey, hintFor("one"));
    store(savedRosterKey, savedOne);
    await open();
    await answer("GET /bootstrap?roster=lean", 200, two);
    expect(order()).toEqual(["Garden Helper"]);
    expect(savedRoster()).toBeNull();
    // Another member's rooms never stand in while this member's catalog loads.
    expect(railText()).not.toContain("Supper plans");
  });

  it("is gone when bootstrap finds no session, and the next person to sign in never sees it", async () => {
    store(signInHintKey, hintFor("one"));
    store(savedRosterKey, savedOne);
    await open();
    await answer("GET /bootstrap?roster=lean", 401, { error: "Sign in required", code: "session_expired" });
    expect(container.querySelector(".sign-in")).not.toBeNull();
    expect(savedRoster()).toBeNull();
    // Even a copy written back meanwhile, as by an older tab, is not this sign-in's.
    store(savedRosterKey, savedOne);
    await act(async () => button("Enter local workspace").click());
    await advance(0);
    expect([!!welcome(), !!rail()]).toEqual([true, false]);
    expect(savedRoster()).toBeNull();
    await answer("GET /bootstrap?roster=lean", 200, two);
    expect(order()).toEqual(["Garden Helper"]);
  });

  it("is gone when the person signs out", async () => {
    for (const [name, opened] of [["showModal", true], ["close", false]] as const)
      Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, value: function(this: HTMLDialogElement) { this.open = opened; } });
    store(signInHintKey, hintFor("one"));
    await open();
    await answer("GET /bootstrap?roster=lean", 200, one);
    expect(savedRoster()).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Account"]')!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.startsWith("Sign out"))!.click());
    await act(async () => { await vi.dynamicImportSettled(); });
    await act(async () => document.querySelector<HTMLButtonElement>('[role="alertdialog"] button.danger')!.click());
    await advance(0);
    expect(container.querySelector(".sign-in")).not.toBeNull();
    expect(savedRoster()).toBeNull();
  });

  it("leaves the page when another tab signs out while it shows", async () => {
    store(signInHintKey, hintFor("one"));
    store(savedRosterKey, savedOne);
    await open();
    expect(rail()).not.toBeNull();
    localStorage.removeItem(signInHintKey);
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: signInHintKey, newValue: null })));
    expect([!!welcome(), !!rail()]).toEqual([true, false]);
  });
});

describe("using the saved home before bootstrap answers", () => {
  it("opens the chat chosen there once bootstrap answers, from a read started at the tap", async () => {
    store(signInHintKey, hintFor("one"));
    store(savedRosterKey, savedOne);
    await open();
    await act(async () => row("Ranch Hand").click());
    expect(reads("GET /bots/")).toEqual(["GET /bots/ranch/conversation?turns=20"]);
    expect(container.querySelector(".saved-home-wait")?.textContent).toContain("Connecting to your household");
    // The person's start page is Today; the chat they chose wins.
    await answer("GET /bootstrap?roster=lean", 200, { ...one, preferences: { ...one.preferences, startPage: "today" } });
    expect(container.querySelector(".transcript")?.textContent).toContain("ranch says morning.");
    expect(reads("GET /bots/ranch/conversation")).toHaveLength(1);
    expect(new URLSearchParams(location.search).get("bot")).toBe("ranch");
  });

  it("says plainly that it cannot connect when bootstrap fails, and keeps trying", async () => {
    store(signInHintKey, hintFor("one"));
    store(savedRosterKey, savedOne);
    await open();
    await answer("GET /bootstrap?roster=lean", 503, { error: "Hermes is restarting" });
    expect(rail()!.querySelector('[role="status"]')?.textContent).toBe("Can't connect");
    expect(container.querySelector(".saved-home-wait")?.textContent).toContain("Can't reach the app right now");
    await act(async () => button("Try again").click());
    await answer("GET /bootstrap?roster=lean", 200, one);
    expect(row("Ranch Hand").textContent).toContain("Fence check is done.");
  });
});
