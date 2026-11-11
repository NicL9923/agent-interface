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
import type { Root } from "react-dom/client";


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
  const Chat = ({ botId }: { botId: string }) => {
    latest = useConversation(botId, "one");
    return createElement("p", null, latest.conversation?.messages.map(message => message.text).join(","));
  };
  const roots = new Map<HTMLDivElement, Root>();
  const open = async (botId = "barn") => {
    const { container, root } = mountRoot();
    roots.set(container, root);
    await act(async () => root.render(createElement(Chat, { botId })));
    return container;
  };
  const leave = (container: HTMLDivElement) => act(async () => roots.get(container)!.unmount());

  // A hover read that finished is only a cached page to show at once. Reusing it as the load would
  // show a page from before anything the person did since, so the chat always reads again.
  it("shows a finished prefetch at once from the cache and still reads the chat", async () => {
    const { prefetchFirstPage } = await import("../src/app/conversation-page");
    prefetchFirstPage("barn");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    vi.setSystemTime(Date.now() + 1);
    respond = path => path.includes("/conversation") ? hold() : json({});
    const container = await open();
    expect(container.textContent).toBe("Hello");
    expect(conversationReads()).toHaveLength(2);
    held[0](new Response(JSON.stringify(page("barn", "Read on open")), { status: 200 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(container.textContent).toBe("Read on open");
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

  // Only the first load may take the link's read. An empty chat has no window to start from, so every
  // later load asks for the same first page and must not be handed the old read. This case opens the
  // change stream, whose connection is the first of those later loads.
  it("reads fresh for the stream's connection and each notice after opening from an empty startup read", async () => {
    let reads = 0;
    const empty = { ...page("barn"), messages: [] };
    respond = path => path.includes("/conversation") ? json(++reads === 1 ? empty : page("barn", "First reply")) : json({});
    const { prefetchLinkedPage } = await import("../src/app/conversation-page");
    prefetchLinkedPage("barn");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const container = await open();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(container.textContent).toBe("");
    expect(conversationReads()).toHaveLength(1);
    await act(async () => { [...FakeEventSource.streams][0].connect(); await vi.advanceTimersByTimeAsync(1_000); });
    expect(conversationReads()).toHaveLength(2);
    expect(container.textContent).toBe("First reply");
    await act(async () => { FakeEventSource.notifyAll(); await vi.advanceTimersByTimeAsync(0); });
    expect(conversationReads().at(-1)).toBe("/api/bots/barn/conversation?start=barn-1");
  });

  // A notice that arrives while the first load waits on a hover read is about something newer than
  // that read. An empty chat has no window to start from, so the load the notice queues asks for the
  // same first page, and must not be handed the read it was queued behind.
  it("reads fresh for a notice that arrived while an empty chat's first load waited on a prefetch", async () => {
    respond = path => path.includes("/conversation") ? hold() : json({});
    const { prefetchFirstPage } = await import("../src/app/conversation-page");
    prefetchFirstPage("barn");
    const container = await open();
    await act(async () => { FakeEventSource.notifyAll(); await vi.advanceTimersByTimeAsync(0); });
    expect(conversationReads()).toHaveLength(1);
    await act(async () => { held[0](new Response(JSON.stringify({ ...page("barn"), messages: [] }), { status: 200 })); await vi.advanceTimersByTimeAsync(0); });
    expect(conversationReads()).toEqual(["/api/bots/barn/conversation?turns=20", "/api/bots/barn/conversation?turns=20"]);
    await act(async () => { held[1](new Response(JSON.stringify(page("barn", "First reply")), { status: 200 })); await vi.advanceTimersByTimeAsync(0); });
    expect(container.textContent).toBe("First reply");
  });

  // The read a link starts as the page loads may answer the first chat load once, finished or not.
  // Nothing the person does can come before that load; everything after it can, so a second open
  // of the chat, however soon, reads again. These cases never open the change stream.
  it.each([["finished", true], ["still on its way", false]])("answers the first load from the link's read %s, and reads again on the next open", async (_name, finished) => {
    respond = path => path.includes("/conversation") ? hold() : json({});
    const { prefetchLinkedPage } = await import("../src/app/conversation-page");
    prefetchLinkedPage("barn");
    const end = () => act(async () => { held[0](new Response(JSON.stringify(page("barn", "Linked")), { status: 200 })); await vi.advanceTimersByTimeAsync(0); });
    if (finished) await end();
    const first = await open();
    if (!finished) await end();
    expect(first.textContent).toBe("Linked");
    expect(conversationReads()).toHaveLength(1);
    await leave(first);
    const second = await open();
    expect(second.textContent).toBe("Linked");
    expect(conversationReads()).toHaveLength(2);
    await act(async () => { held[1](new Response(JSON.stringify(page("barn", "Read again")), { status: 200 })); await vi.advanceTimersByTimeAsync(0); });
    expect(second.textContent).toBe("Read again");
  });

  // The first chat load after the page loaded uses the link's read up, whichever chat or window it
  // reads, so the read can never answer a later open.
  it.each([
    ["another chat", "ranch", "/"],
    ["a message window in the same chat", "barn", "/?bot=barn&message=barn-1"],
  ])("never answers a later open once the first load was for %s", async (_name, firstChat, url) => {
    history.replaceState(null, "", url);
    try {
      const { prefetchLinkedPage } = await import("../src/app/conversation-page");
      prefetchLinkedPage("barn");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const first = await open(firstChat);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await leave(first);
      history.replaceState(null, "", "/");
      const reads = conversationReads().filter(path => path.startsWith("/api/bots/barn/conversation?turns=")).length;
      await open("barn");
      expect(conversationReads().filter(path => path.startsWith("/api/bots/barn/conversation?turns="))).toHaveLength(reads + 1);
    } finally { history.replaceState(null, "", "/"); }
  });

  // An older read's body that ends just after a newer one's must not replace it in the cache, which
  // a reopened chat shows first.
  it("keeps the newer read's page cached when an older prefetch's body ends just after it", async () => {
    const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
    respond = path => Promise.resolve(path.includes("/conversation")
      ? new Response(new ReadableStream<Uint8Array>({ start: controller => { bodies.push(controller); } }), { status: 200 })
      : new Response("{}", { status: 200 }));
    const { firstQuery, prefetchFirstPage } = await import("../src/app/conversation-page");
    const { request } = await import("../src/client-api");
    prefetchFirstPage("barn");
    const newer = request("GET /bots/:id/conversation", { params: { id: "barn" }, query: firstQuery });
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies).toHaveLength(2);
    const end = (body: ReadableStreamDefaultController<Uint8Array>, text: string) => {
      body.enqueue(new TextEncoder().encode(JSON.stringify(page("barn", text))));
      body.close();
    };
    end(bodies[1], "Newer");
    end(bodies[0], "Older");
    expect((await newer).messages[0].text).toBe("Newer");
    await vi.advanceTimersByTimeAsync(0);
    expect(cachedResponse<{ messages: { text: string }[] }>(firstPage("barn"))?.messages[0].text).toBe("Newer");
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
