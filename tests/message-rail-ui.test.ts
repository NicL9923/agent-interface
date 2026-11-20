// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
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
