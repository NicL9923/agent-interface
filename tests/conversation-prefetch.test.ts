// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../src/app/Sidebar";
import { useConversation } from "../src/app/use-conversation";
import { firstPage } from "../src/app/conversation-page";
import { cachedResponse, clearResponseCache } from "../src/client-api";
import { defaultPreferences, type Bootstrap } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { mountRoot } from "./ui-harness";
import type { ComponentProps } from "react";

vi.mock("../src/components/Avatar", async original => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  Avatar: () => null,
}));

const bots = ["ranch", "garden", "barn", "well"].map(id => ({ id, name: id, activity: "idle" }));
const page = (botId: string, text = "Hello") => ({
  botId, sessionId: "live", messages: [{ id: `${botId}-1`, role: "assistant", text }], approvals: [], files: [], activity: { state: "idle" },
});
let tests = 0;
let paths: string[];
let respond: (path: string) => Promise<Response>;
// Reads held open by a test, ended after it so no read outlives into the next test's dedupe state.
let held: ((response: Response) => void)[];
const hold = () => new Promise<Response>(resolve => held.push(resolve));
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

beforeEach(() => {
  vi.useFakeTimers();
  // Fake time restarts at the real clock, so each test is moved past the last one's freshness window.
  vi.setSystemTime(Date.now() + ++tests * 60_000);
  clearResponseCache();
  paths = [];
  held = [];
  respond = path => json(path.includes("/conversation") ? page(path.split("/")[3]) : {});
  vi.stubGlobal("fetch", vi.fn((url: string) => { paths.push(url); return respond(url); }));
  vi.stubGlobal("EventSource", FakeEventSource);
  FakeEventSource.reset();
});
afterEach(async () => {
  // Still-mounted chats update when the held reads end, so that has to happen inside act.
  await act(async () => {
    for (const finish of held) finish(new Response("{}", { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const conversationReads = () => paths.filter(path => path.includes("/conversation"));

describe("home rows prefetch the chat they open", () => {
  let container: HTMLDivElement;
  const props = (botId = "ranch"): ComponentProps<typeof Sidebar> => ({
    boot: { user: { id: "one", name: "One" }, preferences: { ...defaultPreferences, favorites: ["garden"] }, bots } as Bootstrap,
    botId, readThrough: {}, view: "conversation", state: "idle", connectionLost: false, offline: false, mobile: false,
    open: true, update: null, onSelectBot: vi.fn(), onView: vi.fn(), onNewBot: vi.fn(), onSettings: vi.fn(), onUsage: vi.fn(), onSignOut: vi.fn(),
    onPin: vi.fn(), onBotSettings: vi.fn(), onMoveToSection: vi.fn(), onNewSection: vi.fn(),
  });
  const row = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button.bot-item")].find(item => item.textContent?.includes(name))!;
  const mount = async (value = props()) => {
    const { preloadBotMenu } = await import("../src/app/BotMenu");
    const mounted = mountRoot();
    ({ container } = mounted);
    await mounted.render(createElement(Sidebar, value));
    await act(async () => { await preloadBotMenu(); });
  };
  // React derives pointerenter from pointerover, and focus from focusin.
  const event = (target: Element, type: string) => act(async () => {
    target.dispatchEvent(new Event(type === "pointerenter" ? "pointerover" : type, { bubbles: true }));
  });

  it("reads the exact first page once however the row is approached, then serves it from the cache", async () => {
    await mount();
    await event(row("barn"), "pointerenter");
    await event(row("barn"), "pointerdown");
    await event(row("barn"), "focusin");
    expect(conversationReads()).toEqual(["/api/bots/barn/conversation?turns=20"]);
    expect(firstPage("barn")).toBe("/bots/barn/conversation?turns=20");
    expect(cachedResponse<{ botId: string }>(firstPage("barn"))?.botId).toBe("barn");
    // Reading again within a few seconds is skipped; after that it is allowed.
    await event(row("barn"), "pointerenter");
    expect(conversationReads()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 6_000);
    await event(row("barn"), "pointerenter");
    expect(conversationReads()).toHaveLength(2);
  });

  it("joins a read still on its way instead of starting a second one", async () => {
    respond = hold;
    await mount();
    await event(row("barn"), "pointerenter");
    await event(row("barn"), "pointerenter");
    expect(conversationReads()).toHaveLength(1);
    held[0](new Response(JSON.stringify(page("barn")), { status: 200 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(cachedResponse(firstPage("barn"))).toBeDefined();
  });

  it("never reads the open chat, hidden pages, or more than two chats at once", async () => {
    respond = hold;
    await mount();
    await event(row("ranch"), "pointerenter");
    expect(conversationReads()).toEqual([]);
    for (const name of ["garden", "barn", "well"]) await event(row(name), "pointerenter");
    expect(conversationReads()).toEqual(["/api/bots/garden/conversation?turns=20", "/api/bots/barn/conversation?turns=20"]);
  });

  it("stays silent when the read fails, and a later approach reads again", async () => {
    respond = () => Promise.reject(new TypeError("offline"));
    await mount();
    await event(row("barn"), "pointerenter");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(container.querySelector("[role=alert]")).toBeNull();
    await event(row("barn"), "pointerenter");
    expect(conversationReads()).toHaveLength(2);
  });
});

describe("opening a chat after a prefetch", () => {
  let latest: ReturnType<typeof useConversation>;
  const Chat = () => {
    latest = useConversation("barn", "one");
    return createElement("p", null, latest.conversation?.messages.map(message => message.text).join(","));
  };
  const open = async () => {
    const { container, root } = mountRoot();
    await act(async () => root.render(createElement(Chat)));
    return container;
  };

  it("shows the prefetched page at once while checking it again", async () => {
    const { prefetchFirstPage } = await import("../src/app/conversation-page");
    prefetchFirstPage("barn");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    respond = hold;
    const container = await open();
    expect(container.textContent).toBe("Hello");
  });

  it("uses the read already on its way as the first load", async () => {
    respond = path => path.includes("/conversation") ? hold() : json({});
    const { prefetchFirstPage } = await import("../src/app/conversation-page");
    prefetchFirstPage("barn");
    const container = await open();
    expect(conversationReads()).toHaveLength(1);
    held[0](new Response(JSON.stringify(page("barn", "Fresh")), { status: 200 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(container.textContent).toBe("Fresh");
    expect(conversationReads()).toHaveLength(1);
  });

  it("never answers the next account with a read made for the last one", async () => {
    respond = path => path.includes("/conversation") ? hold() : json({});
    const { prefetchFirstPage } = await import("../src/app/conversation-page");
    prefetchFirstPage("barn");
    // Signing out clears the cache; the next account opens the same chat before the old read ends.
    clearResponseCache();
    const container = await open();
    expect(conversationReads()).toHaveLength(2);
    held[0](new Response(JSON.stringify(page("barn", "Last account's private draft")), { status: 200 }));
    held[1](new Response(JSON.stringify(page("barn", "Mine")), { status: 200 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(container.textContent).toBe("Mine");
    expect(cachedResponse<{ messages: { text: string }[] }>(firstPage("barn"))?.messages[0].text).toBe("Mine");
    // The old read's end leaves the new account free to prefetch at once.
    prefetchFirstPage("barn");
    expect(conversationReads()).toHaveLength(3);
  });

  it("reads again itself when the prefetch fails", async () => {
    let calls = 0;
    respond = path => path.includes("/conversation")
      ? ++calls === 1 ? Promise.reject(new TypeError("blip")) : json(page("barn", "Second"))
      : json({});
    const { prefetchFirstPage } = await import("../src/app/conversation-page");
    prefetchFirstPage("barn");
    const container = await open();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(container.textContent).toBe("Second");
    expect(conversationReads()).toHaveLength(2);
  });
});
