// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api } from "../src/client-api";
import { ANCHOR_GAP } from "../src/app/scroll-follow";
import { defaultPreferences } from "../src/shared/types";
import type { Bootstrap, Conversation, Message } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { advance, mountRoot, stubMatchMedia } from "./ui-harness";

vi.mock("../src/client-api", async (original) =>
  (await import("./helpers/request-mock")).withRequest(
    {
      ...(await original<typeof import("../src/client-api")>()),
      api: vi.fn(),
      write: vi.fn().mockResolvedValue({}),
      clearResponseCache: vi.fn(),
    },
    { heartbeats: false },
  ),
);

const bootstrap: Bootstrap = {
  user: { id: "one", name: "One", email: "one@example.test" },
  household: [],
  preferences: { ...defaultPreferences, startPage: "assistant" },
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
  csrfToken: "test",
  formKey: "form-key-one",
};
const prompt = (id: string, text: string): Message => ({
  id,
  role: "user",
  text,
  sender: { id: "one", name: "One" },
});
const answer = (id: string, text: string): Message => ({ id, role: "assistant", text });
let conversation: Conversation;
let root: Root;
let container: HTMLDivElement;

// Where each message sits in the scrolled content; jsdom lays nothing out.
const offsets: Record<string, number> = {
  q1: 100,
  a1: 300,
  q2: 700,
  a2: 900,
  q3: 1300,
  a3: 1500,
  q4: 1700,
};
function layout() {
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(2600);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const offset = offsets[(this as HTMLElement).dataset.messageId ?? ""];
    const top = offset === undefined ? 0 : offset - (this.closest(".transcript")?.scrollTop ?? 0);
    // The reading column ends 300 px short of the transcript's right edge, leaving the rail room.
    const right = this.classList.contains("transcript-content") ? 900 : 1200;
    return {
      top,
      bottom: top + 60,
      left: 0,
      right,
      width: right,
      height: 60,
      x: 0,
      y: top,
      toJSON() {},
    };
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  // A mouse that hovers, and reduced motion, so the jump lands at once.
  stubMatchMedia(
    (query) =>
      query === "(prefers-reduced-motion: reduce)" ||
      query === "(hover: hover) and (pointer: fine)",
  );
  history.replaceState(null, "", "/");
  conversation = {
    botId: "shared",
    sessionId: "live",
    messages: [
      prompt("q1", "First question"),
      answer("a1", "First answer"),
      prompt("q2", "Second question"),
      answer("a2", "Second answer"),
      prompt("q3", "Third question"),
      answer("a3", "Third answer"),
    ],
    approvals: [],
    files: [],
    activity: { state: "idle" },
  };
  vi.mocked(api).mockImplementation(
    async <T>(path: string) =>
      (path === "/bootstrap?roster=lean"
        ? bootstrap
        : path === "/bots/shared/draft"
          ? { text: "", attachments: [] }
          : path.startsWith("/bots/shared/conversation?")
            ? conversation
            : null) as T,
  );
  ({ container, root } = mountRoot());
});

it("jumps to a sent message from its tick, leaves the reader there, and keeps the tab stop on it", async () => {
  layout();
  await act(async () => root.render(createElement(App)));
  await advance(20);
  const transcript = container.querySelector<HTMLElement>(".transcript")!;
  const rail = container.querySelector<HTMLElement>(
    'nav[aria-label="Messages you sent in this chat"]',
  )!;
  const tick = (text: string) =>
    rail.querySelector<HTMLButtonElement>(`button[aria-label="Jump to: ${text}"]`)!;
  // The latest turn is in view, so its tick holds the one tab stop.
  expect(transcript.scrollTop).toBe(2600);
  expect(tick("Third question").tabIndex).toBe(0);

  await act(async () => tick("Second question").click());
  // The message sits at the top of the view with the gap a send leaves, and is marked.
  expect(transcript.scrollTop).toBe(offsets.q2 - ANCHOR_GAP);
  expect(container.querySelector('[data-message-id="q2"]')!.hasAttribute("data-found")).toBe(true);
  expect([...rail.querySelectorAll("button")].map((button) => button.tabIndex)).toEqual([
    -1, 0, -1,
  ]);

  // A reply landing later does not pull the reader back to the end.
  conversation = {
    ...conversation,
    messages: [...conversation.messages, prompt("q4", "Fourth question")],
  };
  await act(async () => FakeEventSource.notifyAll());
  await advance(1500);
  expect(container.querySelector('[data-message-id="q4"]')).not.toBeNull();
  expect(transcript.scrollTop).toBe(offsets.q2 - ANCHOR_GAP);

  // Up moves the tab stop and focus to the tick before it.
  await act(async () =>
    tick("Second question").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    ),
  );
  expect(document.activeElement).toBe(tick("First question"));
  expect(tick("First question").tabIndex).toBe(0);
  expect(tick("Second question").tabIndex).toBe(-1);
});

describe("a chat with more sent messages than ticks fit", () => {
  // 64 questions, each with its answer, 200 px apart; the rail has room for 20 ticks (608 - 2 × 64 = 480).
  const count = 64;
  // An image above every message can load late and push them all down.
  let shift = 0;
  const top = (index: number) => 100 + index * 200 + shift;
  let rowReads = 0;
  let resized: (() => void)[] = [];
  function longLayout() {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(top(count) + 400);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(608);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const id = (this as HTMLElement).dataset.messageId ?? "";
      const match = /^q(\d+)$|^a(\d+)$/.exec(id);
      // Only the rail's own reads count; the transcript keeps the reader's place with a search of its own.
      if (match && new Error().stack?.includes("MessageRail")) rowReads++;
      const offset = match ? top(Number(match[1] ?? match[2])) + (match[2] ? 100 : 0) : undefined;
      const y = offset === undefined ? 0 : offset - (this.closest(".transcript")?.scrollTop ?? 0);
      const right = this.classList.contains("transcript-content") ? 900 : 1200;
      return {
        top: y,
        bottom: y + 60,
        left: 0,
        right,
        width: right,
        height: 60,
        x: 0,
        y,
        toJSON() {},
      };
    });
  }
  const rail = () =>
    container.querySelector<HTMLElement>('nav[aria-label="Messages you sent in this chat"]')!;
  const names = () =>
    [...rail().querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
  const current = () =>
    rail().querySelector('button[aria-current="location"]')?.getAttribute("aria-label");
  const transcript = () => container.querySelector<HTMLElement>(".transcript")!;
  const press = (key: string) =>
    act(async () =>
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
    );
  async function scrollTo(y: number) {
    transcript().scrollTop = y;
    await act(async () => transcript().dispatchEvent(new Event("scroll")));
    await advance(20);
  }
  beforeEach(async () => {
    rowReads = 0;
    shift = 0;
    resized = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    conversation = {
      ...conversation,
      messages: Array.from({ length: count }, (_, index) => [
        prompt(`q${index}`, `Question ${index + 1}`),
        answer(`a${index}`, `Answer ${index + 1}`),
      ]).flat(),
    };
    longLayout();
    await act(async () => root.render(createElement(App)));
    await advance(20);
  });

  it("marks the first message when the reader scrolls to it, and says more are later", async () => {
    expect(names()).toHaveLength(20);
    expect(current()).toBe("Jump to: Question 64");
    await scrollTo(0);
    // The reported case: the newest 20 stayed, so the first message had no tick to mark.
    expect(current()).toBe("Jump to: Question 1");
    expect(names()[0]).toBe("Jump to: Question 1");
    const said = () =>
      document.getElementById(rail().getAttribute("aria-describedby") ?? "")?.textContent;
    expect(rail().querySelector(".message-rail-more-earlier")).toBeNull();
    expect(rail().querySelector(".message-rail-more-later")).not.toBeNull();
    expect(said()).toBe("44 later messages are not shown. Up and Down reach them.");
    await scrollTo(top(count));
    expect(current()).toBe("Jump to: Question 64");
    expect(rail().querySelector(".message-rail-more-earlier")).not.toBeNull();
    expect(rail().querySelector(".message-rail-more-later")).toBeNull();
    expect(said()).toBe("44 earlier messages are not shown. Up and Down reach them.");
  });

  it("reaches every sent message with Home, End and the arrows, from one tab stop", async () => {
    const stop = rail().querySelector<HTMLButtonElement>('button[tabindex="0"]')!;
    expect(stop.getAttribute("aria-label")).toBe("Jump to: Question 64");
    await act(async () => stop.focus());
    await press("Home");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Jump to: Question 1");
    expect(rail().querySelectorAll('button[tabindex="0"]')).toHaveLength(1);
    await press("ArrowDown");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Jump to: Question 2");
    await press("End");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Jump to: Question 64");
    // Up walks past the window's first tick, and the window moves with it.
    for (let step = 0; step < 25; step++) await press("ArrowUp");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Jump to: Question 39");
    expect(names()).toContain("Jump to: Question 38");
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(transcript().scrollTop).toBe(top(38) - ANCHOR_GAP);
  });

  it("reads where each message sits once, not on every scroll", async () => {
    await scrollTo(4000);
    rowReads = 0;
    for (let y = 4000; y < 6000; y += 200) await scrollTo(y);
    expect(rowReads).toBe(0);
    // The active tick still follows the reader: 5800 puts the line at 5800 + 202, Question 30's top.
    expect(current()).toBe("Jump to: Question 30");
  });

  it("measures again once something above the messages changes size", async () => {
    await scrollTo(5800);
    expect(current()).toBe("Jump to: Question 30");
    shift = 1000;
    await act(async () => resized.forEach((callback) => callback()));
    await scrollTo(5800);
    // Every message moved down 1000 px, so the line at 6002 now meets Question 25.
    expect(current()).toBe("Jump to: Question 25");
  });
});
