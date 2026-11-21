// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api, ApiError, write } from "../src/client-api";
import {
  CHECKING_CONNECTION,
  NOT_SENT_CHECKING,
  READ_RETRY_MS,
  WAITING_FOR_CONNECTION,
  WAITING_WITH_DRAFT,
} from "../src/app/use-conversation";
import { OUTAGE_GRACE_MS, OUTAGE_LASTING_MS, OUTAGE_MIN_SHOWN_MS } from "../src/app/outage";
import { RESTORED_MS } from "../src/components/ConnectionPanel";
import { ROSTER_CARRY_MS } from "../src/app/use-session";
import { defaultPreferences, type Bootstrap, type Conversation } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import {
  advance,
  mountRoot,
  renderedProps,
  stubMatchMedia,
  typeInto,
  type Mount,
} from "./ui-harness";

// Only the network is replaced. Every request a test did not list fails loudly; see `unexpected`.
vi.mock("../src/client-api", async (original) =>
  (await import("./helpers/request-mock")).withRequest({
    ...(await original<typeof import("../src/client-api")>()),
    api: vi.fn(),
    write: vi.fn(),
  }),
);
// Each text React Markdown parses, in order. remark-gfm is the plugin the app hands every parse; this
// runs it unchanged and adds a step that records the source, so the real parser and components run.
const parses = vi.hoisted(() => [] as string[]);
vi.mock("remark-gfm", async (original) => {
  const real = (await original<typeof import("remark-gfm")>()).default;
  return {
    default: function (this: unknown, ...args: Parameters<typeof real>) {
      real.apply(this as never, args);
      return (_tree: unknown, file: { value: unknown }) => {
        parses.push(String(file.value));
      };
    },
  };
});

let mount: Mount, container: HTMLDivElement, boot: Bootstrap, conversation: Conversation;
// What the next conversation read throws, as the client API reports it; undefined answers it.
let failure: Error | undefined;
let unexpected: string[];
let draftRevision: number;
// While set, a conversation read waits on it before it is answered.
let held: Promise<void> | undefined;
// A request that never reached the app, as the client API reports a failed fetch: it may be a blip.
const blip = () =>
  new ApiError(
    "Can't reach the app. We'll reconnect automatically.",
    503,
    "CONNECTION_UNAVAILABLE",
  );
const form =
  "```agent-ui\n" +
  JSON.stringify({
    version: 1,
    cards: [
      {
        id: "gate",
        type: "form",
        title: "Gate check",
        fields: [{ id: "state", label: "State", kind: "text", required: true }],
      },
    ],
  }) +
  "\n```";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 10, 15));
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
  failure = undefined;
  held = undefined;
  unexpected = [];
  draftRevision = 0;
  parses.length = 0;
  boot = {
    user: { id: "one", name: "One", email: "one@example.test" },
    household: [],
    preferences: { ...structuredClone(defaultPreferences), startPage: "assistant" },
    bots: [{ id: "shared", name: "Shared", shared: true, model: "test", activity: "idle" }],
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
      if (path.startsWith("/bots/shared/conversation?")) {
        if (held) await held;
        if (failure) throw failure;
        return conversation as T;
      }
      if (path === "/bots/shared/draft") return { text: "", attachments: [] } as T;
      if (path === "/bots/shared/routine-runs") return { runs: [], unavailable: [] } as T;
      if (path === "/groups") return { supported: true, canSend: true, rooms: [] } as T;
      // A form card looks up its own unsent request; the server answers an ID it never saw as uncertain.
      if (path.startsWith("/submissions/"))
        return { requestId: path.slice("/submissions/".length), status: "uncertain" } as T;
      unexpected.push(`GET ${path}`);
      throw new Error(`This test serves no GET ${path}`);
    });
  vi.mocked(write)
    .mockReset()
    .mockImplementation(async <T>(path: string, body: unknown, method = "POST") => {
      // Presence and device activity report on their own schedule; any other write is a test failure.
      if (method === "PUT" && (path === "/bots/shared/presence" || path === "/devices/activity"))
        return {} as T;
      // A typed draft saves itself, and the server answers the copy it kept under the next revision.
      if (method === "PUT" && path === "/bots/shared/draft") {
        const { text, attachments } = body as { text: string; attachments: [] };
        return {
          text,
          attachments,
          revision: ++draftRevision,
          reason: "edit",
          sentRevision: 0,
        } as T;
      }
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

// A change notice asks for a read, which then fails or succeeds.
const read = async () => {
  await act(async () => FakeEventSource.notifyAll());
  await advance(0);
};
// The household stream reports a change, so the session reads the roster again. It is the stream at
// /api/events that names no group; its query, such as the ping interval it asks for, is not part of that.
const household = (url: string) => {
  const at = new URL(url, "http://app.test");
  return at.pathname === "/api/events" && !at.searchParams.has("group");
};
const rosterChanged = async () => {
  const streams = [...FakeEventSource.streams].filter((stream) => household(stream.url));
  // A helper that finds no stream would leave the roster unread and the test asserting on stale state.
  expect(streams.length).toBeGreaterThan(0);
  await act(async () => {
    for (const stream of streams) stream.emit("message", "change");
  });
  await advance(0);
};
const notice = () => container.querySelector('[aria-label="Hermes connection"]');
const shown = () => notice() !== null;
const says = () => notice()?.querySelector("h2")?.textContent;
const reconnectNow = () =>
  [...(notice()?.querySelectorAll("button") ?? [])].find(
    (item) => item.textContent === "Reconnect now",
  );
const announced = () => container.querySelector("[data-connection-announcer]")!.textContent;
// Whose avatars show the connection as lost, by the name each avatar is labeled with: in the list of
// assistants, and in the open chat.
const dimmedIn = (selector: string) =>
  new Set(
    [...container.querySelectorAll(`${selector} .avatar-wrap[data-state="disconnected"]`)].map(
      (avatar) => avatar.getAttribute("aria-label")!.split(":")[0],
    ),
  );
const dimmedInList = () => dimmedIn('[aria-label="Assistants"]');
const dimmedInChat = () => dimmedIn("main");
const conversationReads = () =>
  vi
    .mocked(api)
    .mock.calls.filter(([path]) => String(path).startsWith("/bots/shared/conversation?")).length;
const sendButton = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Send"]')!;
const stopButton = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Stop response"]')!;
const status = () => container.querySelector("#composer-paste-status")!;
const opened = async () => {
  await mount.render(createElement(App));
  await advance(20);
  expect(container.querySelector(".transcript [data-message-id]")).not.toBeNull();
  expect(shown()).toBe(false);
};
const submitWithKeyboard = (field: HTMLTextAreaElement) =>
  act(async () => {
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
const sends = () =>
  vi
    .mocked(write)
    .mock.calls.filter(([path]) => /^\/bots\/shared\/(messages|stop)/.test(String(path)));

describe("a failed conversation read", () => {
  it("shows nothing for one failure that the next read answers", async () => {
    await opened();
    failure = blip();
    await read();
    await advance(OUTAGE_GRACE_MS - 1);
    failure = undefined;
    await read();
    await advance(OUTAGE_GRACE_MS);
    expect(shown()).toBe(false);
  });

  // The app's one connection announcement follows what the chat shows, not the first failed read, so a
  // blip that changes nothing on screen says nothing to a screen reader either. Someone who did hear of
  // a loss hears that it is over.
  it("announces the loss only once the chat shows it, and that it is over once it is", async () => {
    await opened();
    failure = blip();
    await read();
    await advance(OUTAGE_GRACE_MS - 1);
    expect(shown()).toBe(false);
    expect(announced()).toBe("");
    await advance(1);
    expect(shown()).toBe(true);
    expect(announced()).toBe("Reconnecting…");
    await advance(OUTAGE_MIN_SHOWN_MS);
    failure = undefined;
    await read();
    expect(shown()).toBe(false);
    expect(announced()).toBe("Connected again.");
    await advance(RESTORED_MS);
    expect(announced()).toBe("");
  });

  // The notice above the composer is rebuilt when the roster is read again. It follows what the chat shows
  // then too, not the failed read that is still inside its grace period.
  it("keeps the notice away through a roster refresh during the grace period", async () => {
    await opened();
    failure = blip();
    await read();
    await rosterChanged();
    expect(shown()).toBe(false);
  });

  // Opening a chat asks for two reads back to back, so two failures can be milliseconds apart. Only time
  // shows the loss, and the retries inside the grace period do not bring it forward.
  it("shows it once reads have failed for 3 seconds, however many failed, not a millisecond sooner", async () => {
    await opened();
    failure = blip();
    await read();
    await read();
    await advance(OUTAGE_GRACE_MS - 1);
    expect(shown()).toBe(false);
    await advance(1);
    expect(shown()).toBe(true);
  });

  // The server's own word that Hermes is unreachable can be one request that timed out, with Hermes and
  // every other chat fine. It used to show the whole app as disconnected at once.
  it("waits out a failure the server blames on Hermes like any other", async () => {
    await opened();
    failure = new ApiError("The Hermes operation could not be completed", 502, "unreachable");
    await read();
    expect(shown()).toBe(false);
    await advance(OUTAGE_GRACE_MS);
    expect(shown()).toBe(true);
  });

  it("says one plain line at first, then names the reason and offers a retry once the loss has lasted 10 seconds", async () => {
    await opened();
    failure = blip();
    await read();
    await advance(OUTAGE_LASTING_MS - 1);
    expect(says()).toBe("Reconnecting…");
    expect(notice()!.querySelector("p")).toBeNull();
    expect(reconnectNow()).toBeUndefined();
    await advance(1);
    expect(says()).toBe("Can't refresh this chat");
    expect(reconnectNow()).toBeDefined();
    expect(announced()).toBe(
      "Can't refresh this chat. New messages may not show yet. We'll keep trying.",
    );
  });

  // A loss that ends just as its notice appears would flash it. The notice stays a second; what it
  // refused does not wait for it.
  it("keeps a notice that just appeared for a second, while Send works again at once", async () => {
    await opened();
    await typeInto(container.querySelector("textarea")!, "Check the gate");
    failure = blip();
    await read();
    await advance(OUTAGE_GRACE_MS);
    expect(shown()).toBe(true);
    failure = undefined;
    await read();
    expect(sendButton().disabled).toBe(false);
    await advance(OUTAGE_MIN_SHOWN_MS - 1);
    expect(shown()).toBe(true);
    await advance(1);
    expect(shown()).toBe(false);
  });

  describe("with another assistant on the roster", () => {
    // What the other assistant's first read throws; undefined answers it.
    let otherFailure: Error | undefined;
    beforeEach(() => {
      otherFailure = undefined;
      boot = {
        ...boot,
        bots: [
          ...boot.bots,
          { id: "other", name: "Other", shared: true, model: "test", activity: "working" },
        ],
      };
      const serve = vi.mocked(api).getMockImplementation()!;
      vi.mocked(api).mockImplementation(async <T>(path: string, ...rest: unknown[]) => {
        if (path.startsWith("/bots/other/conversation?")) {
          if (otherFailure) throw otherFailure;
          return {
            botId: "other",
            messages: [{ id: "other-answer", role: "assistant", text: "Other's answer" }],
            approvals: [],
            files: [],
            activity: { state: "idle" },
          } as T;
        }
        if (path === "/bots/other/draft") return { text: "", attachments: [] } as T;
        if (path === "/bots/other/routine-runs") return { runs: [], unavailable: [] } as T;
        return (serve as (path: string, ...rest: unknown[]) => Promise<T>)(path, ...rest);
      });
      const send = vi.mocked(write).getMockImplementation()!;
      vi.mocked(write).mockImplementation(
        async <T>(path: string, body: unknown, method = "POST") => {
          if (method === "PUT" && path === "/bots/other/presence") return {} as T;
          // Leaving a chat saves where the reader was, and the server answers the position it kept.
          if (method === "PUT" && /^\/bots\/(shared|other)\/read-position$/.test(path))
            return body as T;
          return (send as (path: string, body: unknown, method: string) => Promise<T>)(
            path,
            body,
            method,
          );
        },
      );
    });
    const openOther = async () => {
      const row = [
        ...container.querySelectorAll<HTMLElement>('[aria-label="Assistants"] button'),
      ].find((item) => item.textContent?.includes("Other"))!;
      await act(async () => row.click());
      await advance(0);
    };

    // The app and Hermes answer bootstrap, so the failure is this chat's alone. The list of assistants
    // is the roster's news: it neither dims the open one nor says "Reconnecting" under it.
    it("shows a chat whose own reads fail in that chat alone", async () => {
      await opened();
      failure = blip();
      await read();
      await advance(OUTAGE_LASTING_MS);
      expect(says()).toBe("Can't refresh this chat");
      expect(dimmedInChat()).toEqual(new Set(["Shared"]));
      expect(dimmedInList()).toEqual(new Set());
      expect(container.querySelector('[aria-label="Assistants"]')!.textContent).not.toContain(
        "Reconnecting",
      );
    });

    // A failed read asks bootstrap what is down. While Hermes is down the server lists its rows as
    // disconnected, and those must not dim anything before the loss shows.
    it("shows every assistant as disconnected once bootstrap says Hermes is down, and not before the loss shows", async () => {
      await opened();
      failure = new ApiError("The Hermes operation could not be completed", 502, "unreachable");
      boot = {
        ...boot,
        bots: boot.bots.map((bot) => ({ ...bot, activity: "disconnected" as const })),
        connection: { connected: false, code: "unreachable" },
      };
      await read();
      await advance(OUTAGE_GRACE_MS - 1);
      expect(shown()).toBe(false);
      expect(dimmedInList()).toEqual(new Set());
      expect(container.querySelector('[aria-label="Assistants"]')!.textContent).toContain(
        "Working",
      );
      await advance(OUTAGE_LASTING_MS);
      expect(says()).toBe("Hermes isn't answering");
      expect(dimmedInList()).toEqual(new Set(["Shared", "Other"]));
      expect(container.querySelector(".home-sync")?.textContent).toBe("Reconnecting");
    });

    // Who is on the roster is the server's word, outage or not. It filters its last roster for each
    // member even while Hermes is down, so an assistant another member made private goes at once.
    it("takes the server's roster during an outage, so an assistant made private goes at once", async () => {
      await opened();
      failure = new ApiError("The Hermes operation could not be completed", 502, "unreachable");
      boot = {
        ...boot,
        bots: [{ ...boot.bots[0]!, activity: "disconnected" }],
        connection: { connected: false, code: "unreachable" },
      };
      await read();
      const rows = [...container.querySelectorAll('[aria-label="Assistants"] button')].map(
        (row) => row.textContent ?? "",
      );
      expect(rows.some((row) => row.includes("Shared"))).toBe(true);
      expect(rows.some((row) => row.includes("Other"))).toBe(false);
    });

    // A roster read can fail while Hermes stays connected. The server then lists its last roster with
    // every row marked disconnected, which says the roster is stale, not that anything changed.
    it("keeps what each assistant was doing when the server could not refresh the roster", async () => {
      await opened();
      boot = {
        ...boot,
        bots: boot.bots.map((bot) => ({ ...bot, activity: "disconnected" as const })),
      };
      await rosterChanged();
      expect(dimmedInList()).toEqual(new Set());
      expect(container.querySelector('[aria-label="Assistants"]')!.textContent).toContain(
        "Working",
      );
      expect(shown()).toBe(false);
    });

    // Hermes connected, but the server has had no roster from it yet: it lists none, and says it does not
    // know. That is no reason to drop every assistant or close the open chat. A known empty roster is.
    it("keeps the assistants and the open chat through an unknown roster, and drops them for a known empty one", async () => {
      await opened();
      const names = boot.bots.map((bot) => bot.name);
      const listed = () =>
        names.filter((name) =>
          [...container.querySelectorAll('[aria-label="Assistants"] button')].some((row) =>
            row.textContent?.includes(name),
          ),
        );
      const chatOpen = () => container.querySelector(".transcript [data-message-id]") !== null;
      expect(listed()).toEqual(names);
      boot = { ...boot, bots: [], rosterUnknown: true };
      await rosterChanged();
      expect(listed()).toEqual(names);
      expect(chatOpen()).toBe(true);
      expect(container.textContent).not.toContain("no longer available");
      boot = { ...boot, rosterUnknown: false };
      await rosterChanged();
      expect(listed()).toEqual([]);
      expect(chatOpen()).toBe(false);
    });

    // Hermes went down after another member made this member's last assistant private. The server knows
    // the roster and lists no one, which is that member's roster now. An older server, which does not
    // say whether it knows, sends the same empty list with no roster at all, which keeps the rows.
    it("takes a known empty roster while Hermes is down, and keeps the rows when the server does not say", async () => {
      await opened();
      const names = boot.bots.map((bot) => bot.name);
      const listed = () =>
        names.filter((name) =>
          [...container.querySelectorAll('[aria-label="Assistants"] button')].some((row) =>
            row.textContent?.includes(name),
          ),
        );
      const { rosterUnknown: _, ...older } = boot;
      boot = { ...older, bots: [], connection: { connected: false, code: "unreachable" } };
      await rosterChanged();
      expect(listed()).toEqual(names);
      boot = { ...boot, rosterUnknown: false };
      await rosterChanged();
      expect(listed()).toEqual([]);
    });

    // The connection coming back is said when it comes back. The notice staying out its second, and
    // whatever the person opens during it, change nothing about that.
    it("says the connection is back when it is, even if another chat is opened while the notice lingers", async () => {
      await opened();
      failure = blip();
      await read();
      await advance(OUTAGE_GRACE_MS);
      failure = undefined;
      await read();
      expect(shown()).toBe(true);
      expect(announced()).toBe("Connected again.");
      await openOther();
      expect(announced()).toBe("Connected again.");
    });

    // The app comes back while this chat's own reads still fail. The chat's warning is what is being
    // said then, so nothing is kept to say later, as when the person opens another chat.
    it("keeps no word of a recovery behind another warning to say once that warning is gone", async () => {
      await opened();
      const healthy = boot;
      failure = new ApiError("The Hermes operation could not be completed", 502, "unreachable");
      boot = { ...boot, connection: { connected: false, code: "unreachable" } };
      await read();
      await advance(OUTAGE_LASTING_MS);
      expect(says()).toBe("Hermes isn't answering");
      // Hermes is back; this chat's reads still fail.
      boot = healthy;
      await rosterChanged();
      await advance(OUTAGE_MIN_SHOWN_MS);
      expect(says()).toBe("Can't refresh this chat");
      await openOther();
      expect(shown()).toBe(false);
      expect(announced()).toBe("");
    });

    // Bootstraps are minutes apart while all is well, so the half minute counts from the first stale
    // roster, not from the last fresh one.
    it("keeps what each assistant was doing through one stale roster long after the last fresh one", async () => {
      await opened();
      const fresh = boot;
      const stale = {
        ...boot,
        bots: boot.bots.map((bot) => ({ ...bot, activity: "disconnected" as const })),
      };
      // An earlier stale roster that a fresh one followed is over and done with.
      boot = stale;
      await rosterChanged();
      boot = fresh;
      await rosterChanged();
      await advance(ROSTER_CARRY_MS + 5_000);
      boot = stale;
      await rosterChanged();
      expect(dimmedInList()).toEqual(new Set());
      expect(container.querySelector('[aria-label="Assistants"]')!.textContent).toContain(
        "Working",
      );
    });

    // The server says a roster is stale by marking its rows disconnected. Stale for a moment keeps
    // what each assistant was doing; stale for half a minute is no longer known, and says so.
    it("stops carrying what an assistant was doing once the roster has been stale for 30 seconds", async () => {
      await opened();
      boot = {
        ...boot,
        bots: boot.bots.map((bot) => ({ ...bot, activity: "disconnected" as const })),
      };
      await rosterChanged();
      await advance(ROSTER_CARRY_MS - 2_000);
      expect(dimmedInList()).toEqual(new Set());
      // The stale roster is read again on the retries a failed bootstrap gets; the one past 30 seconds
      // decides. The open chat's own read still says what its assistant is doing.
      await advance(4_000);
      expect(dimmedInList()).toEqual(new Set(["Other"]));
      // Hermes still answers, so the app itself reports no loss.
      expect(container.querySelector(".home-sync")).toBeNull();
    });

    // Leaving a chat is not its connection coming back.
    it("does not carry one chat's notice, or a recovery that never happened, into the next chat", async () => {
      await opened();
      failure = blip();
      await read();
      await advance(OUTAGE_GRACE_MS);
      expect(shown()).toBe(true);
      await openOther();
      expect(container.textContent).toContain("Other's answer");
      expect(shown()).toBe(false);
      expect(announced()).toBe("");
    });

    it("times the next chat's own failed read from its own start", async () => {
      await opened();
      failure = blip();
      await read();
      await advance(OUTAGE_GRACE_MS);
      expect(shown()).toBe(true);
      otherFailure = blip();
      await openOther();
      expect(shown()).toBe(false);
      await advance(OUTAGE_GRACE_MS - 1);
      expect(shown()).toBe(false);
      await advance(1);
      expect(shown()).toBe(true);
    });
  });

  describe("retrying", () => {
    // With its stream live, the chat would not read again for two minutes: the loss would show for all
    // of them after one blip, and the message the failed read was asked for would wait as long.
    it("reads again 1, 2 and 4 seconds after failed reads in a row, and stops once one succeeds", async () => {
      await opened();
      failure = blip();
      await read();
      const first = conversationReads();
      await advance(READ_RETRY_MS[0] - 1);
      expect(conversationReads()).toBe(first);
      await advance(1);
      expect(conversationReads()).toBe(first + 1);
      await advance(READ_RETRY_MS[1] - 1);
      expect(conversationReads()).toBe(first + 1);
      await advance(1);
      expect(conversationReads()).toBe(first + 2);
      failure = undefined;
      await advance(READ_RETRY_MS[2] - 1);
      expect(shown()).toBe(true);
      await advance(1);
      expect(conversationReads()).toBe(first + 3);
      expect(shown()).toBe(false);
      // The read that succeeded set no retry of its own.
      await advance(READ_RETRY_MS[3]);
      expect(conversationReads()).toBe(first + 3);
    });

    it("starts the waits over after a success", async () => {
      await opened();
      failure = blip();
      await read();
      await advance(READ_RETRY_MS[0] + READ_RETRY_MS[1]);
      // A change notice's read succeeds while the third retry is still 4 seconds off: that retry is dropped.
      failure = undefined;
      await read();
      const settled = conversationReads();
      await advance(READ_RETRY_MS[2]);
      expect(conversationReads()).toBe(settled);
      failure = blip();
      await read();
      const before = conversationReads();
      await advance(READ_RETRY_MS[0]);
      expect(conversationReads()).toBe(before + 1);
    });

    // A change notice can ask for a read just before the retry is due. That read is the retry: a second
    // one queued behind it would read again after the connection is already back.
    it("lets a read already on its way stand in for the retry, with no second read behind it", async () => {
      await opened();
      failure = blip();
      await read();
      const before = conversationReads();
      await advance(READ_RETRY_MS[0] - 1);
      failure = undefined;
      let answer!: () => void;
      held = new Promise<void>((resolve) => {
        answer = resolve;
      });
      await read();
      expect(conversationReads()).toBe(before + 1);
      // The retry falls due while that read is still on its way.
      await advance(2);
      held = undefined;
      await act(async () => answer());
      await advance(0);
      expect(shown()).toBe(false);
      expect(conversationReads()).toBe(before + 1);
    });

    // Being shown again or back online reads anyway, so a retry made meanwhile would only fail.
    it.each([
      ["the device is offline", () => vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)],
      [
        "the page is hidden",
        () => vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"),
      ],
    ])("makes no retry while %s", async (_name, away) => {
      await opened();
      failure = blip();
      await read();
      const before = conversationReads();
      const spy = away();
      await advance(READ_RETRY_MS[0] + READ_RETRY_MS[1]);
      spy.mockRestore();
      expect(conversationReads()).toBe(before);
    });
  });

  // The notice stays a second after the connection is back so that it never flashes. Nothing it used to
  // stand in for may stay refused, or become allowed, because of that second.
  it("keeps Send refusing guidance the assistant cannot take while the notice lingers after the connection is back", async () => {
    boot = {
      ...boot,
      capabilities: {
        ...boot.capabilities,
        steering: { supported: false, reason: "This Hermes cannot take guidance mid-task." },
      },
    };
    await opened();
    failure = blip();
    await read();
    await advance(OUTAGE_GRACE_MS);
    // The read that ends the loss finds the assistant at work.
    conversation = { ...conversation, activity: { state: "working", runId: "run-1" } };
    failure = undefined;
    await read();
    await typeInto(container.querySelector("textarea")!, "Check the gate");
    expect(shown()).toBe(true);
    expect(sendButton().getAttribute("aria-label")).toBe("Send guidance");
    expect(sendButton().disabled).toBe(true);
  });

  // The live region speaks when the connection changes. Typing is not a connection change.
  it("announces a lasting loss once, however the draft changes meanwhile", async () => {
    await opened();
    const field = container.querySelector("textarea")!;
    failure = blip();
    await read();
    await advance(OUTAGE_LASTING_MS);
    const said = announced();
    expect(said).toBe("Can't refresh this chat. New messages may not show yet. We'll keep trying.");
    await typeInto(field, "Check the gate");
    expect(notice()!.textContent).toContain("Your draft is kept.");
    expect(announced()).toBe(said);
    await typeInto(field, "");
    expect(announced()).toBe(said);
  });

  it("says the draft is kept in the announcement when the loss finds one in the message box", async () => {
    await opened();
    await typeInto(container.querySelector("textarea")!, "Check the gate");
    failure = blip();
    await read();
    await advance(OUTAGE_LASTING_MS);
    expect(announced()).toBe(
      "Can't refresh this chat. New messages may not show yet. Your draft is kept. We'll keep trying.",
    );
  });

  // Going offline is waited out like any loss. Until it shows, nothing on screen may say it either.
  it("keeps saying what the assistant is doing while going offline is still inside its grace period", async () => {
    conversation = { ...conversation, activity: { state: "working", runId: "run-1" } };
    await opened();
    const activity = () => container.querySelector(".conversation-activity")?.textContent;
    expect(activity()).toContain("Shared is working...");
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    await act(async () => window.dispatchEvent(new Event("offline")));
    await advance(OUTAGE_GRACE_MS - 1);
    expect(activity()).toContain("Shared is working...");
    await advance(1);
    expect(says()).toBe("You're offline");
    expect(activity()).toBeUndefined();
  });

  // A chat that was never read is not known to be empty, so it must not offer to start one.
  it("says a chat that never loaded has not loaded, instead of calling it empty", async () => {
    failure = blip();
    await mount.render(createElement(App));
    await advance(OUTAGE_GRACE_MS - 1);
    expect(container.querySelector(".transcript")!.textContent).toBe("Opening your conversation…");
    await advance(1);
    expect(container.querySelector(".transcript h2")?.textContent).toBe(
      "This conversation hasn't loaded yet",
    );
    expect(container.textContent).not.toContain("Start with Shared's role");
    failure = undefined;
    await advance(READ_RETRY_MS[2]);
    expect(container.querySelector(".transcript [data-message-id]")).not.toBeNull();
  });

  it("refuses a send and a stop during the grace period, says why, and allows them once a read succeeds", async () => {
    conversation = { ...conversation, activity: { state: "working", runId: "run-1" } };
    await opened();
    failure = blip();
    await read();
    expect(shown()).toBe(false);
    const field = container.querySelector("textarea")!;
    // With an empty draft a running reply offers Stop; with words, Send guidance. A disabled button's
    // title is its tooltip and, beside its label, what a screen reader reads as its description.
    await typeInto(field, "");
    expect(stopButton().disabled).toBe(true);
    expect(stopButton().title).toBe(CHECKING_CONNECTION);
    await typeInto(field, "Check the gate");
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().title).toBe(CHECKING_CONNECTION);
    // Nothing visible appears until the person tries to send.
    expect(status().textContent).toBe("");
    await submitWithKeyboard(field);
    // The composer's status line, a polite live region that is always present, says it once.
    expect(status().textContent).toBe(NOT_SENT_CHECKING);
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(sends()).toEqual([]);
    expect(field.getAttribute("aria-describedby")).toBe("composer-paste-status");
    failure = undefined;
    await read();
    expect(sendButton().disabled).toBe(false);
    expect(sendButton().hasAttribute("title")).toBe(false);
    await typeInto(field, "");
    expect(status().textContent).toBe("");
    expect(stopButton().disabled).toBe(false);
    expect(stopButton().title).toBe("Stop response");
  });

  it("hands the explanation to the connection notice once the chat shows it is down", async () => {
    await opened();
    failure = blip();
    await read();
    const field = container.querySelector("textarea")!;
    await typeInto(field, "Check the gate");
    await submitWithKeyboard(field);
    expect(status().textContent).toBe(NOT_SENT_CHECKING);
    await advance(OUTAGE_GRACE_MS);
    expect(shown()).toBe(true);
    // One notice explains it: the status line clears, and a refused send adds nothing to it.
    expect(status().textContent).toBe("");
    await submitWithKeyboard(field);
    expect(status().textContent).toBe("");
    expect(sends()).toEqual([]);
    // Send reassures about the draft only while there is one.
    expect(sendButton().title).toBe(WAITING_WITH_DRAFT);
    await typeInto(field, "  ");
    expect(sendButton().title).toBe(WAITING_FOR_CONNECTION);
  });

  // The notice says a draft is kept only when the message box holds one.
  it("mentions the draft in the notice only while there is one", async () => {
    await opened();
    const field = container.querySelector("textarea")!;
    failure = blip();
    await read();
    await advance(OUTAGE_LASTING_MS);
    expect(notice()!.textContent).not.toContain("draft");
    await typeInto(field, "Check the gate");
    expect(notice()!.querySelector("p")!.textContent).toBe(
      "New messages may not show yet. Your draft is kept. We'll keep trying.",
    );
    await typeInto(field, "");
    expect(notice()!.textContent).not.toContain("draft");
  });

  it.each([
    ["still in its grace period", false],
    ["already shown as disconnected", true],
  ])(
    "stops counting a failure once its chat is gone, so the empty state offers setup: %s",
    async (_name, alreadyShown) => {
      await opened();
      failure = blip();
      await read();
      if (alreadyShown) await advance(OUTAGE_GRACE_MS);
      expect(shown()).toBe(alreadyShown);
      // The household refresh removes the last assistant while the chat's read is still failing.
      boot = { ...boot, bots: [] };
      await rosterChanged();
      expect(container.querySelector("[data-message-id]")).toBeNull();
      // Long past the grace period, and the failure belonged to a chat that no longer exists.
      await advance(OUTAGE_GRACE_MS * 2);
      expect(shown()).toBe(false);
      // The transcript's own button; the home list has one too.
      const create = [...container.querySelectorAll(".transcript button")].find(
        (item) => item.textContent?.trim() === "Create an assistant",
      ) as HTMLButtonElement;
      expect(create.disabled).toBe(false);
      expect(create.hasAttribute("title")).toBe(false);
      // jsdom has no modal dialogs.
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
        configurable: true,
        value: function (this: HTMLDialogElement) {
          this.open = true;
        },
      });
      Object.defineProperty(HTMLDialogElement.prototype, "close", {
        configurable: true,
        value: function (this: HTMLDialogElement) {
          this.open = false;
        },
      });
      await act(async () => create.click());
      await act(async () => {
        await vi.dynamicImportSettled();
      });
      expect(document.querySelector("dialog[open]")?.textContent).toContain("assistant");
    },
  );

  it("re-parses only the replies that show the connection, and re-renders only the turns that do", async () => {
    const ask = (id: string, text: string) => ({
      id,
      role: "user" as const,
      text,
      sender: { id: "one", name: "One" },
    });
    conversation = {
      ...conversation,
      activity: { state: "working", runId: "run-1" },
      messages: [
        ask("q1", "Is the gate shut?"),
        { id: "a1", role: "assistant", text: "The **north gate** is shut." },
        ask("q2", "Check it for me"),
        { id: "p2", role: "assistant", interim: true, text: "Let me write up a *short* form." },
        { id: "a2", role: "assistant", text: `Fill this in.\n\n${form}` },
        ask("q3", "Watch the barn"),
        {
          id: "t3",
          role: "tool",
          text: "",
          toolCall: { id: "watch", name: "terminal", status: "running" },
        },
        { id: "a3", role: "assistant", text: "Watching the *barn* now." },
      ],
    };
    await opened();
    // Which reply each parse since the last check belonged to.
    const parsedSince = () =>
      parses
        .splice(0)
        .map(
          (text) =>
            conversation.messages.find(
              (message) => message.role === "assistant" && message.text.includes(text.trim()),
            )?.id ?? text,
        );
    expect(new Set(parsedSince())).toEqual(new Set(["a1", "p2", "a2", "a3"]));
    // The first turn shows neither a card nor a running tool. Its rows only render with their turn, and
    // no public API reports a skipped render, so this reads the props object React keeps on each row:
    // renderedProps throws if a React upgrade stops keeping it, rather than passing.
    const first = container
      .querySelector<HTMLElement>('[data-message-id="a1"]')!
      .closest<HTMLElement>(".conversation-turn")!;
    const quiet = [first, ...first.querySelectorAll<HTMLElement>(":scope > article")];
    expect(quiet).toHaveLength(3);
    const before = quiet.map(renderedProps);
    const quietRendered = () =>
      quiet.some((element, index) => renderedProps(element) !== before[index]);
    const submit = () =>
      container.querySelector<HTMLButtonElement>(
        '[data-message-id="a2"] .reply-cards button[type="submit"]',
      )!;
    const lastSeen = () =>
      container.querySelector('[data-message-id="a3"]')!.closest(".conversation-turn")!.textContent;
    expect(submit().disabled).toBe(false);
    // One failure: the card refuses at once, and only its block parses again.
    failure = blip();
    await read();
    expect(submit().disabled).toBe(true);
    expect(parsedSince()).toEqual(["a2"]);
    expect(quietRendered()).toBe(false);
    expect(lastSeen()).not.toContain("Last seen running");
    // The connection is down: the running tool says so, and no reply parses again.
    await advance(OUTAGE_GRACE_MS);
    expect(shown()).toBe(true);
    expect(lastSeen()).toContain("Last seen running");
    expect(parsedSince()).toEqual([]);
    expect(quietRendered()).toBe(false);
    failure = undefined;
    await read();
    expect(submit().disabled).toBe(false);
    expect(parsedSince()).toEqual(["a2"]);
    expect(quietRendered()).toBe(false);
  });
});
