// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api, ApiError, clearResponseCache, write } from "../src/client-api";
import { signInHintKey } from "../src/app/storage";
import { SESSION_MAX_AGE_MS } from "../src/shared/session";
import { defaultPreferences, type Bootstrap, type Conversation } from "../src/shared/types";
import { quietConsoleErrors } from "./act-guard";
import { FakeEventSource } from "./fake-event-source";
import { advance, button, mountRoot, stubMatchMedia } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async original => ({
  ...await original<typeof import("../src/client-api")>(),
  api: vi.fn(),
  write: vi.fn().mockResolvedValue({}),
}))(original)));
// Presence heartbeats and device activity have their own tests; here they would add requests to the count.
vi.mock("../src/app/use-chat-presence", () => ({ useChatPresence: () => {} }));
vi.mock("../src/app/use-device-activity", () => ({ useDeviceActivity: () => {} }));
vi.mock("../src/components/Avatar", async original => ({ ...await original<typeof import("../src/components/Avatar")>(), Avatar: () => null }));

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
const page = (botId: string, text: string): Conversation => ({
  botId, messages: [{ id: `${botId}-1`, role: "assistant", text }], approvals: [], files: [], activity: { state: "idle" },
});

let root: Root, container: HTMLDivElement;
let bootstrapReply: { resolve(value: Bootstrap): void; reject(error: unknown): void };
let conversationReply: Record<string, { resolve(value: Conversation): void; reject(error: unknown): void }>;
let calls: string[];
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const conversationReads = () => calls.filter(path => path.includes("/conversation"));
const hint = () => JSON.parse(localStorage.getItem(signInHintKey) ?? "null") as { until: number; bots: string[] } | null;
const saveHint = (value: unknown) => localStorage.setItem(signInHintKey, typeof value === "string" ? value : JSON.stringify(value));

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.clearAllMocks();
  // Prefetched reads belong to an account; a new one starts each test with none to join.
  clearResponseCache();
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia();
  calls = [];
  conversationReply = {};
  vi.mocked(write).mockReset().mockResolvedValue({});
  // Bootstrap and conversation reads stay open until a test answers them, so their order is the test's to set.
  vi.mocked(api).mockImplementation(async <T>(path: string) => {
    calls.push(path);
    if (path === "/bootstrap?roster=lean") {
      const reply = deferred<Bootstrap>();
      bootstrapReply = reply;
      return await reply.promise as T;
    }
    if (path === "/auth/config") return { localDevAuth: true } as T;
    const chat = /^\/bots\/([^/]+)\/conversation\?/.exec(path)?.[1];
    if (chat) {
      const reply = deferred<Conversation>();
      conversationReply[chat] = reply;
      return await reply.promise as T;
    }
    return null as T;
  });
  ({ container, root } = mountRoot());
});

async function open(url: string) {
  history.replaceState(null, "", url);
  await act(async () => root.render(createElement(App)));
}
async function answerBootstrap(value: Bootstrap | Error) {
  await act(async () => { if (value instanceof Error) bootstrapReply.reject(value); else bootstrapReply.resolve(value); });
  await advance(0);
}

describe("a link that names a chat", () => {
  it("reads the chat while bootstrap is on its way, and the chat shows that same read", async () => {
    saveHint({ until: NOW + 60_000, bots: ["home", "ranch"] });
    await open("/?bot=ranch");
    expect(calls).toContain("/bootstrap?roster=lean");
    expect(conversationReads()).toEqual(["/bots/ranch/conversation?turns=20"]);
    await act(async () => conversationReply.ranch.resolve(page("ranch", "The north gate is latched.")));
    await answerBootstrap(bootstrap);
    expect(container.querySelector(".transcript")?.textContent).toContain("The north gate is latched.");
    // The opened chat joined the read already made rather than asking again.
    expect(conversationReads()).toEqual(["/bots/ranch/conversation?turns=20"]);
  });

  it("joins the read when bootstrap answers first", async () => {
    saveHint({ until: NOW + 60_000, bots: ["ranch"] });
    await open("/?bot=ranch");
    await answerBootstrap(bootstrap);
    expect(conversationReads()).toHaveLength(1);
    await act(async () => conversationReply.ranch.resolve(page("ranch", "Fence check is done.")));
    await advance(0);
    expect(container.querySelector(".transcript")?.textContent).toContain("Fence check is done.");
    expect(conversationReads()).toHaveLength(1);
  });

  it("shows sign-in to a signed-out person without reading the chat or reporting an error", async () => {
    const errors = quietConsoleErrors();
    await open("/?bot=ranch");
    await answerBootstrap(new ApiError("Sign in required", 401, "session_expired"));
    expect(button("Enter local workspace")).toBeDefined();
    expect(conversationReads()).toEqual([]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([
    ["no earlier sign-in on this browser", undefined, "/?bot=ranch"],
    ["a sign-in that has lapsed", { until: NOW, bots: ["ranch"] }, "/?bot=ranch"],
    ["a chat the last sign-in could not open", { until: NOW + 60_000, bots: ["home"] }, "/?bot=ranch"],
    ["an unreadable record", "{not json", "/?bot=ranch"],
    ["a lapse time that is not a number", { until: String(NOW + 60_000), bots: ["ranch"] }, "/?bot=ranch"],
    ["a record whose chats are not a list of IDs", { until: NOW + 60_000, bots: "ranch" }, "/?bot=ranch"],
    ["a link to a message, which opens around it instead", { until: NOW + 60_000, bots: ["ranch"] }, "/?bot=ranch&message=ranch-1"],
    ["a link to Today", { until: NOW + 60_000, bots: ["ranch"] }, "/?bot=ranch&view=today"],
  ])("waits for bootstrap with %s", async (_name, stored, url) => {
    if (stored !== undefined) saveHint(stored);
    await open(url);
    expect(calls).toContain("/bootstrap?roster=lean");
    expect(conversationReads()).toEqual([]);
  });

  it("opens a message link at that message after bootstrap", async () => {
    saveHint({ until: NOW + 60_000, bots: ["ranch"] });
    await open("/?bot=ranch&message=ranch-1");
    await answerBootstrap(bootstrap);
    expect(conversationReads()).toEqual(["/bots/ranch/conversation?start=ranch-1"]);
  });

  it("drops a read for a chat the person can no longer see, says so once, and stops reading it next time", async () => {
    saveHint({ until: NOW + 60_000, bots: ["home", "ranch"] });
    await open("/?bot=ranch");
    await act(async () => conversationReply.ranch.reject(new ApiError("Assistant not found", 404, "assistant_not_found")));
    await answerBootstrap({ ...bootstrap, bots: [bootstrap.bots[0]] });
    // The app's existing notice, and the main assistant opens instead.
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("That assistant is no longer available to you.");
    expect(conversationReads()).toEqual(["/bots/ranch/conversation?turns=20", "/bots/home/conversation?turns=20"]);
    expect(hint()?.bots).toEqual(["home"]);
  });
});

describe("what this browser remembers about its sign-in", () => {
  it("starts at sign-in, learns the chats from bootstrap, and is forgotten when the session is refused", async () => {
    await open("/");
    await answerBootstrap(new ApiError("Sign in required", 401, "session_expired"));
    await act(async () => button("Enter local workspace").click());
    expect(hint()).toEqual({ until: NOW + SESSION_MAX_AGE_MS - 60_000, bots: [] });
    await answerBootstrap(bootstrap);
    expect(hint()).toEqual({ until: NOW + SESSION_MAX_AGE_MS - 60_000, bots: ["home", "ranch"] });
    // A bootstrap that cannot reach Hermes lists no chats; that is no reason to forget them.
    await act(async () => window.dispatchEvent(new Event("online")));
    await answerBootstrap({ ...bootstrap, bots: [], connection: { connected: false } });
    expect(hint()?.bots).toEqual(["home", "ranch"]);
    await act(async () => window.dispatchEvent(new Event("online")));
    await answerBootstrap(new ApiError("Sign in required", 401, "session_expired"));
    expect(hint()).toBeNull();
  });

  it("is forgotten when the person signs out", async () => {
    for (const [name, opened] of [["showModal", true], ["close", false]] as const)
      Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, value: function(this: HTMLDialogElement) { this.open = opened; } });
    saveHint({ until: NOW + 60_000, bots: ["home"] });
    await open("/");
    await answerBootstrap(bootstrap);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Account"]')!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.startsWith("Sign out"))!.click());
    await act(async () => { await vi.dynamicImportSettled(); });
    await act(async () => document.querySelector<HTMLButtonElement>('[role="alertdialog"] button.danger')!.click());
    expect(write).toHaveBeenCalledWith("/auth/logout", {});
    expect(container.querySelector(".sign-in")).not.toBeNull();
    expect(hint()).toBeNull();
  });

  it("does not invent a sign-in for a session this browser did not see start", async () => {
    await open("/");
    await answerBootstrap(bootstrap);
    expect(hint()).toBeNull();
  });
});
