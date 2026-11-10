// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authEpochKey, draftKey, savedThemeKey, signInHintKey } from "../src/app/storage";
import { defaultPreferences, type Bootstrap, type Conversation } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { advance, mountRoot, stubMatchMedia, typeInto, waitForUi } from "./ui-harness";

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
let onRead: ((key: string) => void) | undefined;
/** Storage that refuses reads, as a profile that blocks site data does, or writes, as a full one does. */
let refusing: { read?: true; write?: true } = {};
const record = (key: string | null, oldValue: string | null, newValue: string | null) => {
  queued.push({ key, oldValue, newValue });
  if (key) onWrite?.(key, newValue);
};
const methods: Partial<Storage> = {
  getItem: key => {
    if (refusing.read) throw new DOMException("The operation is insecure.", "SecurityError");
    const value = data.get(key) ?? null;
    // After the read, as another tab's write that lands right after it would.
    onRead?.(key);
    return value;
  },
  setItem: (key, value) => {
    if (refusing.write) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    const old = data.get(key) ?? null; data.set(key, String(value)); record(key, old, String(value));
  },
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
  if (method === "POST" && /^\/bots\/[^/]+\/messages$/.test(path)) return json(200, { requestId: JSON.parse(body).requestId, status: "accepted", runId: "run-1" });
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

/** Answers the one held request that went out with `carried` as its cookie. */
async function answerSentAs(match: string, carried: Member | null, override?: { status: number; body: unknown }) {
  const found = held.filter(item => item.call.call.startsWith(match) && item.call.cookie === carried);
  expect(found, `one held ${match} sent as ${carried}`).toHaveLength(1);
  held = held.filter(item => item !== found[0]);
  await act(async () => found[0].answer(override));
  await advance(0);
}
// public/boot.js as the shell runs it, before the bundle: the browser's fetch, storage and window.
const runBoot = () => window.eval(readFileSync("public/boot.js", "utf8"));
const accountMenu = async (tab: Tab) => {
  await act(async () => tab.container.querySelector<HTMLButtonElement>('[aria-label="Account"]')!.click());
  return tab.container.querySelector('[role="menu"][aria-label="Account"]')?.textContent ?? "";
};

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
  window.__wildbotsStartup = undefined;
  queued = [];
  onWrite = undefined;
  onRead = undefined;
  refusing = {};
  // The document outlives each test's tabs, as a tab outlives the app it reloads.
  document.title = "WildBots";
  document.documentElement.dataset.theme = "system";
  delete document.documentElement.dataset.accountCovered;
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

  it("never sends a draft typed after another tab signed out, before this tab heard of it", async () => {
    signedInAs("one");
    const tab = await openTab("/?bot=home");
    const box = tab.container.querySelector("textarea")!;
    data.set(authEpochKey, JSON.stringify({ id: "elsewhere", at: NOW, signedOut: true, user: "one" }));
    cookie = null;
    const changeAt = calls.length;
    await typeInto(box, "Buy salt licks for the north pasture");
    await advance(1_000);
    expect(usedOne(changeAt)).toEqual([]);
    expect(calls.slice(changeAt).filter(call => call.call.startsWith("PUT"))).toEqual([]);
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

describe("the theme this device keeps", () => {
  it("goes with member one when another tab signs member two in, while the tab waits for two's bootstrap", async () => {
    const one = accounts.one;
    accounts.one = { ...one, preferences: { ...one.preferences, theme: "dark" } };
    try {
      const signInTab = await openTab();
      signedInAs("one");
      const oneTab = await openTab("/?bot=ranch");
      expect(document.documentElement.dataset.theme).toBe("dark");
      holding = ["GET /bootstrap"];
      await signInAs(signInTab, "two");
      await deliver();
      expect(oneTab.text()).toContain("Connecting to your household");
      expect(document.documentElement.dataset.theme).toBe("system");
      expect(data.has("agent-interface:theme")).toBe(false);
    } finally {
      accounts.one = one;
    }
  });
});

// The reviewer's case: boot.js applied member one's saved dark theme, correctly at that moment, then
// another tab's change finished before this page's bundle drew anything.
describe("the theme boot.js applied before the bundle", () => {
  it.each([
    ["member two's sign-in", { id: "two-settled", at: NOW, user: "two" }, "two"],
    ["a sign-out", { id: "one-gone", at: NOW, signedOut: true, user: "one" }, null],
  ] as const)("is gone from the first draw when %s finished meanwhile, and stays gone if bootstrap fails", async (_name, settled, now) => {
    signedInAs("one");
    data.set(savedThemeKey, JSON.stringify({ v: 1, user: "one", theme: "dark" }));
    holding = ["GET /bootstrap"];
    runBoot();
    expect(document.documentElement.dataset.theme).toBe("dark");
    // What the other tab's change leaves: a sign-in writes a hint that names no account yet, a sign-out none; neither keeps the theme.
    data.delete(savedThemeKey);
    if (now) data.set(signInHintKey, JSON.stringify({ until: NOW + 3_600_000, bots: [] }));
    else data.delete(signInHintKey);
    data.set(authEpochKey, JSON.stringify(settled));
    cookie = now;
    const tab = await openTab();
    expect(tab.text()).toContain("Connecting to your household");
    expect(document.documentElement.dataset.theme).toBe("system");
    // A bootstrap that fails names no one, so nothing else would ever replace the theme.
    await answerHeld("GET /bootstrap", { status: 503, body: { error: "Down for a moment" } });
    expect(document.documentElement.dataset.theme).toBe("system");
  });

  it("stays on the first draw while the hint still names its account and nothing changed", async () => {
    signedInAs("one");
    data.set(savedThemeKey, JSON.stringify({ v: 1, user: "one", theme: "dark" }));
    holding = ["GET /bootstrap"];
    runBoot();
    const tab = await openTab();
    expect(tab.text()).toContain("Connecting to your household");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("the read boot.js starts before the bundle", () => {
  it("is not shown when another tab signed member two in while the bundle loaded", async () => {
    // The reviewer's case: member one's early bootstrap is on its way when another tab signs two in.
    const signInTab = await openTab();
    signedInAs("one");
    holding = ["GET /bootstrap"];
    runBoot();
    expect(held.map(item => [item.call.call, item.call.cookie])).toEqual([["GET /bootstrap?roster=lean", "one"]]);
    // The read is on the first page's window, which the test's one window stands in for; the other tab never sees it.
    const early = window.__wildbotsStartup;
    window.__wildbotsStartup = undefined;
    await signInAs(signInTab, "two");
    await answerSentAs("GET /bootstrap", "two");
    expect(signInTab.text()).toContain("Barn Cat");
    // The first page's bundle arrives now, then member one's early answer.
    window.__wildbotsStartup = early;
    const firstTab = await openTab();
    await answerSentAs("GET /bootstrap", "two");
    await answerSentAs("GET /bootstrap", "one");
    expect(firstTab.text()).toContain("Barn Cat");
    showsNothingOf(firstTab);
    expect(await accountMenu(firstTab)).toContain("bo@example.test");
    showsNothingOf(firstTab);
  });

  it("is discarded when another tab starts a sign-in after the app took it, before it answered", async () => {
    signedInAs("one");
    holding = ["GET /bootstrap", "POST /auth/local"];
    runBoot();
    const firstTab = await openTab();
    // The app took the early read instead of asking: one bootstrap so far.
    expect(calls.filter(call => call.call.startsWith("GET /bootstrap"))).toHaveLength(1);
    data.set(authEpochKey, JSON.stringify({ id: "elsewhere", at: NOW, changing: true, user: "one" }));
    await answerSentAs("GET /bootstrap", "one");
    showsNothingOf(firstTab);
    expect(firstTab.text()).toContain("Connecting to your household");
  });

  it.each([
    ["is not started while another tab's sign-in is on its way", NOW - 64_000, 0],
    ["is started when the mark is older than any request could take", NOW - 65_000, 1],
  ])("%s", (_name, at, reads) => {
    signedInAs("one");
    data.set(authEpochKey, JSON.stringify({ id: "elsewhere", at, changing: true, user: "one" }));
    holding = ["GET /bootstrap"];
    runBoot();
    expect(held).toHaveLength(reads);
  });
});

// --- What the second review found ---

/** Member one's boot with changes for one test, put back after it. */
async function withOne<T>(patch: Partial<Bootstrap>, run: () => Promise<T>) {
  const saved = accounts.one;
  accounts.one = { ...saved, ...patch };
  try { return await run(); } finally { accounts.one = saved; }
}
/** Writes the record as another tab of this browser would, and delivers the storage event at once. */
async function elsewhere(record: object) {
  sharedStorage.setItem(authEpochKey, JSON.stringify(record));
  await deliver();
}
const root = document.documentElement;
const covered = () => root.hasAttribute("data-account-covered");
const pageTransition = (type: "pagehide" | "pageshow") =>
  act(async () => { window.dispatchEvent(new PageTransitionEvent(type, { persisted: true })); });
/** What the page holds the moment the browser fires `pageshow`, after the app's own listener and before React draws again. */
function atPageshow(tab: Tab) {
  const seen: { covered?: boolean; one?: boolean } = {};
  window.addEventListener("pageshow", () => { seen.covered = covered(); seen.one = tab.text().includes("Gate code is 4471"); }, { once: true });
  return seen;
}
// Member one's preferences and news, which the tab title, the app badge and the page's theme carry.
const oneWithNews = {
  preferences: { ...accounts.one.preferences, theme: "dark" as const },
  bots: [accounts.one.bots[0]!, { ...accounts.one.bots[1]!, activity: "waiting" as const }],
};

describe("a page in the back-forward cache", () => {
  it("covers the account as the page is put away, and gives it back as it was, before any frame, when the account is the same", async () => {
    await withOne(oneWithNews, async () => {
      signedInAs("one");
      const tab = await openTab("/?bot=ranch");
      const box = tab.container.querySelector("textarea")!;
      await typeInto(box, "Half a thought");
      expect(document.title).toBe("(1) WildBots");
      await pageTransition("pagehide");
      // The frozen page shows nothing of the account: no screens, no unread count, no theme.
      expect(covered()).toBe(true);
      expect(document.title).toBe("WildBots");
      expect(root.dataset.theme).toBe("system");
      // Nothing was unmounted, so nothing is lost.
      expect(tab.container.querySelector("textarea")).toBe(box);
      const before = calls.length;
      const seen = atPageshow(tab);
      await pageTransition("pageshow");
      expect(seen).toEqual({ covered: false, one: true });
      expect(tab.container.querySelector("textarea")).toBe(box);
      expect(box.value).toBe("Half a thought");
      expect(document.title).toBe("(1) WildBots");
      expect(root.dataset.theme).toBe("dark");
      expect(calls.slice(before).map(call => call.call)).not.toContain("GET /bootstrap?roster=lean");
    });
  });

  it("keeps the account covered when another tab signed out meanwhile, until sign-in has replaced it", async () => {
    signedInAs("one");
    const tab = await openTab("/?bot=ranch");
    await pageTransition("pagehide");
    // A page in the cache hears no storage events.
    sharedStorage.setItem(authEpochKey, JSON.stringify({ id: "elsewhere", at: NOW, signedOut: true, user: "one" }));
    queued = [];
    cookie = null;
    const seen = atPageshow(tab);
    await pageTransition("pageshow");
    await advance(0);
    // Member one's rows were still in the document when the page showed again, and covered.
    expect(seen).toEqual({ covered: true, one: true });
    expect(covered()).toBe(false);
    showsNothingOf(tab);
    expect(tab.text()).toContain("Enter local workspace");
  });
});

// The theme boot.js applied from this device, which the cover takes away and gives back. A restored page
// never runs boot.js again; only the cover and the app decide its theme.
describe("a page in the back-forward cache, in the theme boot.js applied", () => {
  it("comes back in member one's saved theme when it left before bootstrap answered, with the account unchanged", async () => {
    signedInAs("one");
    data.set(savedThemeKey, JSON.stringify({ v: 1, user: "one", theme: "dark" }));
    holding = ["GET /bootstrap"];
    runBoot();
    const tab = await openTab();
    expect([tab.text().includes("Connecting to your household"), root.dataset.theme]).toEqual([true, "dark"]);
    await pageTransition("pagehide");
    expect(root.dataset.theme).toBe("system");
    await pageTransition("pageshow");
    expect([covered(), root.dataset.theme]).toEqual([false, "dark"]);
  });

  it("shows none of member one's saved theme once restored after another tab signed member two in", async () => {
    await withOne(oneWithNews, async () => {
      signedInAs("one");
      const tab = await openTab("/?bot=ranch");
      expect(root.dataset.theme).toBe("dark");
      expect(JSON.parse(data.get(savedThemeKey)!)).toMatchObject({ user: "one", theme: "dark" });
      await pageTransition("pagehide");
      // Another tab signs member two in while this page is frozen, and its storage events never reach it.
      data.set(authEpochKey, JSON.stringify({ id: "two-changing", at: NOW, changing: true, user: "one" }));
      data.delete(savedThemeKey);
      data.set(signInHintKey, JSON.stringify({ until: NOW + 3_600_000, bots: [] }));
      cookie = "two";
      data.set(authEpochKey, JSON.stringify({ id: "two-settled", at: NOW, user: "two" }));
      queued = [];
      holding = ["GET /bootstrap"];
      // Every theme the page takes from the moment it shows again, including one a later commit replaces:
      // each record carries the value before its change, and the last value follows them.
      const changes: (string | null)[] = [];
      const observer = new MutationObserver(records => { for (const change of records) changes.push(change.oldValue); });
      const themes = () => [...changes, ...observer.takeRecords().map(change => change.oldValue), root.dataset.theme];
      window.addEventListener("pageshow", () => {
        observer.observe(root, { attributeFilter: ["data-theme"], attributeOldValue: true });
      }, { once: true, capture: true });
      await pageTransition("pageshow");
      await advance(0);
      expect([tab.text().includes("Connecting to your household"), covered(), root.dataset.theme]).toEqual([true, false, "system"]);
      await answerHeld("GET /bootstrap");
      expect(tab.text()).toContain("Barn Cat");
      const seen = themes();
      observer.disconnect();
      expect(seen[0]).toBe("system");
      expect(seen).not.toContain("dark");
    });
  });
});

describe("the address after a change", () => {
  it("opens member two's own chat, not the one member one was at, when another tab signs member two in", async () => {
    signedInAs("one");
    const tab = await openTab("/?bot=home#latest");
    expect(tab.text()).toContain("One's home chat");
    // Another tab marks its sign-in as under way, then settles it; each event arrives on its own.
    await elsewhere({ id: "two-changing", at: NOW, changing: true, user: "one" });
    expect(tab.text()).toContain("Connecting to your household");
    cookie = "two";
    await elsewhere({ id: "two-settled", at: NOW, user: "two" });
    expect(tab.text()).toContain("Barn door sticks");
    expect(tab.text()).not.toContain("Two's home chat");
    expect(new URLSearchParams(location.search).get("bot")).toBe("barn");
    expect(location.hash).toBe("");
  });

  it("leaves no address of member one's on the sign-in screen when they sign out in another tab", async () => {
    signedInAs("one");
    // Only a fragment, so the test sees it go on its own.
    const tab = await openTab("/#ranch-1");
    await elsewhere({ id: "one-leaving", at: NOW, changing: true, user: "one" });
    cookie = null;
    await elsewhere({ id: "one-gone", at: NOW, signedOut: true, user: "one" });
    expect(tab.text()).toContain("Enter local workspace");
    expect(location.search).toBe("");
    expect(location.hash).toBe("");
  });

  it("keeps member one's address, open chat and fragment when another tab's sign-in fails and puts the record back", async () => {
    signedInAs("one");
    const before = data.get(authEpochKey)!;
    const tab = await openTab("/?bot=ranch#latest");
    expect(tab.text()).toContain("Gate code is 4471");
    await elsewhere({ id: "two-changing", at: NOW, changing: true, user: "one" });
    expect(tab.text()).toContain("Connecting to your household");
    sharedStorage.setItem(authEpochKey, before);
    await deliver();
    expect(tab.text()).toContain("Gate code is 4471");
    expect(location.search).toBe("?bot=ranch");
    expect(location.hash).toBe("#latest");
  });

  it("drops an address member one opened while still connecting, so member two never lands in a chat both can open", async () => {
    signedInAs("one");
    holding = ["GET /bootstrap", "GET /bots/home/"];
    // Home is shared, so member two could open it too; the fragment names member one's message.
    const tab = await openTab("/?bot=home#home-1");
    expect(tab.text()).toContain("Connecting to your household");
    await elsewhere({ id: "one-leaving", at: NOW, changing: true, user: "one" });
    cookie = null;
    await elsewhere({ id: "one-gone", at: NOW, signedOut: true, user: "one" });
    expect(tab.text()).toContain("Enter local workspace");
    expect(location.search).toBe("");
    expect(location.hash).toBe("");
    holding = [];
    await signInAs(tab, "two");
    expect(tab.text()).toContain("Barn door sticks");
    expect(tab.text()).not.toContain("Two's home chat");
    expect(location.hash).toBe("");
    // Member one's bootstrap and chat read never answer this tab: it let them go.
    held = [];
  });

  it("drops a fragment alone that member one's page opened with, when they sign out before it connects", async () => {
    signedInAs("one");
    holding = ["GET /bootstrap"];
    const tab = await openTab("/#ranch-1");
    expect(tab.text()).toContain("Connecting to your household");
    await elsewhere({ id: "one-leaving", at: NOW, changing: true, user: "one" });
    cookie = null;
    await elsewhere({ id: "one-gone", at: NOW, signedOut: true, user: "one" });
    expect(tab.text()).toContain("Enter local workspace");
    expect(location.pathname + location.search).toBe("/");
    expect(location.hash).toBe("");
    held = [];
  });

  it("drops member one's address from a page that opened while another tab was signing them out", async () => {
    signedInAs("one");
    data.set(authEpochKey, JSON.stringify({ id: "one-leaving", at: NOW, changing: true, user: "one" }));
    const tab = await openTab("/?bot=ranch#ranch-1");
    expect(tab.text()).toContain("Connecting to your household");
    cookie = null;
    await elsewhere({ id: "one-gone", at: NOW, signedOut: true, user: "one" });
    expect(tab.text()).toContain("Enter local workspace");
    expect(location.search).toBe("");
    expect(location.hash).toBe("");
  });

  it("keeps the address of the account a bootstrap named when the record had not, once the same account is put back", async () => {
    // A sign-in whose answer named no account leaves the record without one until bootstrap names it.
    signedInAs("one");
    data.set(authEpochKey, JSON.stringify({ id: "unnamed", at: NOW - 60_000 }));
    const tab = await openTab("/?bot=ranch#latest");
    expect(tab.text()).toContain("Gate code is 4471");
    const named = data.get(authEpochKey)!;
    expect(JSON.parse(named)).toMatchObject({ user: "one" });
    await elsewhere({ id: "two-changing", at: NOW, changing: true, user: "one" });
    sharedStorage.setItem(authEpochKey, named);
    await deliver();
    expect(tab.text()).toContain("Gate code is 4471");
    expect(location.search).toBe("?bot=ranch");
    expect(location.hash).toBe("#latest");
  });

  it("keeps an address the person opened while signed out, which named no account's chat yet", async () => {
    const tab = await openTab("/?bot=home");
    await signInAs(tab, "two");
    expect(tab.text()).toContain("Two's home chat");
    expect(new URLSearchParams(location.search).get("bot")).toBe("home");
  });

  // Fourth review, P3: a page that opens while another tab signs in from signed out keeps its address,
  // as one opened a moment earlier would.
  it("keeps an address the person opened while another tab was signing in from signed out, once that sign-in names member two", async () => {
    // The mark a sign-in writes when no account was signed in.
    data.set(authEpochKey, JSON.stringify({ id: "two-changing", at: NOW, changing: true, fromSignedOut: true }));
    const tab = await openTab("/?bot=home#home-1");
    expect(tab.text()).toContain("Connecting to your household");
    cookie = "two";
    await elsewhere({ id: "two-settled", at: NOW, user: "two" });
    expect(new URLSearchParams(location.search).get("bot")).toBe("home");
    expect(location.hash).toBe("#home-1");
    expect(tab.text()).toContain("Two's home chat");
  });

  it("keeps an address the person opened while signed out when another tab signs member two in", async () => {
    const tab = await openTab("/?bot=home#home-1");
    expect(tab.text()).toContain("Enter local workspace");
    await elsewhere({ id: "two-changing", at: NOW, changing: true });
    cookie = "two";
    await elsewhere({ id: "two-settled", at: NOW, user: "two" });
    expect(tab.text()).toContain("Two's home chat");
    expect(new URLSearchParams(location.search).get("bot")).toBe("home");
    expect(location.hash).toBe("#home-1");
  });
});

describe("the screen between two accounts", () => {
  it("shows neither member one's unread count, app badge nor theme while another tab's sign-in is on its way", async () => {
    const setAppBadge = vi.fn(async () => {}), clearAppBadge = vi.fn(async () => {});
    Object.defineProperties(navigator, { setAppBadge: { configurable: true, value: setAppBadge }, clearAppBadge: { configurable: true, value: clearAppBadge } });
    try {
      await withOne(oneWithNews, async () => {
        signedInAs("one");
        const tab = await openTab("/?bot=ranch");
        expect(document.title).toBe("(1) WildBots");
        expect(root.dataset.theme).toBe("dark");
        expect(setAppBadge).toHaveBeenLastCalledWith(1);
        const cleared = clearAppBadge.mock.calls.length;
        await elsewhere({ id: "two-changing", at: NOW, changing: true, user: "one" });
        expect(tab.text()).toContain("Connecting to your household");
        expect(document.title).toBe("WildBots");
        expect(root.dataset.theme).toBe("system");
        expect(clearAppBadge.mock.calls.length).toBeGreaterThan(cleared);
      });
    } finally {
      for (const name of ["setAppBadge", "clearAppBadge"]) Reflect.deleteProperty(navigator, name);
    }
  });

  it("starts a tab that waited on a mark gone stale while it slept as soon as it wakes, without its own timer", async () => {
    signedInAs("one");
    data.set(authEpochKey, JSON.stringify({ id: "abandoned", at: NOW - 10_000, changing: true, user: "one" }));
    const tab = await openTab();
    expect(tab.text()).toContain("Connecting to your household");
    // The tab slept: the clock moved on and its timer, throttled, has not run.
    vi.setSystemTime(NOW + 56_000);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(calls.map(call => call.call)).toContain("GET /bootstrap?roster=lean");
    await waitForUi(() => expect(tab.text()).toContain("Ranch Hand"));
  });
});

describe("the record's other guards", () => {
  it("lets another tab's settled sign-in stand when a refused sign-in puts the record back at that moment", async () => {
    // The browser's lock manager: one holder of a name at a time, the others in the order they asked.
    let queue = Promise.resolve();
    const request = vi.fn((name: string, callback: () => unknown) => {
      if (name !== authEpochKey) throw new Error(`The test's locks have no ${name}`);
      const run = queue.then(callback);
      queue = run.then(() => {}, () => {});
      return run;
    });
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    try {
      signedInAs("one");
      // Two tabs' copies of the module, with no app drawn, so only the record is in play.
      vi.resetModules();
      const first = await import("../src/app/account-epoch");
      vi.resetModules();
      const second = await import("../src/app/account-epoch");
      const signingTwo = await second.beginAccountChange();
      const refused = await first.beginAccountChange();
      // As the refused sign-in reads the record to put it back, the other tab's sign-in settles.
      let settling: Promise<void> | undefined, planted = false;
      onRead = key => {
        if (key !== authEpochKey || planted) return;
        planted = true;
        settling = signingTwo.settle({ user: "two" });
      };
      await refused.undo();
      onRead = undefined;
      await settling;
      const now = JSON.parse(data.get(authEpochKey)!);
      expect(now).toMatchObject({ user: "two" });
      expect(now).not.toHaveProperty("changing");
    } finally {
      Reflect.deleteProperty(navigator, "locks");
    }
  });

  it("asks the server when the record is in a format it cannot read, and writes its own once the server names the account", async () => {
    // A newer release's record. Treated as a settled change, never as one under way, so a record this
    // code cannot read can never hold a tab on the connecting screen.
    signedInAs("one");
    data.set(authEpochKey, JSON.stringify({ format: 2, epoch: "from a newer release" }));
    const tab = await openTab("/?bot=ranch");
    expect(tab.text()).toContain("Gate code is 4471");
    // Every tab, of either release, then sees one change and asks the server, which names the same account.
    expect(JSON.parse(data.get(authEpochKey)!)).toMatchObject({ user: "one" });
  });

  it("shows the account the server names, and drops it at its own sign-out, when storage refuses every read", async () => {
    signedInAs("one");
    refusing = { read: true };
    const tab = await openTab("/?bot=ranch");
    expect(tab.text()).toContain("Gate code is 4471");
    await signOutFrom(tab);
    showsNothingOf(tab);
    expect(tab.text()).toContain("Enter local workspace");
  });

  it("drops member one at its own sign-out when storage refuses every write, though it cannot tell other tabs", async () => {
    signedInAs("one");
    const tab = await openTab("/?bot=ranch");
    refusing = { write: true };
    await signOutFrom(tab);
    showsNothingOf(tab);
    expect(tab.text()).toContain("Enter local workspace");
    // Nothing after the sign-out went as member one, and the tab asked the server once, not forever.
    const logout = calls.findIndex(call => call.call === "POST /auth/logout");
    expect(usedOne(logout).map(call => call.call)).toEqual(["POST /auth/logout"]);
    await advance(5_000);
    expect(calls.slice(logout).filter(call => call.call.startsWith("GET /bootstrap")).length).toBeLessThanOrEqual(1);
  });
});

describe("several tabs and work in flight", () => {
  it("takes member two's sign-in into two other tabs that show member one, with their events late and reversed", async () => {
    const signInTab = await openTab();
    signedInAs("one");
    const ranchTab = await openTab("/?bot=ranch");
    const homeTab = await openTab("/?bot=home");
    expect(ranchTab.text()).toContain("Ranch Hand");
    expect(homeTab.text()).toContain("One's home chat");
    let changeAt = -1;
    onWrite = (key, value) => { if (key === authEpochKey && changeAt < 0 && value?.includes('"changing"')) changeAt = calls.length; };
    await signInAs(signInTab, "two");
    await deliver("reversed");
    for (const tab of [signInTab, ranchTab, homeTab]) {
      expect(tab.text()).toContain("Barn Cat");
      showsNothingOf(tab, [...ONE, "One's home chat"]);
    }
    expect(usedOne(changeAt)).toEqual([]);
  });

  it("lets go of an upload and a send in flight for member one when another tab signs member two in", async () => {
    // An upload goes by XMLHttpRequest. Each one here waits for the test and records the cookie it carried.
    const uploads: { cookie: Member | null; aborted: boolean; onabort?: () => void; onload?: () => void; status: number; responseText: string }[] = [];
    vi.stubGlobal("XMLHttpRequest", class {
      upload = {};
      status = 0;
      responseText = "";
      onabort?: () => void;
      onload?: () => void;
      aborted = false;
      cookie = cookie;
      open(method: string, url: string) { if (method !== "POST" || url !== "/api/bots/home/uploads") throw new Error(`Unexpected upload ${method} ${url}`); }
      setRequestHeader() {}
      send() { uploads.push(this); }
      abort() { this.aborted = true; this.onabort?.(); }
    });
    signedInAs("one");
    holding = ["POST /bots/ranch/messages"];
    const tab = await openTab("/?bot=ranch");
    await typeInto(tab.container.querySelector("textarea")!, "Gate needs salt licks");
    await act(async () => tab.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    await advance(0);
    expect(held.map(item => item.call.call)).toEqual(["POST /bots/ranch/messages"]);
    // A chat with a send on its way takes no files, so the upload is in another chat.
    await act(async () => [...tab.container.querySelectorAll<HTMLButtonElement>("button.bot-item")].find(item => item.textContent?.includes("Home"))!.click());
    await advance(0);
    expect(tab.text()).toContain("One's home chat");
    const input = tab.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["north fence"], "fence.txt", { type: "text/plain" })] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await advance(0);
    expect(uploads).toHaveLength(1);
    const changeAt = calls.length;
    await elsewhere({ id: "two-changing", at: NOW, changing: true, user: "one" });
    // The upload was let go with the generation that started it.
    expect(uploads[0]!.aborted).toBe(true);
    cookie = "two";
    await elsewhere({ id: "two-settled", at: NOW, user: "two" });
    // The send that went out as member one answers now, as member one; nothing of it shows or follows it.
    await answerHeld("POST /bots/ranch/messages");
    await advance(5_000);
    expect(tab.text()).toContain("Barn door sticks");
    showsNothingOf(tab, [...ONE, "Gate needs salt licks", "fence.txt"]);
    expect(calls.slice(changeAt).filter(call => call.cookie === "one" || call.call.includes("/ranch/") || call.body.includes("Gate needs salt licks"))).toEqual([]);
    expect(uploads).toHaveLength(1);
  });

  it("never sends member one's leaving reports as anyone, from the screens a change unmounts", async () => {
    // The old screens unmount in a commit of their own, while this tab still acts under the old record,
    // so any request their cleanup makes is refused. Presence and device activity are also fenced by
    // generation, so this goes red only when both guards are gone; see the ledger.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const signInTab = await openTab();
    signedInAs("one");
    const tab = await openTab("/?bot=ranch");
    await advance(0);
    expect(calls.map(call => call.call)).toEqual(expect.arrayContaining(["PUT /devices/activity", "PUT /bots/ranch/presence"]));
    let changeAt = -1;
    onWrite = (key, value) => { if (key === authEpochKey && changeAt < 0 && value?.includes('"changing"')) changeAt = calls.length; };
    await signInAs(signInTab, "two");
    await deliver();
    expect(tab.text()).toContain("Barn Cat");
    expect(calls.slice(changeAt).filter(call => call.call === "PUT /bots/ranch/presence" || call.call === "PUT /devices/activity" && call.body.includes('"inactive"'))).toEqual([]);
  });
});

describe("what the service worker is told", () => {
  it("tells the worker the account again after another tab told it none and closed before its sign-out settled", async () => {
    // The page's side of the worker. Nothing else of it is configured, so anything else throws.
    const told: unknown[] = [];
    const registration = {
      active: { postMessage: (message: { type: string; user: unknown }) => { if (message.type !== "ACCOUNT") throw new Error(`Unexpected message ${message.type}`); told.push(message.user); } },
    };
    // The app also listens for the worker's messages, which this test never sends.
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
      getRegistration: async () => registration, controller: null, addEventListener() {}, removeEventListener() {},
    } });
    try {
      signedInAs("one");
      const tab = await openTab("/?bot=ranch");
      expect(tab.text()).toContain("Gate code is 4471");
      expect(told).toEqual(["one"]);
      // Another tab starts a sign-out, tells the worker no one is signed in, and closes before it settles.
      await elsewhere({ id: "abandoned", at: NOW, changing: true, user: "one" });
      told.push(null);
      expect(tab.text()).toContain("Connecting to your household");
      // Its mark goes stale; the cookie never changed, and this tab reads member one again.
      await advance(65_000);
      await waitForUi(() => expect(tab.text()).toContain("Gate code is 4471"));
      expect(told.at(-1)).toBe("one");
    } finally {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
  });
});
