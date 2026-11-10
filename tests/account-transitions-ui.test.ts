// @vitest-environment jsdom
import { act, createElement, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authEpochKey, draftKey, signInHintKey } from "../src/app/storage";
import { defaultPreferences, type Bootstrap, type Conversation } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { advance, mountRoot, stubMatchMedia, waitForUi } from "./ui-harness";

// Two tabs of one browser, each the whole app with its own copy of every module, as two tabs have.
// They share what tabs share: one localStorage, which tells the other tab about a write only through
// a storage event the test delivers late, out of order or not at all, and one cookie, which the fake
// server at fetch reads as each request goes out. A request the test did not configure is refused,
// and the test fails on it after it ends.
const NOW = Date.UTC(2026, 10, 10, 15);
const capabilities = Object.fromEntries(["chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration", "tools", "skills",
  "routines", "durableEvents", "idempotency", "imageGeneration", "stop", "portraitGeneration", "avatarMetadata"].map(key => [key, { supported: true }])) as Bootstrap["capabilities"];
type Member = "one" | "two";
const accounts: Record<Member, Bootstrap> = {
  one: {
    user: { id: "one", name: "Ada One", email: "ada@example.test" }, household: [], capabilities, connection: { connected: true }, csrfToken: "csrf-one",
    preferences: { ...defaultPreferences, startPage: "assistant", defaultBotId: "ranch" },
    bots: [{ id: "ranch", name: "Ranch Hand", shared: false, model: "test", activity: "idle" }, { id: "home", name: "Home", shared: true, model: "test", activity: "idle" }],
  },
  two: {
    user: { id: "two", name: "Bo Two", email: "bo@example.test" }, household: [], capabilities, connection: { connected: true }, csrfToken: "csrf-two",
    preferences: { ...defaultPreferences, startPage: "assistant", defaultBotId: "barn" },
    bots: [{ id: "barn", name: "Barn Cat", shared: false, model: "test", activity: "idle" }, { id: "home", name: "Home", shared: true, model: "test", activity: "idle" }],
  },
};
/** What only member one wrote or may see. None of it may be on screen, or in a request, once the browser changed accounts. */
const ONE = ["Ranch Hand", "Ada One", "ada@example.test", "Gate code is 4471", "Buy salt licks"];
const page = (botId: string, text: string): Conversation => ({
  botId, messages: [{ id: `${botId}-1`, role: "assistant", text }], approvals: [], files: [], activity: { state: "idle" },
});
const chats: Record<Member, Record<string, string>> = { one: { ranch: "Gate code is 4471", home: "One's home chat" }, two: { barn: "Barn door sticks", home: "Two's home chat" } };

// --- The browser's shared storage ---
type Queued = { key: string | null; oldValue: string | null; newValue: string | null };
const data = new Map<string, string>();
let queued: Queued[] = [];
let onWrite: ((key: string, value: string | null) => void) | undefined;
const record = (key: string | null, oldValue: string | null, newValue: string | null) => {
  queued.push({ key, oldValue, newValue });
  if (key) onWrite?.(key, newValue);
};
const methods: Partial<Storage> = {
  getItem: key => data.get(key) ?? null,
  setItem: (key, value) => { const old = data.get(key) ?? null; data.set(key, String(value)); record(key, old, String(value)); },
  removeItem: key => { const old = data.get(key) ?? null; if (data.delete(key)) record(key, old, null); },
  key: index => [...data.keys()][index] ?? null,
  clear: () => { data.clear(); record(null, null, null); },
};
const sharedStorage = new Proxy({} as Storage, {
  get(_, name) {
    if (name === "length") return data.size;
    if (typeof name === "symbol") return undefined;
    if (name in methods) return methods[name as keyof Storage];
    throw new Error(`The test's storage has no ${name}`);
  },
});
/** Delivers the storage events other tabs have not heard yet, as browsers do some time after the write. */
async function deliver(order: "in order" | "reversed" = "in order") {
  const events = order === "reversed" ? queued.reverse() : queued;
  queued = [];
  await act(async () => {
    for (const event of events) window.dispatchEvent(new StorageEvent("storage", event));
  });
  await advance(0);
}

// --- The server, which answers by the cookie each request carried ---
type Call = { call: string; cookie: Member | null; csrf: string | null; body: string };
let cookie: Member | null;
let calls: Call[];
let unexpected: string[];
type Held = { call: Call; answer(override?: { status: number; body: unknown }): void };
let held: Held[];
/** Requests that wait for the test to answer them, by "METHOD /path" prefix. */
let holding: string[];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const refused = json.bind(null, 401, { error: "Sign in required", code: "session_expired" });
function serve({ call, cookie: carried, csrf, body }: Call): Response {
  const path = call.replace(/^\w+ /, "").replace(/\?.*$/, "");
  const method = call.split(" ")[0];
  if (call === "GET /auth/config") return json(200, { localDevAuth: true });
  if (call === "POST /auth/local") {
    const member = JSON.parse(body).member as Member;
    cookie = member;
    return json(200, { user: accounts[member].user, csrfToken: accounts[member].csrfToken });
  }
  if (!carried) return refused();
  // The server checks a write's token against the session it carries.
  if (method !== "GET" && csrf !== accounts[carried].csrfToken) return json(403, { error: "Invalid CSRF token" });
  if (call === "POST /auth/logout") { cookie = null; return json(200, { ok: true }); }
  if (call === "GET /bootstrap?roster=lean") return json(200, accounts[carried]);
  const chat = /^\/bots\/([^/]+)\//.exec(path)?.[1];
  if (chat && !accounts[carried].bots.some(bot => bot.id === chat)) return json(404, { error: "Assistant not found" });
  if (method === "GET" && /^\/bots\/[^/]+\/conversation$/.test(path)) return json(200, page(chat!, chats[carried][chat!]));
  if (method === "GET" && /^\/bots\/[^/]+\/draft$/.test(path))
    return json(200, carried === "one" && chat === "ranch" ? { text: "Buy salt licks", attachments: [], revision: 1 } : null);
  if (method === "PUT" && /^\/bots\/[^/]+\/draft$/.test(path)) return json(200, { revision: 2 });
  if (method === "GET" && /^\/bots\/[^/]+\/routine-runs$/.test(path)) return json(200, { runs: [], unavailable: [] });
  const empty: Record<string, unknown> = {
    "GET /groups": { supported: false, canSend: false, rooms: [], reason: "Not in this test." },
    "GET /usage/accounts": { accounts: [], unavailableBots: [] },
    "GET /mac/devices": { available: false, reason: "Not in this test.", devices: [] },
    "PUT /devices/activity": {}, "PUT /bots/ranch/presence": {}, "PUT /bots/barn/presence": {}, "PUT /bots/home/presence": {},
  };
  if (`${method} ${path}` in empty) return json(200, empty[`${method} ${path}`]);
  unexpected.push(call);
  throw new TypeError(`Unexpected request ${call}`);
}
/** Answers the held requests, oldest first, each by the cookie it went out with unless told otherwise. */
async function answerHeld(match: string, override?: { status: number; body: unknown }) {
  const waiting = held.filter(item => item.call.call.startsWith(match));
  expect(waiting.length, `a held ${match} to answer`).toBeGreaterThan(0);
  held = held.filter(item => !waiting.includes(item));
  await act(async () => { for (const item of waiting) item.answer(override); });
  await advance(0);
}

// --- Tabs ---
type Tab = { container: HTMLDivElement; text(): string };
async function openTab(url = "/"): Promise<Tab> {
  // A fresh copy of every app module, so this tab's memory is its own.
  vi.resetModules();
  const { App } = await import("../src/App") as { App: ComponentType };
  const mount = mountRoot();
  history.replaceState(null, "", url);
  await mount.render(createElement(App));
  await advance(0);
  return { container: mount.container, text: () => mount.container.textContent ?? "" };
}
const showsNothingOf = (tab: Tab, member = ONE) => { for (const value of member) expect(tab.text()).not.toContain(value); };
/** Every request after `from` that used member one's session or content. */
const usedOne = (from: number) => calls.slice(from).filter(({ call, csrf, body }) =>
  csrf === "csrf-one" || call.includes("/ranch/") || ONE.some(value => body.includes(value)));
const button = (tab: Tab, text: string) => {
  const found = [...tab.container.querySelectorAll("button")].find(item => item.textContent?.trim() === text);
  expect(found, `a "${text}" button`).toBeDefined();
  return found!;
};
async function signInAs(tab: Tab, member: Member) {
  const select = tab.container.querySelector("select")!;
  await act(async () => {
    select.value = member;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button(tab, "Enter local workspace").click());
  await advance(0);
}
async function signOutFrom(tab: Tab) {
  await act(async () => tab.container.querySelector<HTMLButtonElement>('[aria-label="Account"]')!.click());
  await act(async () => [...tab.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === "Sign out")!.click());
  await waitForUi(() => expect(document.querySelector('[role="alertdialog"] button.danger')).not.toBeNull());
  await act(async () => document.querySelector<HTMLButtonElement>('[role="alertdialog"] button.danger')!.click());
  await advance(0);
}
const signedInAs = (member: Member, id = "earlier") => {
  data.set(authEpochKey, JSON.stringify({ id, at: NOW - 60_000, user: member }));
  data.set(signInHintKey, JSON.stringify({ until: NOW + 3_600_000, user: member, bots: accounts[member].bots.map(bot => bot.id) }));
  cookie = member;
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("localStorage", sharedStorage);
  stubMatchMedia();
  Object.assign(SVGElement.prototype, { getTotalLength: () => 100, getPointAtLength: (length: number) => ({ x: length, y: 0 }) });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  data.clear();
  queued = [];
  onWrite = undefined;
  cookie = null;
  calls = [];
  unexpected = [];
  held = [];
  holding = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, location.origin);
    const call: Call = {
      call: `${init.method ?? "GET"} ${url.pathname.replace(/^\/api/, "")}${url.search}`, cookie,
      csrf: new Headers(init.headers).get("X-CSRF-Token"), body: typeof init.body === "string" ? init.body : "",
    };
    calls.push(call);
    if (!holding.some(prefix => call.call.startsWith(prefix))) return serve(call);
    return new Promise<Response>((resolve, reject) => {
      held.push({ call, answer: override => {
        if (override) return resolve(json(override.status, override.body));
        try { resolve(serve(call)); } catch (error) { reject(error); }
      } });
    });
  }));
});
afterEach(() => {
  expect(unexpected).toEqual([]);
});

describe("an account change in one tab", () => {
  it("drops member one from a tab that shows them as soon as another tab starts signing member two in", async () => {
    // The reviewer's case: one tab still offers sign-in while another shows member one.
    const signInTab = await openTab();
    expect(button(signInTab, "Enter local workspace")).toBeDefined();
    signedInAs("one");
    holding = ["GET /bots/ranch/conversation", "POST /auth/local"];
    const oneTab = await openTab("/?bot=ranch");
    await answerHeld("GET /bots/ranch/conversation");
    expect(oneTab.text()).toContain("Gate code is 4471");
    // The chat reads again while the sign-in tab has heard nothing of member one.
    await act(async () => { FakeEventSource.notifyAll(); });
    let changeAt = -1;
    onWrite = (key, value) => { if (key === authEpochKey && changeAt < 0 && value?.includes('"changing"')) changeAt = calls.length; };
    await signInAs(signInTab, "two");
    expect(changeAt).toBeGreaterThanOrEqual(0);
    // The read made as member one answers after the change; nothing of it shows and the tab lets go of one.
    await answerHeld("GET /bots/ranch/conversation");
    showsNothingOf(oneTab);
    expect(oneTab.text()).toContain("Connecting to your household");
    // Member two's sign-in settles; its storage events reach the first tab late and in reverse.
    await answerHeld("POST /auth/local");
    expect(signInTab.text()).toContain("Barn Cat");
    await deliver("reversed");
    expect(oneTab.text()).toContain("Barn Cat");
    showsNothingOf(oneTab);
    showsNothingOf(signInTab);
    expect(usedOne(changeAt)).toEqual([]);
    // Every request since went out as member two, or before the cookie changed, as the sign-in itself.
    expect(calls.slice(changeAt).filter(call => call.cookie !== "two" && call.call !== "POST /auth/local" && call.call !== "GET /auth/config")).toEqual([]);
  });

  it("shows sign-in in a tab that shows member one when they sign out in another, and keeps none of their records", async () => {
    signedInAs("one");
    data.set(draftKey("one", "home"), JSON.stringify({ text: "Buy salt licks", attachments: [], dirty: true }));
    data.set(draftKey("two", "home"), JSON.stringify({ text: "Two's own note", attachments: [] }));
    const oneTab = await openTab("/?bot=ranch");
    const otherTab = await openTab("/?bot=home");
    expect(oneTab.text()).toContain("Gate code is 4471");
    await deliver();
    let changeAt = -1;
    onWrite = (key, value) => { if (key === authEpochKey && changeAt < 0 && value?.includes('"changing"')) changeAt = calls.length; };
    await signOutFrom(otherTab);
    expect(otherTab.text()).toContain("Enter local workspace");
    // The first tab has heard nothing yet; the next thing it does finds the change first.
    await act(async () => { FakeEventSource.notifyAll(); });
    await advance(0);
    showsNothingOf(oneTab);
    expect(oneTab.text()).toContain("Enter local workspace");
    await deliver("reversed");
    showsNothingOf(oneTab);
    expect(usedOne(changeAt).map(call => call.call)).toEqual(["POST /auth/logout"]);
    // Member one's content left the browser; another member's records and the record of the sign-out stay.
    expect([...data.keys()].sort()).toEqual([authEpochKey, draftKey("two", "home")].sort());
    expect(JSON.parse(data.get(authEpochKey)!)).toMatchObject({ signedOut: true, user: "one" });
  });

  it("discards member one's bootstrap that answers after the tab learned of the change", async () => {
    signedInAs("one");
    const oneTab = await openTab("/?bot=ranch");
    const otherTab = await openTab("/?bot=home");
    holding = ["GET /bootstrap"];
    // Both tabs read bootstrap again on focus, a few seconds after the last read.
    await advance(6_000);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    const bootstraps = held.length;
    expect(bootstraps).toBeGreaterThan(0);
    holding = [];
    await signOutFrom(otherTab);
    await deliver();
    expect(oneTab.text()).toContain("Enter local workspace");
    // Those reads went out as member one and answer now, as member one.
    await answerHeld("GET /bootstrap");
    showsNothingOf(oneTab);
    showsNothingOf(otherTab);
    expect(oneTab.text()).toContain("Enter local workspace");
  });

  it("drops member one from a page restored from the back-forward cache after a sign-out it never heard", async () => {
    signedInAs("one");
    const oneTab = await openTab("/?bot=ranch");
    const otherTab = await openTab("/?bot=home");
    await signOutFrom(otherTab);
    // A page in the back-forward cache hears no storage events; it is shown again later.
    queued = [];
    expect(oneTab.text()).toContain("Gate code is 4471");
    await act(async () => { window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
    await advance(0);
    showsNothingOf(oneTab);
    expect(oneTab.text()).toContain("Enter local workspace");
  });

  it("starts every tab again from bootstrap when the sign-in hint lapses, and shows sign-in once the server refuses", async () => {
    signedInAs("one");
    data.set(signInHintKey, JSON.stringify({ until: NOW + 600_000, user: "one", bots: ["ranch", "home"] }));
    const oneTab = await openTab("/?bot=ranch");
    const otherTab = await openTab("/?bot=home");
    expect(oneTab.text()).toContain("Gate code is 4471");
    let before = -1;
    onWrite = (key, value) => {
      if (key !== authEpochKey || before >= 0) return;
      before = calls.length;
      // The cookie lapses with the hint.
      cookie = null;
      expect(JSON.parse(value!)).toMatchObject({ user: "one" });
    };
    await advance(600_000);
    expect(before).toBeGreaterThanOrEqual(0);
    await deliver();
    showsNothingOf(oneTab);
    showsNothingOf(otherTab);
    expect(oneTab.text()).toContain("Enter local workspace");
    expect(otherTab.text()).toContain("Enter local workspace");
    expect(data.has(signInHintKey)).toBe(false);
    expect(usedOne(before)).toEqual([]);
  });
});

describe("what a tab holds when the account changes", () => {
  it("ignores a stream event that arrives after another tab signed out, and lets member one go", async () => {
    signedInAs("one");
    const tab = await openTab("/?bot=home");
    const stream = [...FakeEventSource.streams].find(item => item.url.startsWith("/api/bots/home/events"))!;
    await act(async () => stream.connect());
    await advance(0);
    expect(tab.text()).toContain("One's home chat");
    // Another tab signs out; this one has heard nothing when the stream speaks.
    data.set(authEpochKey, JSON.stringify({ id: "elsewhere", at: NOW, signedOut: true, user: "one" }));
    cookie = null;
    await act(async () => stream.emit("inflight", JSON.stringify({ botId: "home", message: { id: "live", role: "assistant", text: "Words for whoever is signed in now" },
      activity: { state: "working" }, toolCalls: [] })));
    await advance(5_000);
    expect(tab.text()).not.toContain("Words for whoever");
    showsNothingOf(tab, [...ONE, "One's home chat"]);
    expect(tab.text()).toContain("Enter local workspace");
  });
});

describe("the account record's guards", () => {
  it("lets a tab that dropped member one for a refused sign-in read them again, since the cookie never changed", async () => {
    const signInTab = await openTab();
    signedInAs("one");
    holding = ["POST /auth/local"];
    const oneTab = await openTab("/?bot=ranch");
    expect(oneTab.text()).toContain("Gate code is 4471");
    await signInAs(signInTab, "two");
    await deliver();
    showsNothingOf(oneTab);
    await answerHeld("POST /auth/local", { status: 403, body: { error: "This account is not in the household allowlist" } });
    expect(signInTab.text()).toContain("This account is not in the household allowlist");
    await deliver();
    expect(oneTab.text()).toContain("Gate code is 4471");
    expect(JSON.parse(data.get(authEpochKey)!)).toMatchObject({ id: "earlier", user: "one" });
  });

  it("waits for another tab's sign-in instead of reading, until that tab's mark is too old to be on its way", async () => {
    signedInAs("one");
    data.set(authEpochKey, JSON.stringify({ id: "abandoned", at: NOW - 10_000, changing: true, user: "one" }));
    const tab = await openTab();
    expect(tab.text()).toContain("Connecting to your household");
    expect(calls.filter(call => call.call !== "GET /auth/config")).toEqual([]);
    await advance(54_000);
    expect(calls).toEqual([]);
    await advance(1_000);
    expect(tab.text()).toContain("Ranch Hand");
  });

  it("treats a record it cannot read as a change, asking the server again rather than signing out", async () => {
    signedInAs("one");
    const tab = await openTab("/?bot=ranch");
    const before = calls.length;
    data.set(authEpochKey, "{not json");
    await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: authEpochKey, newValue: "{not json" })); });
    await advance(0);
    expect(calls.slice(before).map(call => call.call)).toContain("GET /bootstrap?roster=lean");
    expect(tab.text()).toContain("Ranch Hand");
    expect(tab.text()).not.toContain("Enter local workspace");
  });
});
