// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { clearResponseCache } from "../src/client-api";
import { defaultPreferences, type Bootstrap, type Conversation } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { advance, click, mountRoot, stubMatchMedia, typeInto } from "./ui-harness";

// The app runs whole, through the real client API, against a fake server at fetch. A request the
// test did not configure is recorded and refused, and the test fails on it after it ends.
const bootstrap: Bootstrap = {
  user: { id: "one", name: "One", email: "one@example.test" },
  household: [],
  preferences: { ...defaultPreferences, startPage: "assistant", defaultBotId: "home", sections: [{ id: "barn", name: "Barn", botIds: [] }] },
  bots: [
    { id: "home", name: "Home", shared: true, model: "test", activity: "idle" },
    { id: "ranch", name: "Ranch Hand", shared: true, model: "test", activity: "idle" },
  ],
  capabilities: Object.fromEntries(["chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration", "tools", "skills",
    "routines", "durableEvents", "idempotency", "imageGeneration", "stop", "portraitGeneration", "avatarMetadata"].map(key => [key, { supported: true }])) as Bootstrap["capabilities"],
  connection: { connected: true },
  csrfToken: "csrf",
};
const page = (botId: string): Conversation => ({
  botId, messages: [{ id: `${botId}-1`, role: "assistant", text: `${botId} says howdy` }], approvals: [], files: [], activity: { state: "idle" },
});

let root: Root, container: HTMLDivElement, calls: string[], unexpected: string[], bodies: Record<string, unknown[]>;
// This page's controlling worker, and the container the page hears it on.
const controller = { scriptURL: "http://localhost:3000/sw.js" };
const workers = Object.assign(new EventTarget(), { controller: controller as object | null, getRegistration: async () => undefined, ready: new Promise(() => {}) });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(async () => {
  vi.useFakeTimers();
  // Module state outlives a test: each one starts as a fresh page would.
  clearResponseCache();
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia();
  // Browser APIs jsdom lacks, which the real app uses: SVG geometry for the avatar's shape,
  // visibility to pause it offscreen, and modal dialogs.
  Object.assign(SVGElement.prototype, { getTotalLength: () => 100, getPointAtLength: (length: number) => ({ x: length, y: 0 }) });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  for (const [name, opened] of [["showModal", true], ["close", false]] as const)
    Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, value: function(this: HTMLDialogElement) { this.open = opened; } });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: workers });
  workers.controller = controller;
  history.replaceState(null, "", "/?bot=home");
  calls = [];
  unexpected = [];
  bodies = {};
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, location.origin);
    const call = `${init.method ?? "GET"} ${url.pathname.replace(/^\/api/, "")}${url.search}`;
    calls.push(call);
    if (typeof init.body === "string") (bodies[call] ??= []).push(JSON.parse(init.body));
    const chat = /^GET \/bots\/([^/]+)\/conversation\?/.exec(call)?.[1];
    if (chat) return json(page(chat));
    // What else the open app reads, empty: these tests look at what opens.
    const empty: Record<string, unknown> = {
      "GET /bootstrap?roster=lean": bootstrap,
      "GET /groups": { supported: false, canSend: false, rooms: [], reason: "Not in this test." },
      "GET /routines": [],
      "GET /today": { generatedAt: "2026-11-09T15:00:00Z", frontier: "0", hasMore: false, since: "2026-11-08T15:00:00Z", items: [], events: [], unavailableBots: [] },
      "GET /usage/accounts": { accounts: [], unavailableBots: [] },
      "GET /mac/devices": { available: false, reason: "Not in this test.", devices: [] },
    };
    if (call in empty) return json(empty[call]);
    if (/^GET \/bots\/[^/]+\/(draft|routines\/[^/]+\/results.*)$/.test(call)) return json(null);
    if (/^GET \/bots\/[^/]+\/routine-runs$/.test(call)) return json({ runs: [], unavailable: [] });
    if (call === "PATCH /preferences") return json((bodies[call]!.at(-1) as object));
    // Reading reports, which these tests do not inspect.
    if (/^PUT \/(bots\/[^/]+\/presence|devices\/activity)$/.test(call)) return json({});
    if (/^PUT \/bots\/[^/]+\/read-position$/.test(call)) return json(bodies[call]!.at(-1));
    unexpected.push(call);
    throw new TypeError(`Unexpected request ${call}`);
  }));
  ({ container, root } = mountRoot());
  await act(async () => root.render(createElement(App)));
  await advance(0);
});

afterEach(() => {
  expect(unexpected).toEqual([]);
});

/** The worker's message, as navigator.serviceWorker delivers it, with the port it waits on for an answer. */
async function hear(data: unknown, source: object | null = controller) {
  const answer = vi.fn();
  const event = Object.assign(new Event("message"), { data, source, origin: location.origin, ports: [{ postMessage: answer }] });
  await act(async () => { workers.dispatchEvent(event); });
  await advance(0);
  return answer;
}
const header = () => container.querySelector(".chat-header h1, .chat-header h2")?.textContent ?? "";
const transcript = () => container.querySelector(".transcript")?.textContent ?? "";
const settled = () => act(async () => { await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(0); });

describe("a notification tapped while the app is open", () => {
  it("switches to the chat in place and tells the worker it did", async () => {
    expect(transcript()).toContain("home says howdy");
    // A marker on the window proves nothing reloaded it.
    (window as unknown as { sameDocument: boolean }).sameDocument = true;
    const answer = await hear({ type: "OPEN_CHAT", url: "http://localhost:3000/?bot=ranch" });
    expect(answer).toHaveBeenCalledExactlyOnceWith({ opened: true });
    expect(transcript()).toContain("ranch says howdy");
    expect(header()).toContain("Ranch Hand");
    expect(new URLSearchParams(location.search).get("bot")).toBe("ranch");
    expect((window as unknown as { sameDocument?: boolean }).sameDocument).toBe(true);
  });

  it("opens a link to a message at that message, as a search result does", async () => {
    await hear({ type: "OPEN_CHAT", url: "/?bot=ranch&message=ranch-1" });
    expect(calls).toContain("GET /bots/ranch/conversation?start=ranch-1");
  });

  it("opens a routine's results over its chat", async () => {
    await hear({ type: "OPEN_CHAT", url: "/?bot=ranch&routine=morning%20check" });
    await settled();
    expect(new URLSearchParams(location.search).get("routine")).toBe("morning check");
    expect(transcript()).toContain("ranch says howdy");
  });

  it("opens Today for a digest", async () => {
    await hear({ type: "OPEN_CHAT", url: "/?view=today" });
    expect(new URLSearchParams(location.search).get("view")).toBe("today");
  });

  it.each([
    ["another worker", { type: "OPEN_CHAT", url: "/?bot=ranch" }, {}],
    ["no source", { type: "OPEN_CHAT", url: "/?bot=ranch" }, null],
    ["another message type", { type: "WARM", url: "/?bot=ranch" }, controller],
    ["no address", { type: "OPEN_CHAT" }, controller],
    ["an address that is not text", { type: "OPEN_CHAT", url: ["/?bot=ranch"] }, controller],
    ["another origin", { type: "OPEN_CHAT", url: "https://elsewhere.example/?bot=ranch" }, controller],
    ["another page", { type: "OPEN_CHAT", url: "/native/terminal?bot=ranch" }, controller],
    ["no chat", { type: "OPEN_CHAT", url: "/?routine=morning" }, controller],
    ["no data", undefined, controller],
  ])("ignores a message from %s, leaving it unanswered", async (_name, data, source) => {
    const answer = await hear(data, source);
    expect(answer).not.toHaveBeenCalled();
    expect(transcript()).toContain("home says howdy");
    expect(calls.filter(path => path.includes("/bots/ranch/"))).toEqual([]);
  });

  it("ignores a message without a source when no worker controls the page", async () => {
    workers.controller = null;
    const answer = await hear({ type: "OPEN_CHAT", url: "/?bot=ranch" }, null);
    expect(answer).not.toHaveBeenCalled();
    expect(transcript()).toContain("home says howdy");
  });
});

describe("a notification tapped over unsaved work", () => {
  const settingsDialog = () => container.querySelector<HTMLDialogElement>(".settings-dialog");
  /** Starts a new assistant and types a name, so the form has something to lose. */
  async function editNewAssistant() {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="New assistant"], [aria-label="New"]')!.click());
    const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(entry => entry.textContent?.includes("New assistant"));
    if (item) await act(async () => item.click());
    await settled();
    const name = settingsDialog()!.querySelector<HTMLInputElement>("input:not([type]), input[type=text]")!;
    await typeInto(name, "Fence Rider");
    return name;
  }

  it("asks before discarding an edited assistant, and opens nothing when the person keeps editing", async () => {
    const name = await editNewAssistant();
    const answer = await hear({ type: "OPEN_CHAT", url: "/?bot=ranch" });
    // The page took the message, so the worker does not reload it over the form.
    expect(answer).toHaveBeenCalledExactlyOnceWith({ opened: true });
    expect(settingsDialog()?.textContent).toContain("Discard your unsaved changes?");
    expect(transcript()).toContain("home says howdy");
    await click("Keep editing");
    expect(settingsDialog()!.open).toBe(true);
    expect(name.value).toBe("Fence Rider");
    expect(transcript()).toContain("home says howdy");
    expect(calls.filter(call => call.includes("/bots/ranch/"))).toEqual([]);
  });

  it("opens the chat once the person discards", async () => {
    await editNewAssistant();
    await hear({ type: "OPEN_CHAT", url: "/?bot=ranch" });
    await click("Discard changes");
    await advance(0);
    expect(settingsDialog()).toBeNull();
    expect(transcript()).toContain("ranch says howdy");
  });

  it("does not open the chat later, when the person closes the form after keeping it", async () => {
    await editNewAssistant();
    await hear({ type: "OPEN_CHAT", url: "/?bot=ranch" });
    await click("Keep editing");
    await act(async () => settingsDialog()!.querySelector<HTMLButtonElement>('[aria-label="Close assistant settings"]')!.click());
    await click("Discard changes");
    await advance(0);
    expect(settingsDialog()).toBeNull();
    expect(transcript()).toContain("home says howdy");
  });

  it("opens the chat at once after the person has already discarded an edited assistant", async () => {
    await editNewAssistant();
    await act(async () => settingsDialog()!.querySelector<HTMLButtonElement>('[aria-label="Close assistant settings"]')!.click());
    await click("Discard changes");
    await hear({ type: "OPEN_CHAT", url: "/?bot=ranch" });
    expect(transcript()).toContain("ranch says howdy");
  });

  async function renameSection(name: string) {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Account"]')!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.startsWith("Settings"))!.click());
    await settled();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".settings-sheet button")].find(item => item.textContent?.includes("Barn"))!.click());
    await typeInto(document.querySelector<HTMLInputElement>('[aria-label="Section name"]')!, name);
  }

  it("keeps a section name typed in Settings, as closing Settings does, then opens the chat", async () => {
    await renameSection("North barn");
    await hear({ type: "OPEN_CHAT", url: "/?bot=ranch" });
    await advance(1_000);
    expect(bodies["PATCH /preferences"]?.at(-1)).toMatchObject({ sections: [{ id: "barn", name: "North barn" }] });
    expect(document.querySelector(".settings-sheet")).toBeNull();
    expect(transcript()).toContain("ranch says howdy");
  });

  it("leaves Settings open with its reason when the typed section name cannot be kept, and opens nothing", async () => {
    await renameSection("   ");
    const answer = await hear({ type: "OPEN_CHAT", url: "/?bot=ranch" });
    expect(answer).toHaveBeenCalledExactlyOnceWith({ opened: true });
    expect(document.querySelector(".settings-sheet [role=alert]")?.textContent).toBe("Enter a section name.");
    expect(bodies["PATCH /preferences"]).toBeUndefined();
    expect(transcript()).toContain("home says howdy");
  });
});
