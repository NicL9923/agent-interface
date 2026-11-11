// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api, retryDelay, write } from "../src/client-api";
import { useConversation } from "../src/app/use-conversation";
import { GroupRoomView } from "../src/components/GroupChats";
import { defaultPreferences, type Bootstrap, type Conversation } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { advance, mountRoot, reducedMotionOnly, stubMatchMedia, unmountAll } from "./ui-harness";

// A page hidden and shown again is a pause, not the end of an outage. Every owner closes its stream's
// connection while the page is hidden, and the stream keeps its retry budget for when it is shown: a
// person switching apps on a phone must not turn each switch into an attempt against a refusing server,
// and must not wait at all when the server is healthy.

// Only the network is replaced; changeStream and its owners run for real. Every request a test did not
// list fails loudly, and the owners swallow some, so `unexpected` is checked after each test.
vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest({
  ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn(),
}));
// jsdom cannot measure SVG paths, and portraits have their own tests.

const START = Date.parse("2026-11-10T12:00:00Z");
const CHAT = "/api/bots/shared/events?inflight=3&drafts=1&ping=10";
const HOUSEHOLD = "/api/events?ping=10";
const ROOM = "/api/events?group=room&ping=10";
let unexpected: string[];
let visibility: DocumentVisibilityState;
const boot = (): Bootstrap => ({
  user: { id: "one", name: "One", email: "one@example.test" }, household: [],
  preferences: { ...structuredClone(defaultPreferences), startPage: "assistant" },
  bots: [{ id: "shared", name: "Shared", shared: true, model: "test", activity: "idle" }, { id: "other", name: "Other", shared: true, model: "test", activity: "idle" }],
  capabilities: Object.fromEntries(["chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration", "tools", "skills", "routines", "durableEvents", "idempotency", "imageGeneration", "stop", "portraitGeneration", "avatarMetadata"].map(key => [key, { supported: true }])) as Bootstrap["capabilities"],
  connection: { connected: true }, csrfToken: "csrf-one",
} as Bootstrap);
const conversation = (botId: string): Conversation => ({ botId, messages: [{ id: "one", role: "assistant", text: "Howdy" }], approvals: [], files: [], activity: { state: "idle" } });
const room = { room_id: "room", name: "Weekend plans", members: [{ member_id: "shared", profile: "shared", handle: "shared", display_name: "Shared" }] };
/** The reads each owner makes, by path prefix. Anything else is unexpected. */
const reads: [string, () => unknown][] = [
  ["/bootstrap?roster=lean", boot],
  ["/bots/shared/conversation?", () => conversation("shared")],
  ["/bots/other/conversation?", () => conversation("other")],
  ["/bots/shared/draft", () => ({ text: "", attachments: [] })],
  ["/groups/room/log", () => ({ events: [], cursor: 0, has_more: false })],
  ["/groups/room", () => ({ room, driver_status: { working: false, blocked: false, pending_actions: [] } })],
  ["/groups", () => ({ supported: true, canSend: true, rooms: [room] })],
  ["/bots/shared/routine-runs", () => ({ runs: [] })],
];

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  // The jitter's random source: the middle of every range, so the first retry waits 1.5 seconds.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia(reducedMotionOnly);
  history.replaceState(null, "", "/");
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  unexpected = [];
  vi.mocked(api).mockReset().mockImplementation(async <T>(path: string) => {
    const read = reads.find(([prefix]) => path.startsWith(prefix));
    if (read) return read[1]() as T;
    unexpected.push(`GET ${path}`);
    throw new Error(`This test serves no GET ${path}`);
  });
  vi.mocked(write).mockReset().mockImplementation(async (path: string, _body: unknown, method = "POST") => {
    unexpected.push(`${method} ${path}`);
    throw new Error(`This test serves no ${method} ${path}`);
  });
});
afterEach(async () => {
  // Unmounted first, so a failed check below leaves no owner listening into the next test.
  await unmountAll();
  Reflect.deleteProperty(document, "visibilityState");
  expect(unexpected).toEqual([]);
});

const attempts = (url: string) => FakeEventSource.created.filter(created => created === url).length;
const live = (url: string) => [...FakeEventSource.streams].filter(source => source.url === url).at(-1);
/** Refuses each open stream at `urls`, as a server that is down answers at once. */
const refuse = (...urls: string[]) => act(async () => { for (const url of urls) live(url)?.fail(); });
const setVisibility = (state: DocumentVisibilityState) => act(async () => {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
});
const hide = () => setVisibility("hidden");
const show = () => setVisibility("visible");
/**
 * Hides and shows the page `count` times, `stepMs` hidden and then `stepMs` shown, refusing every
 * attempt at `urls` as it starts.
 */
async function cycles(count: number, urls: string[], stepMs = 0) {
  for (let cycle = 0; cycle < count; cycle++) {
    await hide();
    await advance(stepMs);
    await show();
    await refuse(...urls);
    await advance(stepMs);
    await refuse(...urls);
  }
}

const Chat = ({ botId = "shared" }: { botId?: string }) => { useConversation(botId, "one"); return null; };
const Room = () => createElement(GroupRoomView, { bootstrap: boot(), roomId: "room", canSend: true, onChanged: () => {} });

describe("a stream hidden and shown during an outage keeps its retry budget", () => {
  it("makes no attempt beyond the opening for 100 hide and show cycles at a standing clock, on all three streams, before or after an online burst", async () => {
    const { render } = mountRoot();
    await render(createElement(App));
    await advance(0);
    const { render: renderRoom } = mountRoot();
    await renderRoom(createElement(Room));
    await advance(0);
    expect([attempts(HOUSEHOLD), attempts(CHAT), attempts(ROOM)]).toEqual([1, 1, 1]);
    await refuse(HOUSEHOLD, CHAT, ROOM);
    await cycles(100, [HOUSEHOLD, CHAT, ROOM]);
    expect([attempts(HOUSEHOLD), attempts(CHAT), attempts(ROOM)], "only the opening attempt").toEqual([1, 1, 1]);
    // The reviewer's sequence: a burst of `online` events forces one attempt each, then 100 more cycles.
    for (let event = 0; event < 100; event++) {
      await act(async () => { window.dispatchEvent(new Event("online")); });
      await refuse(HOUSEHOLD, CHAT, ROOM);
    }
    expect([attempts(HOUSEHOLD), attempts(CHAT), attempts(ROOM)], "the first signal's forced attempt").toEqual([2, 2, 2]);
    await cycles(100, [HOUSEHOLD, CHAT, ROOM]);
    expect([attempts(HOUSEHOLD), attempts(CHAT), attempts(ROOM)]).toEqual([2, 2, 2]);
  });

  it("makes 7 attempts on each stream in 100 seconds of hide and show every half second, the same as a page left open", async () => {
    // Each cycle hides the page at a whole second and shows it at the half. Every retry deadline, at
    // 1.5, 4.5, 10.5, 22.5, 46.5 and 94.5 seconds, falls while the page is shown.
    const { render } = mountRoot();
    await render(createElement(App));
    const { render: renderRoom } = mountRoot();
    await renderRoom(createElement(Room));
    await refuse(HOUSEHOLD, CHAT, ROOM);
    await cycles(100, [HOUSEHOLD, CHAT, ROOM], 500);
    expect([attempts(HOUSEHOLD), attempts(CHAT), attempts(ROOM)]).toEqual([7, 7, 7]);
  });

  it("connects at once when shown after the retry deadline passed while hidden", async () => {
    await mountRoot().render(createElement(Chat));
    await refuse(CHAT);
    await hide();
    await advance(2_000);
    expect(attempts(CHAT), "a hidden page attempts nothing").toBe(1);
    await show();
    expect(attempts(CHAT)).toBe(2);
  });

  it("connects at once when shown an hour into a long outage, not a full backoff after the show", async () => {
    await mountRoot().render(createElement(Chat));
    // Ten refusals in a row, each retried on time: the next retry waits 3.75 minutes at the middle of the
    // jitter, three quarters of the 5-minute ceiling.
    for (let failure = 1; failure < 10; failure++) {
      await refuse(CHAT);
      await advance(retryDelay(failure, () => 0.5));
    }
    await refuse(CHAT);
    expect(attempts(CHAT)).toBe(10);
    await hide();
    await advance(60 * 60_000);
    await show();
    expect(attempts(CHAT), "the deadline passed long ago").toBe(11);
    // Refused again, the eleventh failure waits its full backoff from that failure: 3.75 minutes.
    await refuse(CHAT);
    await advance(225_000 - 1);
    expect(attempts(CHAT)).toBe(11);
    await advance(1);
    expect(attempts(CHAT)).toBe(12);
  });

  it("waits for the retry deadline when shown before it", async () => {
    await mountRoot().render(createElement(Chat));
    await refuse(CHAT);
    await hide();
    await advance(500);
    await show();
    expect(attempts(CHAT)).toBe(1);
    await advance(999);
    expect(attempts(CHAT)).toBe(1);
    await advance(1);
    expect(attempts(CHAT), "the first retry, 1.5 seconds after the refusal").toBe(2);
  });

  it("answers a network return that arrived while hidden when shown, once, on all three streams", async () => {
    const { render } = mountRoot();
    await render(createElement(App));
    const { render: renderRoom } = mountRoot();
    await renderRoom(createElement(Room));
    await refuse(HOUSEHOLD, CHAT, ROOM);
    await hide();
    for (let event = 0; event < 100; event++) await act(async () => { window.dispatchEvent(new Event("online")); });
    expect([attempts(HOUSEHOLD), attempts(CHAT), attempts(ROOM)], "a hidden page attempts nothing").toEqual([1, 1, 1]);
    // Shown 0.5 s after the refusal, before the first retry was due: the signal still connects at once.
    await advance(500);
    await show();
    expect([attempts(HOUSEHOLD), attempts(CHAT), attempts(ROOM)]).toEqual([2, 2, 2]);
    await refuse(HOUSEHOLD, CHAT, ROOM);
    // The signal was answered; hiding and showing again does not answer it twice.
    await hide();
    await show();
    expect([attempts(HOUSEHOLD), attempts(CHAT), attempts(ROOM)]).toEqual([2, 2, 2]);
  });

  it("still connects at once on the first network return after a hide and show", async () => {
    await mountRoot().render(createElement(Chat));
    await refuse(CHAT);
    await hide();
    await show();
    expect(attempts(CHAT)).toBe(1);
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(attempts(CHAT)).toBe(2);
  });
});

describe("a healthy stream hidden and shown", () => {
  it("connects at once every time it is shown, on all three streams", async () => {
    const { render } = mountRoot();
    await render(createElement(App));
    const { render: renderRoom } = mountRoot();
    await renderRoom(createElement(Room));
    const urls = [HOUSEHOLD, CHAT, ROOM];
    // Each connection is accepted and pings at once, as a `?ping=10` server does.
    const accept = () => act(async () => { for (const url of urls) { const source = live(url); if (source && source.readyState !== FakeEventSource.OPEN) { source.connect(); source.emit("ping", "10"); } } });
    await accept();
    for (let cycle = 1; cycle <= 100; cycle++) {
      await hide();
      await show();
      expect(urls.map(attempts), `cycle ${cycle}`).toEqual([cycle + 1, cycle + 1, cycle + 1]);
      await accept();
    }
  });

  it("connects at once when shown after a forced attempt proved itself before the retry it beat", async () => {
    await mountRoot().render(createElement(Chat));
    await refuse(CHAT);
    const online = () => act(async () => { window.dispatchEvent(new Event("online")); });
    // The first signal forces an attempt and starts a 3-second gap. Two more refusals put the ordinary
    // retry at 4.5 seconds.
    await online();
    await refuse(CHAT);
    await advance(1_500);
    await refuse(CHAT);
    await advance(1_500);
    // At 3 seconds the gap has passed, so a signal forces an attempt 1.5 seconds before the retry.
    await online();
    expect(attempts(CHAT)).toBe(4);
    // A server pinging every 2 seconds proves it a second after its headers, at 4 seconds, before 4.5.
    const forced = live(CHAT)!;
    await act(async () => { forced.connect(); forced.emit("ping", "2"); });
    await advance(1_000);
    await act(async () => forced.emit("ping", "2"));
    await hide();
    await show();
    expect(attempts(CHAT), "no retry deadline outlives the stream that proved itself").toBe(5);
  });

});

describe("a stream its owner is done with", () => {
  it("leaves no budget behind when the chat switches or unmounts", async () => {
    const { render, root } = mountRoot();
    await render(createElement(Chat));
    await refuse(CHAT);
    await advance(1_500);
    await refuse(CHAT);
    // Switching to another chat and back starts a new stream, which connects at once.
    await render(createElement(Chat, { botId: "other" }));
    await render(createElement(Chat));
    expect(attempts(CHAT)).toBe(3);
    await refuse(CHAT);
    await act(async () => root.unmount());
    await render(createElement(Chat));
    expect(attempts(CHAT), "a remounted chat connects at once").toBe(4);
    // The streams the chat left were closed: none retries behind the live one, whose watchdog waits 55 s.
    await advance(30_000);
    expect(attempts(CHAT)).toBe(4);
  });

  it("leaves no budget behind when the room view unmounts", async () => {
    const { render, root } = mountRoot();
    await render(createElement(Room));
    await refuse(ROOM);
    await act(async () => root.unmount());
    await render(createElement(Room));
    expect(attempts(ROOM)).toBe(2);
    await advance(30_000);
    expect(attempts(ROOM), "the unmounted view's stream retries nothing").toBe(2);
  });
});
