// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api } from "../src/client-api";
import { defaultPreferences, type Bootstrap, type Conversation } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { advance, mountRoot, stubMatchMedia } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async original => ({
  ...await original<typeof import("../src/client-api")>(),
  api: vi.fn(),
  write: vi.fn().mockResolvedValue({}),
  clearResponseCache: vi.fn(),
}))(original)));
// Presence heartbeats and device activity have their own tests; here they would add requests to the count.
vi.mock("../src/app/use-chat-presence", () => ({ useChatPresence: () => {} }));
vi.mock("../src/app/use-device-activity", () => ({ useDeviceActivity: () => {} }));
vi.mock("../src/components/Avatar", async original => ({ ...await original<typeof import("../src/components/Avatar")>(), Avatar: () => null }));

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
const page = (botId: string): Conversation => ({
  botId, messages: [{ id: `${botId}-1`, role: "assistant", text: `${botId} says howdy` }], approvals: [], files: [], activity: { state: "idle" },
});

let root: Root, container: HTMLDivElement, calls: string[];
// This page's controlling worker, and the container the page hears it on.
const controller = { scriptURL: "http://localhost:3000/sw.js" };
const workers = Object.assign(new EventTarget(), { controller: controller as object | null, getRegistration: async () => undefined, ready: new Promise(() => {}) });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia();
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: workers });
  workers.controller = controller;
  history.replaceState(null, "", "/?bot=home");
  calls = [];
  vi.mocked(api).mockImplementation(async <T>(path: string) => {
    calls.push(path);
    if (path === "/bootstrap?roster=lean") return bootstrap as T;
    const chat = /^\/bots\/([^/]+)\/conversation\?/.exec(path)?.[1];
    return (chat ? page(chat) : null) as T;
  });
  ({ container, root } = mountRoot());
  await act(async () => root.render(createElement(App)));
  await advance(0);
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
    expect(calls).toContain("/bots/ranch/conversation?start=ranch-1");
  });

  it("opens a routine's results over its chat", async () => {
    await hear({ type: "OPEN_CHAT", url: "/?bot=ranch&routine=morning%20check" });
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
