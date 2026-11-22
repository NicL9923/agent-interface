// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api, write } from "../src/client-api";
import {
  defaultPreferences,
  type Bootstrap,
  type Conversation,
  type SavedDraft,
} from "../src/shared/types";
import type { GroupCatalog, GroupRoom } from "../src/shared/collaboration";
import { GROUP_FALLBACK_POLL_MS } from "../src/app/use-session";
import { OUTAGE_GRACE_MS, OUTAGE_LASTING_MS } from "../src/app/outage";
import { FakeEventSource } from "./fake-event-source";
import { advance, mountRoot, stubMatchMedia, type Mount } from "./ui-harness";

// While the streams are live they stand in for the polls. When one has been down for 20 seconds, the
// connection notice says live updates stopped, and one live region announces each connection change.

// Only the network is replaced: presence, device activity, the avatar and every other component run for
// real. A request no test listed fails where it is made and again after the test; see `unexpected`.
vi.mock("../src/client-api", async (original) =>
  (await import("./helpers/request-mock")).withRequest({
    ...(await original<typeof import("../src/client-api")>()),
    api: vi.fn(),
    write: vi.fn(),
  }),
);

const START = Date.UTC(2026, 10, 10, 15);
let mount: Mount, container: HTMLDivElement, boot: Bootstrap, conversation: Conversation;
let unexpected: string[];
let draft: SavedDraft | null;
let catalog: GroupCatalog;
const member = (id: string, name: string) => ({
  member_id: id,
  profile: id,
  handle: id,
  display_name: name,
});
const room: GroupRoom = {
  room_id: "supper",
  name: "Supper",
  members: [member("shared", "Shared"), member("other", "Other")],
};

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.useFakeTimers({ now: START });
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia();
  // Browser APIs jsdom lacks, which the real Avatar uses.
  Object.assign(SVGElement.prototype, {
    getTotalLength: () => 100,
    getPointAtLength: (length: number) => ({ x: length, y: 0 }),
  });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  history.replaceState(null, "", "/");
  unexpected = [];
  draft = null;
  catalog = { supported: true, canSend: true, rooms: [room] };
  boot = {
    user: { id: "one", name: "One", email: "one@example.test" },
    household: [],
    preferences: { ...structuredClone(defaultPreferences), startPage: "assistant" },
    bots: [
      { id: "shared", name: "Shared", shared: true, model: "test", activity: "idle" },
      { id: "other", name: "Other", shared: true, model: "test", activity: "idle" },
    ],
    capabilities: Object.fromEntries(
      [
        "chat",
        "steering",
        "approvals",
        "uploads",
        "generatedFiles",
        "botConfiguration",
        "tools",
        "skills",
        "routines",
        "durableEvents",
        "idempotency",
        "imageGeneration",
        "stop",
        "portraitGeneration",
        "avatarMetadata",
      ].map((key) => [key, { supported: true }]),
    ) as Bootstrap["capabilities"],
    connection: { connected: true },
    csrfToken: "csrf-one",
  };
  conversation = {
    botId: "shared",
    messages: [{ id: "answer-one", role: "assistant", text: "Existing canonical answer" }],
    approvals: [],
    files: [],
    activity: { state: "idle" },
  };
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async <T>(path: string) => {
      if (path === "/bootstrap?roster=lean") return boot as T;
      // A conversation read carries the reader's draft, as the server's does.
      if (path.startsWith("/bots/shared/conversation?")) return { ...conversation, draft } as T;
      if (path === "/bots/shared/draft") return draft as T;
      if (path === "/bots/shared/routine-runs") return { runs: [], unavailable: [] } as T;
      if (path === "/groups") return catalog as T;
      if (path === "/groups/supper")
        return {
          room,
          driver_status: { working: false, blocked: false, pending_actions: [] },
        } as T;
      if (path.startsWith("/groups/supper/log?"))
        return { events: [], cursor: 0, has_more: false } as T;
      if (path === "/today?pending=1")
        return {
          generatedAt: "2026-11-10T15:00:00Z",
          frontier: "0",
          hasMore: false,
          since: "2026-11-10T00:00:00Z",
          unavailableBots: [],
          items: [],
          events: [],
        } as T;
      unexpected.push(`GET ${path}`);
      throw new Error(`This test serves no GET ${path}`);
    });
  // Presence and device activity run for real, and write nothing in a page that never had focus or input.
  vi.mocked(write)
    .mockReset()
    .mockImplementation(async (path: string, _body: unknown, method = "POST") => {
      unexpected.push(`${method} ${path}`);
      throw new Error(`This test serves no ${method} ${path}`);
    });
  mount = mountRoot();
  container = mount.container;
});
// The app swallows some failed requests, so an unlisted one is caught here as well as where it was made.
afterEach(() => {
  Reflect.deleteProperty(navigator, "onLine");
  expect(unexpected).toEqual([]);
});

const stream = (match: (url: string) => boolean) =>
  [...FakeEventSource.streams].filter((item) => match(item.url)).at(-1)!;
const household = () => stream((url) => url.startsWith("/api/events?ping"));
const chat = () => stream((url) => url.includes("/bots/"));
const panels = () => [...container.querySelectorAll('section[aria-label="Hermes connection"]')];
const notice = () => panels().map((panel) => panel.querySelector("h2")?.textContent);
const reads = (match: (path: string) => boolean) =>
  vi.mocked(api).mock.calls.filter(([path]) => match(String(path))).length;
/** Keeps every stream but `except` alive, as a server that pings every 10 seconds does. */
const pinging = async (ms: number, except?: FakeEventSource) => {
  for (let waited = 0; waited < ms; waited += 1_000) {
    if (waited % 10_000 === 0)
      await act(async () => {
        for (const item of FakeEventSource.streams)
          if (item !== except && item.readyState === FakeEventSource.OPEN) item.emit("ping", "10");
      });
    await advance(1_000);
  }
};
/** Opens the app with every stream live: connected, greeted, and pinged again 10 seconds later. */
const live = async () => {
  await mount.render(createElement(App));
  await advance(20);
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await act(async () => {
    for (const item of FakeEventSource.streams) {
      item.connect();
      item.emit("ping", "10");
    }
  });
  await advance(10_000);
  await pinging(1_000);
};
/** Takes the device offline and waits out the grace period every loss gets before it shows. */
const goOffline = async () => {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
  await act(async () => window.dispatchEvent(new Event("offline")));
  await advance(OUTAGE_GRACE_MS);
};

/** Opening a chat reports the person there, and leaving one saves their place: both are answered. */
const servePresence = () =>
  vi.mocked(write).mockImplementation(async <T>(path: string, body: unknown, method = "POST") => {
    if (method === "PUT" && /^\/bots\/(shared|other)\/(presence|read-position)$/.test(path))
      return body as T;
    if (method === "PUT" && path === "/devices/activity") return {} as T;
    unexpected.push(`${method} ${path}`);
    throw new Error(`This test serves no ${method} ${path}`);
  });

describe("live updates and the connection notice", () => {
  it("shows one quiet notice 20 seconds into an outage, keeps it through the stream being replaced, and clears it once the stream is back", async () => {
    await live();
    const cut = household();
    await act(async () => cut.drop());
    await pinging(19_000, cut);
    expect(panels()).toEqual([]);
    await pinging(1_000, cut);
    expect(notice()).toEqual(["Live updates are delayed"]);
    // The drop was closed and retried within 2 seconds; that replacement has not connected, so the outage goes on.
    await pinging(10_000, cut);
    expect(
      FakeEventSource.created.filter((url) => url.startsWith("/api/events?ping")),
    ).toHaveLength(2);
    expect(notice()).toEqual(["Live updates are delayed"]);
    // Connecting alone, or its greeting, is not live: the stream is back once it pings again an interval later.
    await act(async () => {
      household().connect();
      household().emit("ping", "10");
    });
    await advance(20);
    expect(notice()).toEqual(["Live updates are delayed"]);
    await pinging(11_000);
    expect(panels()).toEqual([]);
    // Someone who heard that live updates stopped hears that they are back.
    expect(container.querySelector("[data-connection-announcer]")!.textContent).toBe(
      "Live updates are back.",
    );
  });

  it("never shows for a brief drop", async () => {
    await live();
    await act(async () => chat().drop());
    await pinging(5_000, chat());
    await act(async () => chat().connect());
    await pinging(60_000);
    expect(panels()).toEqual([]);
  });

  it("says offline in the same single notice when the device is offline too", async () => {
    await live();
    await goOffline();
    await act(async () => chat().drop());
    await pinging(25_000, chat());
    expect(notice()).toEqual(["You're offline"]);
  });

  // The reviewer's reproductions.
  it("keeps polling and keeps the notice while a replacement that sent only its headers stays silent", async () => {
    const conversationReads = () => reads((path) => path.startsWith("/bots/shared/conversation?"));
    await live();
    const cut = chat();
    await pinging(27_000, cut);
    const replacement = chat();
    expect(replacement).not.toBe(cut);
    // Headers and `retry: 3000`, then nothing: open is not data.
    await act(async () => replacement.connect());
    await advance(20);
    const connected = conversationReads();
    await pinging(60_000, replacement);
    expect(conversationReads(), "the 30-second poll stands in").toBeGreaterThanOrEqual(
      connected + 2,
    );
    expect(notice()).toEqual(["Live updates are delayed"]);
  });

  it("reloads and rebinds the open chat when bootstrap names a new canonical session, which Hermes announces only on the roster", async () => {
    boot = { ...boot, bots: [{ ...boot.bots[0], sessionId: "session-one" }, boot.bots[1]] };
    await live();
    expect(container.textContent).toContain("Existing canonical answer");
    const first = chat();
    // Another device starts a new session. Hermes tells roster watchers, not chat watchers.
    conversation = {
      ...conversation,
      sessionId: "session-two",
      messages: [{ id: "fresh", role: "assistant", text: "Fresh session answer" }],
    };
    boot = { ...boot, bots: [{ ...boot.bots[0], sessionId: "session-two" }, boot.bots[1]] };
    await act(async () => household().emit("roster", "roster"));
    await advance(20);
    expect(container.textContent).toContain("Fresh session answer");
    expect(container.textContent).not.toContain("Existing canonical answer");
    expect(first.readyState, "the old session's stream is replaced").toBe(FakeEventSource.CLOSED);
    expect(chat()).not.toBe(first);
  });

  it("does not rebind for a session named for the first time", async () => {
    await live();
    const first = chat();
    boot = { ...boot, bots: [{ ...boot.bots[0], sessionId: "session-one" }, boot.bots[1]] };
    await act(async () => household().emit("roster", "roster"));
    await advance(20);
    expect(first.readyState, "a session named for the first time is not a new one").toBe(
      FakeEventSource.OPEN,
    );
    expect(FakeEventSource.created.filter((url) => url.includes("/bots/"))).toHaveLength(1);
  });

  // A successful bootstrap read says nothing about the chat's stream, so a new session must not forgive that
  // stream's failures. A roster that names two sessions in turn used to connect again on every change.
  it("keeps the chat stream's retry budget when bootstrap keeps naming a new canonical session", async () => {
    boot = { ...boot, bots: [{ ...boot.bots[0], sessionId: "session-one" }, boot.bots[1]] };
    await live();
    const attempts = () => FakeEventSource.created.filter((url) => url.includes("/bots/")).length;
    const refuse = () =>
      act(async () => {
        for (const item of [...FakeEventSource.streams])
          if (item.url.includes("/bots/")) item.fail();
      });
    await refuse();
    const before = attempts();
    // Twenty changes in 400 ms, inside the first retry's wait of a second or more.
    for (let change = 0; change < 20; change++) {
      const sessionId = change % 2 ? "session-one" : "session-two";
      conversation = {
        ...conversation,
        sessionId,
        messages: [
          { id: `answer-${sessionId}`, role: "assistant", text: `Answer in ${sessionId}` },
        ],
      };
      boot = { ...boot, bots: [{ ...boot.bots[0], sessionId }, boot.bots[1]] };
      await act(async () => household().emit("roster", "roster"));
      await advance(20);
      await refuse();
    }
    // The chat still reloads for each new session.
    expect(container.textContent).toContain("Answer in session-one");
    expect(attempts() - before, "chat stream attempts made by the session changes").toBe(0);
  });

  it("shows one panel, not two, in a chat with no assistant once the connection is lost", async () => {
    boot = { ...boot, bots: [] };
    await live();
    await goOffline();
    expect(notice()).toEqual(["You're offline"]);
  });

  it("shows the notice on Today, which has no composer", async () => {
    boot.preferences = { ...boot.preferences, startPage: "today" };
    await live();
    expect(container.querySelector("textarea")).toBeNull();
    const cut = household();
    await act(async () => cut.drop());
    await pinging(21_000, cut);
    expect(notice()).toEqual(["Live updates are delayed"]);
  });

  // Today is not the assistant's chat: that chat's own failed reads are no news there, and neither is
  // its draft, which is not on screen.
  it("says nothing on Today about the open chat's failed reads, or about its draft when offline", async () => {
    boot.preferences = { ...boot.preferences, startPage: "today" };
    draft = { text: "Buy feed", attachments: [], revision: 1, reason: "edit", sentRevision: 0 };
    await live();
    const serve = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string, ...rest: unknown[]) => {
      if (path.startsWith("/bots/shared/conversation?")) throw new Error("Hermes is restarting.");
      return (serve as (path: string, ...rest: unknown[]) => Promise<T>)(path, ...rest);
    });
    const failed = reads((path) => path.startsWith("/bots/shared/conversation?"));
    await act(async () => chat().emit("message", "change"));
    await pinging(OUTAGE_LASTING_MS);
    expect(
      reads((path) => path.startsWith("/bots/shared/conversation?")),
      "the chat's reads did fail meanwhile",
    ).toBeGreaterThan(failed);
    expect(panels()).toEqual([]);
    await goOffline();
    expect(notice()).toEqual(["You're offline"]);
    expect(panels()[0]!.textContent).not.toMatch(/draft/i);
  });

  // Live updates are back when every stream the notice watches has heard from the server again. One
  // stream returning while the other is still down, and not yet down long enough to show, is not that;
  // the other one returning is.
  it("announces the return of live updates once the stream still down is back too", async () => {
    await live();
    const announced = () => container.querySelector("[data-connection-announcer]")!.textContent;
    const house = household();
    await act(async () => house.drop());
    await pinging(15_000);
    await act(async () => chat().drop());
    await pinging(6_000);
    expect(notice()).toEqual(["Live updates are delayed"]);
    // The household stream's replacement connects and, 5 seconds on, proves itself.
    await act(async () => {
      household().connect();
      household().emit("ping", "10");
    });
    await advance(5_500);
    await act(async () => household().emit("ping", "10"));
    await advance(20);
    expect(panels()).toEqual([]);
    expect(announced()).toBe("");
    // The chat stream's replacement proves itself too, 17 seconds into its outage: never shown.
    await act(async () => {
      chat().connect();
      chat().emit("ping", "10");
    });
    await advance(5_500);
    await act(async () => chat().emit("ping", "10"));
    await advance(20);
    expect(announced()).toBe("Live updates are back.");
  });

  // The loss's own notice stood where the live-updates one would have. Both end together, so the
  // live-updates notice has never been on screen and does not appear now to stay out a minimum time.
  it("shows no live-updates notice once a loss that covered it and the streams come back together", async () => {
    await live();
    const healthy = boot;
    const cut = household();
    boot = { ...boot, connection: { connected: false, code: "unreachable" } };
    await act(async () => cut.drop());
    await act(async () => window.dispatchEvent(new Event("online")));
    await pinging(13_000, cut);
    const back = household();
    await act(async () => {
      back.connect();
      back.emit("ping", "10");
    });
    await pinging(7_000, back);
    expect(notice()).toEqual(["Hermes isn't answering"]);
    await advance(100);
    // One roster notice proves the stream and brings a bootstrap that finds Hermes connected.
    boot = healthy;
    await act(async () => back.emit("roster", "roster"));
    await advance(20);
    expect(panels()).toEqual([]);
  });

  // One chat's stream is down; the person opens another chat, whose stream is not. The first chat's
  // stream did not come back, so nothing says it did.
  it("announces no return of live updates when the chat whose stream is down is left for another", async () => {
    const serve = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string, ...rest: unknown[]) => {
      if (path.startsWith("/bots/other/conversation?"))
        return { ...conversation, botId: "other", draft: null } as T;
      if (path === "/bots/other/draft") return null as T;
      if (path === "/bots/other/routine-runs") return { runs: [], unavailable: [] } as T;
      return (serve as (path: string, ...rest: unknown[]) => Promise<T>)(path, ...rest);
    });
    servePresence();
    await live();
    const cut = chat();
    await act(async () => cut.drop());
    await pinging(21_000, cut);
    expect(notice()).toEqual(["Live updates are delayed"]);
    const other = [
      ...container.querySelectorAll<HTMLElement>('[aria-label="Assistants"] button'),
    ].find((item) => item.textContent?.includes("Other"))!;
    await act(async () => other.click());
    await advance(20);
    expect(panels()).toEqual([]);
    const announced = () => container.querySelector("[data-connection-announcer]")!.textContent;
    expect(announced()).toBe("");
    // The other chat's own stream proving itself is not the first one coming back either.
    const next = chat();
    expect(next).not.toBe(cut);
    await act(async () => {
      next.connect();
      next.emit("ping", "10");
    });
    await advance(5_500);
    await act(async () => next.emit("ping", "10"));
    await advance(20);
    expect(announced()).toBe("");
  });

  // Live updates came back for the household while the chat's stream was still down. A new canonical
  // session then replaces that stream in one go, and the replacement proving itself is not the stream
  // that was down coming back.
  it("announces no return of live updates when the stream still down is replaced for a new session", async () => {
    boot = { ...boot, bots: [{ ...boot.bots[0], sessionId: "session-one" }, boot.bots[1]] };
    await live();
    const announced = () => container.querySelector("[data-connection-announcer]")!.textContent;
    await act(async () => household().drop());
    await pinging(15_000);
    const down = chat();
    await act(async () => down.drop());
    await pinging(6_000);
    expect(notice()).toEqual(["Live updates are delayed"]);
    await act(async () => {
      household().connect();
      household().emit("ping", "10");
    });
    await advance(5_500);
    await act(async () => household().emit("ping", "10"));
    await advance(20);
    expect(panels()).toEqual([]);
    conversation = { ...conversation, sessionId: "session-two" };
    boot = { ...boot, bots: [{ ...boot.bots[0], sessionId: "session-two" }, boot.bots[1]] };
    await act(async () => household().emit("roster", "roster"));
    await advance(20);
    const replacement = chat();
    expect(replacement).not.toBe(down);
    await pinging(3_000, replacement);
    await act(async () => {
      replacement.connect();
      replacement.emit("ping", "10");
    });
    await advance(5_500);
    await act(async () => replacement.emit("ping", "10"));
    await advance(20);
    expect(announced()).toBe("");
  });

  describe("a chat whose own reads fail", () => {
    const failReads = () => {
      const serve = vi.mocked(api).getMockImplementation()!;
      vi.mocked(api).mockImplementation(async <T>(path: string, ...rest: unknown[]) => {
        if (path.startsWith("/bots/shared/conversation?")) throw new Error("Hermes is restarting.");
        return (serve as (path: string, ...rest: unknown[]) => Promise<T>)(path, ...rest);
      });
      return () => vi.mocked(api).mockImplementation(serve);
    };
    const listed = (name: string) =>
      [...container.querySelectorAll<HTMLElement>('[aria-label="Assistants"] button')].find(
        (item) => item.textContent?.includes(name),
      )!;
    const announced = () => container.querySelector("[data-connection-announcer]")!.textContent;

    // Leaving for Today takes the chat's notice off the screen. Nothing came back.
    it("announces no recovery when the person leaves it for Today", async () => {
      await live();
      failReads();
      await act(async () => chat().emit("message", "change"));
      await pinging(OUTAGE_GRACE_MS);
      expect(notice()).toEqual(["Reconnecting…"]);
      await act(async () => listed("Today").click());
      await advance(20);
      expect(container.querySelector(".chat-header-today")).not.toBeNull();
      expect(panels()).toEqual([]);
      expect(announced()).toBe("");
    });

    // A phone's home list covers the chat behind it, which is still the open chat. Its failed reads
    // are no more on screen there than behind Today.
    it("says nothing on a phone's home list, and waits out a grace period when the chat is opened", async () => {
      stubMatchMedia((query) => query === "(max-width: 620px)");
      servePresence();
      await live();
      expect(container.querySelector("main[inert]")).not.toBeNull();
      failReads();
      await act(async () => chat().emit("message", "change"));
      await pinging(OUTAGE_LASTING_MS);
      expect(announced()).toBe("");
      await act(async () => listed("Shared").click());
      await advance(20);
      expect(container.querySelector("main[inert]")).toBeNull();
      expect(panels()).toEqual([]);
      await pinging(OUTAGE_GRACE_MS);
      expect(notice()).toEqual(["Reconnecting…"]);
    });

    // Its notice was never on screen while Today was, so opening the chat is when its loss can first
    // show, after the grace period every loss gets. A read that succeeds inside it shows nothing.
    it("waits out a grace period when it is opened after failing behind Today", async () => {
      boot.preferences = { ...boot.preferences, startPage: "today" };
      await live();
      const restore = failReads();
      await act(async () => chat().emit("message", "change"));
      await pinging(OUTAGE_LASTING_MS);
      await act(async () => listed("Shared").click());
      await advance(20);
      expect(container.querySelector("textarea")).not.toBeNull();
      expect(panels()).toEqual([]);
      await pinging(OUTAGE_GRACE_MS - 1_000);
      expect(panels()).toEqual([]);
      restore();
      await act(async () => chat().emit("message", "change"));
      await pinging(OUTAGE_GRACE_MS);
      expect(panels()).toEqual([]);
      expect(announced()).toBe("");
    });
  });

  it("reads bootstrap every 5 minutes while the household stream is live, and every 45 seconds while it is down", async () => {
    const bootstraps = () => reads((path) => path === "/bootstrap?roster=lean");
    await live();
    const before = bootstraps();
    await pinging(4 * 60_000);
    expect(bootstraps(), "a live stream announces roster changes").toBe(before);
    await pinging(90_000);
    expect(bootstraps()).toBe(before + 1);
    const cut = household();
    await act(async () => cut.drop());
    const down = bootstraps();
    await pinging(90_000, cut);
    expect(bootstraps()).toBe(down + 2);
  });

  // A catalog that says group chats are unsupported changes only with the server, and a server
  // that hosts none sends no notices, so the 30-second poll would read the same answer forever.
  it("reads an unsupported catalog only every 5 minutes", async () => {
    catalog = {
      supported: false,
      canSend: false,
      rooms: [],
      reason: "This Hermes version does not expose hosted group chats.",
    };
    await live();
    const catalogReads = () => reads((path) => path === "/groups");
    const opened = catalogReads();
    await pinging(GROUP_FALLBACK_POLL_MS - 12_000);
    expect(catalogReads()).toBe(opened);
    await pinging(1_000);
    expect(catalogReads()).toBe(opened + 1);
  });

  // The stream drops, the phone sends the draft, and the stream is back before the next poll. The
  // reconnect's conversation read carries the new draft, and nothing else would show it.
  it("takes a draft changed during a reconnect from the read that reconnect makes, so sent text never lingers", async () => {
    draft = { text: "Buy feed", attachments: [], revision: 1, reason: "edit", sentRevision: 0 };
    await live();
    const textarea = () => container.querySelector("textarea")!;
    const draftReads = () => reads((path) => path === "/bots/shared/draft");
    expect(textarea().value).toBe("Buy feed");
    await act(async () => chat().drop());
    // The phone sends it, which clears the shared draft.
    draft = { text: "", attachments: [], revision: 2, reason: "sent", sentRevision: 2 };
    await advance(3_000);
    const before = draftReads();
    await act(async () => {
      chat().connect();
      chat().emit("ping", "10");
    });
    await advance(0);
    expect(textarea().value).toBe("");
    expect(draftReads(), "the conversation read already carried it").toBe(before);
  });
});

// A screen reader hears a connection change through one live region, wherever the person is and however
// wide the window. The sidebar's chip and the notice panels show the state without announcing it again.
describe("the connection live region", () => {
  const LIVE = '[role="status"], [role="alert"], [role="log"], [aria-live]:not([aria-live="off"])';
  /** Live regions a screen reader can reach, outside inert or hidden content, that speak about the connection. */
  const regions = () =>
    [...container.querySelectorAll(LIVE)]
      .filter((region) => !region.closest('[inert], [aria-hidden="true"]'))
      .filter(
        (region) =>
          region.closest('[aria-label="Hermes connection"]') ||
          /offline|reconnect|connection|live updates/i.test(region.textContent ?? ""),
      );
  const views = {
    Today: { url: "/?view=today", shown: () => container.querySelector(".chat-header-today") },
    chat: { url: "/?bot=shared", shown: () => container.querySelector("textarea") },
    "group chat": {
      url: "/?view=group&room=supper",
      shown: () =>
        container.querySelector(".chat-title h1")?.textContent === "Supper" ? true : null,
    },
  };
  const states = {
    online: async () => {},
    offline: goOffline,
    "with live updates down": async () => {
      const cut = household();
      await act(async () => cut.drop());
      await pinging(21_000, cut);
    },
  };
  const cases = (Object.keys(views) as (keyof typeof views)[]).flatMap((view) =>
    ["desktop", "phone"].flatMap((width) =>
      (Object.keys(states) as (keyof typeof states)[]).map(
        (state) => [view, width, state] as const,
      ),
    ),
  );
  it.each(cases)(
    "on %s at %s width %s, one region announces the connection",
    async (view, width, state) => {
      if (width === "phone") stubMatchMedia((query) => query === "(max-width: 620px)");
      history.replaceState(null, "", views[view].url);
      await live();
      expect(views[view].shown(), `the ${view} view is open`).toBeTruthy();
      await states[state]();
      expect(regions()).toHaveLength(state === "online" ? 0 : 1);
    },
  );

  it("is in the page before the connection changes, so the change is announced, on the phone home list too", async () => {
    stubMatchMedia((query) => query === "(max-width: 620px)");
    await live();
    // A phone opens on the home list, which covers the view behind it.
    expect(container.querySelector("main[inert]")).not.toBeNull();
    const region = container.querySelector("[data-connection-announcer]");
    expect(region?.textContent).toBe("");
    const cut = household();
    await act(async () => cut.drop());
    await pinging(21_000, cut);
    expect(regions()).toEqual([region]);
    expect(region!.textContent).toContain("Live updates are delayed");
    await goOffline();
    expect(regions()).toEqual([region]);
    expect(region!.textContent).toContain("You're offline");
  });
});
