// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api, ApiError, write } from "../src/client-api";
import { draftKey, submissionKey } from "../src/app/storage";
import { answerStaleMessage } from "../src/shared/errors";
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
      "reactionAnswers",
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
      body: {
        requestId: string;
        text: string;
        draftBaseRevision?: number;
        answering?: string;
        reviewedUncertain?: boolean;
      };
      resolve(receipt: Partial<SubmissionReceipt>): void;
      reject(error: Error): void;
    }
  | undefined;
let lookup: (requestId: string) => SubmissionReceipt | Promise<SubmissionReceipt>;
let unexpected: string[];
/** How many times the chat was read, so a test can tell it was read again. */
let reads: number;
/** The transcript's scrolled height; jsdom lays nothing out. */
let height: number;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 19, 15));
  vi.clearAllMocks();
  unexpected = [];
  reads = 0;
  height = 2600;
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
    if (path.startsWith("/bots/shared/conversation?")) {
      reads++;
      return structuredClone(conversation) as T;
    }
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
        const request = body as NonNullable<typeof sent>["body"];
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
/** Rows a person's message draws, by their words. */
const personRows = () =>
  [...container.querySelectorAll<HTMLElement>("article.message-user")].map(
    (item) => item.querySelector(".message-text")?.textContent,
  );
const textarea = () => container.querySelector("textarea")!;
const transcript = () => container.querySelector<HTMLElement>(".transcript")!;
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
async function react(name: string) {
  await act(async () => reactButton(row("a0"))!.click());
  await act(async () => choice(name).click());
  await waitForUi(() => expect(sent).toBeDefined());
}
const key = (target: Element, name: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });

describe("reaction answers", () => {
  it("sends the chosen emoji with the reply it answers, shows it as the person's own row, and leaves the draft alone", async () => {
    await open();
    await act(async () => reactButton(row("a0"))!.click());
    // The first choice takes focus; Right moves along the row and Escape would return to React.
    expect(document.activeElement).toBe(choice("Thumbs up"));
    await key(document.activeElement!, "ArrowRight");
    expect(document.activeElement).toBe(choice("Heart"));
    await act(async () => choice("Thumbs up").click());
    await waitForUi(() => expect(sent).toBeDefined());
    // The reaction is the whole message and names its reply; it was not written on the draft.
    expect(sent!.body).toMatchObject({ text: "👍", answering: "a0" });
    expect(sent!.body.draftBaseRevision).toBeUndefined();
    expect(container.querySelector('[role="menu"]')).toBeNull();
    // The React button is gone with the send, so focus continues from the transcript.
    await advance(50);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Conversation");
    await act(async () => sent!.resolve({ messageId: "u1" }));
    await report({
      state: "done",
      messages: [prompt, answer, { id: "u1", role: "user", text: "👍", sender: prompt.sender }],
    });
    // An ordinary message: its own row, which find, paging and the scroll anchor all read.
    expect(personRows()).toEqual(["Add salt to the list", "👍"]);
    expect(row("u1")).toBeDefined();
    expect(textarea().value).toBe("Feed the horses");
    // The reaction now ends the chat, so no reply offers React.
    expect(reactButton()).toBeNull();
  });

  it("shows another member's reaction as their named row, and takes React off the reply it follows", async () => {
    conversation.messages = [
      prompt,
      answer,
      { id: "u2", role: "user", text: "\u2764", sender: { id: "two", name: "Jordan" } },
    ];
    await open();
    expect(personRows()).toEqual(["Add salt to the list", "\u2764"]);
    expect(row("u2")!.querySelector(".message-attribution")?.textContent).toBe("Jordan");
    expect(reactButton()).toBeNull();
  });

  it("offers React only on the reply that ends the chat, and not while a turn runs", async () => {
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
    // A progress line is not an answer to react to.
    await report({
      messages: [
        ...conversation.messages,
        { id: "p1", role: "assistant", text: "Checking the pantry", interim: true },
      ],
    });
    expect(reactButton()).toBeNull();
  });

  it("offers React on a reply that has files and no text", async () => {
    conversation.messages = [
      prompt,
      {
        id: "a0",
        role: "assistant",
        text: "",
        files: [{ id: "body.signature", name: "list.pdf", mime: "application/pdf" }],
      },
    ];
    await open();
    expect(reactButton(row("a0"))).not.toBeNull();
    // Copy, Listen, Save and Quote act on words, so a reply without any offers only React.
    expect(row("a0")!.querySelector('button[aria-label="Copy reply"]')).toBeNull();
  });

  it("hides React when the server does not check answers", async () => {
    const { reactionAnswers: _, ...older } = bootstrap.capabilities;
    vi.mocked(api).mockImplementationOnce(
      async <T>() => ({ ...bootstrap, capabilities: older }) as T,
    );
    await open();
    expect(reactButton()).toBeNull();
  });

  it("puts no emoji in the draft when Hermes refuses the reaction", async () => {
    await open();
    await react("Laugh");
    await act(async () => sent!.resolve({ status: "rejected", message: "Hermes is busy." }));
    expect(textarea().value).toBe("Feed the horses");
  });

  it("puts no emoji in the draft when the server refuses the request", async () => {
    await open();
    await react("Laugh");
    await act(async () => sent!.reject(new ApiError("Message cannot be empty", 400)));
    expect(textarea().value).toBe("Feed the horses");
  });

  it("tells the person the chat moved on, reads it again, and leaves the draft alone", async () => {
    await open();
    await react("Thumbs up");
    const before = reads;
    await act(async () => sent!.reject(new ApiError(answerStaleMessage, 409, "answer_stale")));
    await advance(50);
    const alert = container.querySelector<HTMLElement>('.notice[role="alert"]');
    expect(alert?.textContent).toContain("The chat moved on, so your reaction was not sent.");
    expect(reads).toBeGreaterThan(before);
    expect(textarea().value).toBe("Feed the horses");
    expect(personRows()).toEqual(["Add salt to the list"]);
  });

  it("retries an unconfirmed reaction with the reply it answers, and discarding it keeps the draft", async () => {
    await open();
    await react("Celebrate");
    lookup = () => new Promise(() => {});
    await act(async () => sent!.reject(new ApiError("Hermes is unavailable.", 503)));
    const first = sent!;
    sent = undefined;
    await act(async () => notice("Retry this saved message")!.click());
    await waitForUi(() => expect(sent).toBeDefined());
    expect(sent!.body).toMatchObject({
      requestId: first.body.requestId,
      text: "🎉",
      answering: "a0",
      reviewedUncertain: true,
    });
    await act(async () => sent!.reject(new ApiError("Hermes is unavailable.", 503)));
    await act(async () => notice("Discard")!.click());
    expect(notice("Stop checking")!.closest(".notice")!.textContent).toContain(
      "The reaction may still arrive. Your draft stays as it is.",
    );
    await act(async () => notice("Stop checking")!.click());
    expect(notice("Retry this saved message")).toBeUndefined();
    expect(textarea().value).toBe("Feed the horses");
  });

  it("settles a reaction saved from an earlier visit without touching the draft", async () => {
    // The page closed while the reaction was on its way; the next visit checks it.
    localStorage.setItem(
      submissionKey("one", "shared"),
      JSON.stringify({
        requestId: "6c1a4f1e-2d3b-4c5d-8e9f-0a1b2c3d4e5f",
        botId: "shared",
        text: "👍",
        attachments: [],
        reviewedInterruption: false,
        answering: "a0",
      }),
    );
    lookup = (requestId) => ({ requestId, status: "rejected" });
    await open();
    await waitForUi(() => expect(localStorage.getItem(submissionKey("one", "shared"))).toBeNull());
    expect(textarea().value).toBe("Feed the horses");
    expect(
      JSON.parse(localStorage.getItem(draftKey("one", "shared")) ?? "{}").text ?? "",
    ).not.toContain("👍");
  });

  it("keeps the transcript following the end while the open picker takes Home and End", async () => {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(() => height);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(600);
    await open();
    expect(transcript().scrollTop).toBe(2600);
    await act(async () => reactButton(row("a0"))!.click());
    await key(document.activeElement!, "Home");
    expect(document.activeElement).toBe(choice("Thumbs up"));
    await key(document.activeElement!, "End");
    expect(document.activeElement).toBe(choice("Thumbs down"));
    // Another member writes; a follower is taken to it.
    height = 3200;
    await report({
      messages: [
        ...conversation.messages,
        { id: "u2", role: "user", text: "Also onions", sender: { id: "two", name: "Jordan" } },
      ],
    });
    expect(transcript().scrollTop).toBe(3200);
  });

  it("moves focus to the conversation when an update takes away the open picker", async () => {
    await open();
    await act(async () => reactButton(row("a0"))!.click());
    expect(document.activeElement).toBe(choice("Thumbs up"));
    await report({
      messages: [
        ...conversation.messages,
        { id: "u2", role: "user", text: "Also onions", sender: { id: "two", name: "Jordan" } },
      ],
    });
    expect(reactButton()).toBeNull();
    await advance(50);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Conversation");
  });
});
