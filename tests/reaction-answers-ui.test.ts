// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api, ApiError, write } from "../src/client-api";
import { defaultPreferences } from "../src/shared/types";
import type {
  ActivityState,
  Bootstrap,
  Conversation,
  Message,
  SubmissionReceipt,
} from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { advance, mountRoot, stubMatchMedia, waitForUi } from "./ui-harness";

// Only the client API is faked. Each fake throws on a call the test did not configure.
vi.mock("../src/client-api", async (original) =>
  (await import("./helpers/request-mock")).withRequest({
    ...(await original<typeof import("../src/client-api")>()),
    api: vi.fn(),
    write: vi.fn(),
    uploadFile: vi.fn(),
    clearResponseCache: vi.fn(),
  }),
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
};
const prompt: Message = {
  id: "u0",
  role: "user",
  text: "Add salt to the list",
  sender: { id: "one", name: "One" },
};
const answer: Message = { id: "a0", role: "assistant", text: "Want me to add it to the list?" };
let conversation: Conversation;
let root: Root;
let container: HTMLElement;
/** The message POST, held until the test answers it. */
let sent:
  | {
      body: { requestId: string; text: string; draftBaseRevision?: number };
      resolve(receipt: Partial<SubmissionReceipt>): void;
      reject(error: Error): void;
    }
  | undefined;
let lookup: (requestId: string) => SubmissionReceipt | Promise<SubmissionReceipt>;
let unexpected: string[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 19, 15));
  vi.clearAllMocks();
  unexpected = [];
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia();
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
  localStorage.clear();
  sent = undefined;
  lookup = (requestId) => {
    throw new Error(`Unexpected receipt check for ${requestId}`);
  };
  conversation = {
    botId: "shared",
    messages: [prompt, answer],
    approvals: [],
    files: [],
    activity: { state: "idle" },
  };
  vi.mocked(api).mockImplementation(async <T>(path: string) => {
    if (path === "/bootstrap?roster=lean") return bootstrap as T;
    if (path === "/bots/shared/draft")
      return { text: "Feed the horses", attachments: [], revision: 3 } as T;
    if (path.startsWith("/bots/shared/conversation?")) return conversation as T;
    if (path.startsWith("/submissions/"))
      return (await lookup(decodeURIComponent(path.slice("/submissions/".length)))) as T;
    if (path === "/bots/shared/routine-runs") return { runs: [], unavailable: [] } as T;
    if (path === "/groups") return { supported: true, canSend: true, rooms: [] } as T;
    unexpected.push(`GET ${path}`);
    throw new Error(`This test serves no GET ${path}`);
  });
  vi.mocked(write).mockImplementation(async <T>(path: string, body?: unknown, method = "POST") => {
    if (
      method === "PUT" &&
      (/^\/bots\/shared\/(presence|read-position)$/.test(path) || path === "/devices/activity")
    )
      return {} as T;
    if (path === "/bots/shared/messages")
      return await new Promise<T>((resolve, reject) => {
        const request = body as { requestId: string; text: string };
        sent = {
          body: request,
          resolve: (receipt) =>
            resolve({
              requestId: request.requestId,
              status: "accepted",
              runId: "run",
              ...receipt,
            } as T),
          reject,
        };
      });
    unexpected.push(`${method} ${path}`);
    throw new Error(`This test serves no ${method} ${path}`);
  });
  ({ container, root } = mountRoot());
});
afterEach(() => {
  expect(unexpected).toEqual([]);
});

async function open() {
  await act(async () => root.render(createElement(App)));
  await waitForUi(() => expect(row("a0")).toBeDefined());
}
const row = (id: string) =>
  container.querySelector<HTMLElement>(`article[data-message-id="${id}"]`) ?? undefined;
const reactButton = (scope: ParentNode = container) =>
  scope.querySelector<HTMLButtonElement>('button[aria-label="React"]');
const choice = (name: string) =>
  container.querySelector<HTMLButtonElement>(
    `[role="menu"] [role="menuitem"][aria-label="${name}"]`,
  )!;
/** The chips under a reply: what each reads to assistive tech, and whether it is still on its way. */
const chips = (id: string) =>
  [...(row(id)?.querySelectorAll<HTMLElement>(".reaction-chip") ?? [])].map((chip) => ({
    name: chip.querySelector(".sr-only")?.textContent,
    busy: chip.getAttribute("aria-busy") === "true",
  }));
/** Rows a person's message draws, by their words. */
const personRows = () =>
  [...container.querySelectorAll<HTMLElement>("article.message-user")].map(
    (item) => item.querySelector(".message-text")?.textContent,
  );
async function report(next: Partial<Conversation> & { state?: ActivityState }) {
  const { state, ...rest } = next;
  conversation = {
    ...conversation,
    ...rest,
    ...(state ? { activity: { state, runId: "run" } } : {}),
  };
  await act(async () => FakeEventSource.notifyAll());
  await advance(1500);
}
const notice = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>(".notice button")].find(
    (button) => button.textContent?.trim() === label,
  );

describe("reaction answers", () => {
  it("sends the chosen emoji as a message, shows it as a chip on the reply, and leaves the draft alone", async () => {
    await open();
    await act(async () => reactButton(row("a0"))!.click());
    // The first choice takes focus; Right moves along the row and Escape would return to React.
    expect(document.activeElement).toBe(choice("Thumbs up"));
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(choice("Heart"));
    await act(async () => choice("Thumbs up").click());
    await waitForUi(() => expect(sent).toBeDefined());
    // The reaction is the whole message, and names no draft revision, so the draft is not cleared.
    expect(sent!.body.text).toBe("👍");
    expect(sent!.body.draftBaseRevision).toBeUndefined();
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(chips("a0")).toEqual([{ name: "You reacted thumbs up, sending", busy: true }]);
    expect(personRows()).toEqual(["Add salt to the list"]);
    // The React button is gone with the send, so focus continues from the transcript.
    await advance(50);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Conversation");
    await act(async () => sent!.resolve({}));
    await report({
      state: "done",
      messages: [prompt, answer, { id: "u1", role: "user", text: "👍", sender: prompt.sender }],
    });
    expect(chips("a0")).toEqual([{ name: "You reacted thumbs up", busy: false }]);
    expect(personRows()).toEqual(["Add salt to the list"]);
    expect(container.querySelector("textarea")!.value).toBe("Feed the horses");
  });

  it("shows another member's reaction with their name, beside the person's own", async () => {
    conversation.messages = [
      prompt,
      answer,
      { id: "u1", role: "user", text: "👍", sender: prompt.sender },
      { id: "u2", role: "user", text: "\u2764", sender: { id: "two", name: "Jordan" } },
    ];
    await open();
    expect(chips("a0").map((chip) => chip.name)).toEqual([
      "You reacted thumbs up",
      "Jordan reacted heart",
    ]);
    expect(row("a0")!.querySelector(".reaction-who")?.textContent).toBe("Jordan");
    expect(personRows()).toEqual(["Add salt to the list"]);
    // Reactions to the latest reply leave it the last message, so it still offers React.
    expect(reactButton(row("a0"))).not.toBeNull();
  });

  it("offers React only on the latest reply, and not while a turn runs", async () => {
    conversation.messages = [
      prompt,
      answer,
      { id: "u1", role: "user", text: "Yes, and pepper", sender: prompt.sender },
      { id: "a1", role: "assistant", text: "Added both." },
    ];
    await open();
    expect(reactButton(row("a0"))).toBeNull();
    expect(reactButton(row("a1"))).not.toBeNull();
    await report({ state: "working" });
    expect(reactButton()).toBeNull();
    await report({ state: "done" });
    expect(reactButton(row("a1"))).not.toBeNull();
  });

  it("shows a reaction whose send came back without a receipt as a message row with its Retry", async () => {
    await open();
    await act(async () => reactButton(row("a0"))!.click());
    await act(async () => choice("Celebrate").click());
    await waitForUi(() => expect(sent).toBeDefined());
    lookup = () => new Promise(() => {});
    await act(async () => sent!.reject(new ApiError("Hermes is unavailable.", 503)));
    expect(chips("a0")).toEqual([]);
    const failed = [...container.querySelectorAll<HTMLElement>("article.message-user")].at(-1)!;
    expect(failed.querySelector(".message-text")?.textContent).toBe("🎉");
    expect(failed.textContent).toContain("Not confirmed yet");
    expect(notice("Retry this saved message")).toBeDefined();
  });
});
