// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { clearResponseCache } from "../src/client-api";
import { authEpochKey, savedRosterKey, savedThemeKey, signInHintKey } from "../src/app/storage";
import { LIMITS, MAX_SAVED_CHARS } from "../src/app/saved-roster";
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
/**
 * What the rows say that only the server can know, as a person sees it or a screen reader reads it:
 * an unread mark, an activity, a date.
 */
const notKnown = () => [...rail()!.querySelectorAll("button")].flatMap(item => [
  ...item.textContent?.match(/Unread|Thinking|Working|Waiting|Needs your help|Done/g) ?? [],
  ...[...item.querySelectorAll("time")].map(time => time.textContent),
]);
/** What the app's one connection live region says. */
const announced = () => [...container.querySelectorAll('[role="status"]')].map(region => region.textContent).join(" ").trim();
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
    expect(notKnown()).toEqual([]);
    expect(row("Ranch Hand").textContent).toContain("Personal assistant");
    expect(row("Supper plans").textContent).toContain("Group chat with Home and Trail Cook");
    expect(row("Supper plans").textContent).not.toContain("No messages yet");
    // Seen in the rail; the app's one connection live region has nothing to announce yet.
    expect(railText()).toContain("Connecting");
    expect(announced()).toBe("");
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
    // The row's name, as a screen reader reads it, now says it is unread.
    expect(ranch.textContent).toContain("Unread");
    expect(railText()).not.toContain("Connecting");
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
    expect(notKnown()).toEqual([]);
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
    // Another tab's sign-out, as it writes it (src/app/account-change.ts).
    localStorage.removeItem(signInHintKey);
    localStorage.removeItem(savedRosterKey);
    store(authEpochKey, { id: "elsewhere", at: NOW, signedOut: true, user: "one" });
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: authEpochKey })));
    await advance(0);
    expect(rail()).toBeNull();
    expect(button("Enter local workspace")).toBeDefined();
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
    expect(railText()).toContain("Can't connect");
    expect(announced()).toContain("Reconnecting to the app");
    expect(container.querySelector(".saved-home-wait")?.textContent).toContain("Can't reach the app right now");
    await act(async () => button("Try again").click());
    await answer("GET /bootstrap?roster=lean", 200, one);
    expect(row("Ranch Hand").textContent).toContain("Fence check is done.");
  });
});

// What every signed-in browser holds since the account record: the record, the hint and the copy.
const signedInAsOne = (hint = hintFor("one")) => {
  store(authEpochKey, { id: "earlier", at: NOW - 60_000, user: "one" });
  store(signInHintKey, hint);
  store(savedRosterKey, savedOne);
};
/** Another tab's sign-out of member one, written as that tab writes it, and heard only if `heard`. */
async function signedOutElsewhere(heard: boolean) {
  localStorage.removeItem(signInHintKey);
  localStorage.removeItem(savedRosterKey);
  store(authEpochKey, { id: "elsewhere", at: NOW, signedOut: true, user: "one" });
  if (heard) await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: authEpochKey })));
  await advance(0);
}
const showsSavedHome = () => railText().includes("Ranch Hand");

describe("the saved home held in memory", () => {
  it("goes when storage is cleared, at the event that says so however late, and the answer before it is not drawn", async () => {
    signedInAsOne();
    await open();
    expect(showsSavedHome()).toBe(true);
    localStorage.clear();
    // The bootstrap made as member one answers before the event arrives; it is discarded, and the home with it.
    await answer("GET /bootstrap?roster=lean", 200, one);
    expect(showsSavedHome()).toBe(false);
    expect(welcome()).not.toBeNull();
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(showsSavedHome()).toBe(false);
    // Starting again, the server says who is signed in.
    expect(reads("GET /bootstrap")).toHaveLength(2);
  });

  it("goes at the event when storage is cleared and nothing else has happened", async () => {
    signedInAsOne();
    await open();
    localStorage.clear();
    expect(showsSavedHome()).toBe(true);
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    await advance(0);
    expect(showsSavedHome()).toBe(false);
  });

  it("goes when the sign-in hint lapses, at that moment, and bootstrap is asked again", async () => {
    signedInAsOne(hintFor("one"));
    await open();
    expect(showsSavedHome()).toBe(true);
    await advance(59_000);
    expect(showsSavedHome()).toBe(true);
    await advance(1_000);
    expect(showsSavedHome()).toBe(false);
    expect([savedRoster(), localStorage.getItem(signInHintKey)]).toEqual([null, null]);
    expect(reads("GET /bootstrap")).toHaveLength(2);
  });

  it.each([
    ["shown from the back-forward cache", () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))],
    ["shown again", () => document.dispatchEvent(new Event("visibilitychange"))],
  ])("goes when the page is %s after a sign-out elsewhere it never heard", async (_name, wake) => {
    signedInAsOne();
    await open();
    await signedOutElsewhere(false);
    expect(showsSavedHome()).toBe(true);
    await act(async () => wake());
    await advance(0);
    expect(showsSavedHome()).toBe(false);
    expect(button("Enter local workspace")).toBeDefined();
  });

  it("is not drawn again by the bootstrap made before another tab's sign-out removed it", async () => {
    signedInAsOne();
    await open();
    await signedOutElsewhere(true);
    expect(button("Enter local workspace")).toBeDefined();
    await answer("GET /bootstrap?roster=lean", 200, one);
    expect(rail()).toBeNull();
    expect(container.textContent).not.toMatch(/Ranch Hand|Sam Rivers/);
  });
});

describe("the first answer that refuses the session", () => {
  it("removes the copy, the hint and the theme, and shows sign-in in this tab", async () => {
    signedInAsOne();
    store(savedThemeKey, { v: 1, user: "one", theme: "dark" });
    await open();
    expect(showsSavedHome()).toBe(true);
    await answer("GET /bootstrap?roster=lean", 401, { error: "Sign in required", code: "session_expired" });
    expect(button("Enter local workspace")).toBeDefined();
    expect(rail()).toBeNull();
    expect([savedRoster(), localStorage.getItem(signInHintKey), localStorage.getItem(savedThemeKey)]).toEqual([null, null, null]);
    expect(JSON.parse(localStorage.getItem(authEpochKey)!)).toMatchObject({ signedOut: true, user: "one" });
  });
});

describe("what a saved copy may hold", () => {
  const long = (length: number) => "x".repeat(length);
  const bot = (avatar: unknown) => ({ ...savedOne, bots: [{ id: "home", name: "Home", shared: true, avatar }] });
  const geometric = { mode: "geometric", shape: "blob", color: "#1084FE", eyes: "oval", accessory: "none" };
  const mascot = { mode: "mascot", family: "bear", color: "#FF9800", eyes: "round", accessory: "hat" };
  const portrait = { mode: "portrait", src: "/api/files/home.png", origin: "uploaded" };
  const many = <T,>(count: number, item: (index: number) => T) => Array.from({ length: count }, (_, index) => item(index));
  const room = (members: unknown[]) => ({ ...savedOne, rooms: [{ room_id: "supper", name: "Supper plans", members }] });
  const member = { member_id: "home", profile: "home", handle: "home" };

  // One case per field and bound, each one the server would never have sent. Every one falls back to
  // the page without the copy, and none reaches the avatar or the rail to break it.
  it.each([
    ["a geometric avatar's color that is not a color", bot({ ...geometric, color: { r: 1 } })],
    ["a geometric avatar's unknown shape", bot({ ...geometric, shape: "hexagon" })],
    ["a geometric avatar's unknown eyes", bot({ ...geometric, eyes: "laser" })],
    ["a geometric avatar's unknown accessory", bot({ ...geometric, accessory: "cape" })],
    ["a geometric avatar's eye width past the server's range", bot({ ...geometric, eyeWidth: 1.6 })],
    ["a geometric avatar's eye height that is not a number", bot({ ...geometric, eyeHeight: "1" })],
    ["a geometric avatar's eye spacing under the server's range", bot({ ...geometric, eyeSpacing: 0.5 })],
    ["a mascot's unknown family", bot({ ...mascot, family: "dragon" })],
    ["a mascot's color that is not a color", bot({ ...mascot, color: "orange" })],
    ["a portrait's unknown origin", bot({ ...portrait, origin: "found" })],
    ["a portrait's address past its bound", bot({ ...portrait, src: `/api/files/${long(LIMITS.url)}` })],
    ["an assistant's name past its bound", { ...savedOne, bots: [{ id: "home", name: long(LIMITS.name + 1), shared: true }] }],
    ["an assistant's empty ID", { ...savedOne, bots: [{ id: "", name: "Home", shared: true }] }],
    ["an assistant's ID past its bound", { ...savedOne, bots: [{ id: long(LIMITS.id + 1), name: "Home", shared: true }] }],
    ["more assistants than its bound", { ...savedOne, bots: many(LIMITS.bots + 1, index => ({ id: `b${index}`, name: "B", shared: true })) }],
    ["the account's name past its bound", { ...savedOne, me: { name: long(LIMITS.name + 1) } }],
    ["the account's picture from a plain address", { ...savedOne, me: { name: "Sam", picture: "http://lh3.googleusercontent.com/sam" } }],
    ["the account's picture past its bound", { ...savedOne, me: { name: "Sam", picture: `https://${long(LIMITS.url)}` } }],
    ["more rooms than their bound", { ...savedOne, rooms: many(LIMITS.rooms + 1, index => ({ room_id: `r${index}`, name: "R", members: [] })) }],
    ["a room's name past its bound", { ...savedOne, rooms: [{ room_id: "supper", name: long(LIMITS.name + 1), members: [] }] }],
    ["more room members than their bound", room(many(LIMITS.members + 1, () => member))],
    ["a room member's name past its bound", room([{ ...member, display_name: long(LIMITS.name + 1) }])],
    ["more sections than their bound", { ...savedOne, order: { ...savedOne.order, sections: many(LIMITS.sections + 1, index => ({ id: `s${index}`, name: "S", botIds: [] })) } }],
    ["a section with more assistants than its bound", { ...savedOne, order: { ...savedOne.order, sections: [{ id: "s", name: "S", botIds: many(LIMITS.sectionBots + 1, index => `b${index}`) }] } }],
    ["more pinned assistants than their bound", { ...savedOne, order: { ...savedOne.order, favorites: many(LIMITS.favorites + 1, index => `b${index}`) } }],
    ["a main assistant ID past its bound", { ...savedOne, order: { ...savedOne.order, mainBotId: long(LIMITS.id + 1) } }],
    ["a stored value larger than any this release writes", { ...savedOne, extra: long(MAX_SAVED_CHARS) }],
  ])("is not drawn with %s", async (_name, saved) => {
    signedInAsOne();
    store(savedRosterKey, saved);
    await open();
    expect([!!welcome(), !!rail()]).toEqual([true, false]);
  });

  it("is drawn at every bound's limit, so a copy bootstrap could produce always shows", async () => {
    signedInAsOne();
    store(savedRosterKey, { ...savedOne, me: { name: long(LIMITS.name), picture: `https://${long(LIMITS.url - 8)}` },
      bots: [{ id: long(LIMITS.id), name: long(LIMITS.name), shared: true, avatar: { ...geometric, eyeWidth: 1.5, eyeHeight: 0.6 } },
        ...savedOne.bots, { id: "fox", name: "Fox", shared: false, avatar: mascot }, { id: "pic", name: "Pic", shared: false, avatar: portrait }] });
    await open();
    expect(railText()).toContain(long(LIMITS.name));
    expect(railText()).toContain("Fox");
  });
});

describe("saved rooms against the roster bootstrap verified", () => {
  it("drop a room whose assistant left the roster at once, and keep it dropped when the catalog fails", async () => {
    signedInAsOne();
    await open();
    expect(railText()).toContain("Supper plans");
    // Trail Cook, a member of Supper plans, is no longer this person's.
    await answer("GET /bootstrap?roster=lean", 200, { ...one, bots: one.bots.filter(item => item.id !== "trail") });
    expect(railText()).not.toContain("Supper plans");
    await answer("GET /groups", 500, { error: "Hermes is restarting" });
    expect(railText()).not.toContain("Supper plans");
    expect((savedRoster() as typeof savedOne).rooms).toEqual([]);
  });

  it("keep a room whose assistants all remain while the catalog fails", async () => {
    signedInAsOne();
    await open();
    await answer("GET /bootstrap?roster=lean", 200, one);
    await answer("GET /groups", 500, { error: "Hermes is restarting" });
    expect((savedRoster() as typeof savedOne).rooms).toEqual(savedOne.rooms);
  });
});

describe("signing out from the saved home when the app cannot be reached", () => {
  it("signs out of this device at once, in every tab, and ends the server's session once it answers", async () => {
    signedInAsOne();
    store(savedThemeKey, { v: 1, user: "one", theme: "dark" });
    await open();
    await answer("GET /bootstrap?roster=lean", 503, { error: "Hermes is restarting" });
    await act(async () => button("Sign out of this device").click());
    await advance(0);
    expect(button("Enter local workspace")).toBeDefined();
    expect(rail()).toBeNull();
    expect([savedRoster(), localStorage.getItem(signInHintKey), localStorage.getItem(savedThemeKey)]).toEqual([null, null, null]);
    expect(JSON.parse(localStorage.getItem(authEpochKey)!)).toMatchObject({ signedOut: true, logout: true, user: "one" });
    // Coming back to the page while that is on its way reads nothing more.
    const bootstraps = reads("GET /bootstrap").length;
    await advance(6_000);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(reads("GET /bootstrap")).toHaveLength(bootstraps);
    // The sign-in screen reads bootstrap only for the token the server's sign-out needs, and shows none of it.
    const logoutBefore = reads("POST /auth/logout").length;
    await answer("GET /bootstrap?roster=lean", 200, one);
    expect(reads("POST /auth/logout")).toHaveLength(logoutBefore + 1);
    expect(container.textContent).not.toMatch(/Ranch Hand|Sam Rivers/);
    expect(JSON.parse(localStorage.getItem(authEpochKey)!)).not.toHaveProperty("logout");
  });

  it("reads nothing as that account on a later page while the server's session may still be live", async () => {
    store(authEpochKey, { id: "offline", at: NOW - 60_000, signedOut: true, logout: true, user: "one" });
    // A later page: its own copy of every module, as a new page load has.
    vi.resetModules();
    const { App: FreshApp } = await import("../src/App");
    history.replaceState(null, "", "/");
    await act(async () => root.render(createElement(FreshApp)));
    expect(button("Enter local workspace")).toBeDefined();
    // The one bootstrap it makes ends the session; a failure leaves the mark for the next try.
    await answer("GET /bootstrap?roster=lean", 503, { error: "Hermes is restarting" });
    expect(reads("POST /auth/logout")).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(authEpochKey)!)).toMatchObject({ logout: true });
    expect(button("Enter local workspace")).toBeDefined();
  });

  it("is not offered while the app is still connecting", async () => {
    signedInAsOne();
    await open();
    expect(container.textContent).not.toContain("Sign out of this device");
  });
});

