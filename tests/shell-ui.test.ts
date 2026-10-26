// @vitest-environment jsdom
import { act, createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { preloadBotMenu } from "../src/app/BotMenu";
import { api, uploadFile, write } from "../src/client-api";
import { defaultPreferences } from "../src/shared/types";
import { submissionKey } from "../src/app/storage";
import type { Bootstrap, Conversation } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { advance, mountRoot, stubMatchMedia, typeInto, type Mount } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async (original) => ({
  ...await original<typeof import("../src/client-api")>(),
  api: vi.fn(),
  write: vi.fn().mockResolvedValue({}),
  uploadFile: vi.fn(),
  clearResponseCache: vi.fn(),
}))(original)));
vi.mock("../src/app/use-chat-presence", () => ({ useChatPresence: vi.fn() }));
vi.mock("../src/components/Avatar", async (original) => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  Avatar: () => createElement("span", { className: "avatar-stub" }),
}));
vi.mock("../src/components/MessageMarkdown", () => {
  const markdown = (props: { text: string }) => createElement("div", { className: "message-markdown" }, props.text);
  return { MessageMarkdown: markdown, StreamingMarkdown: markdown };
});

const capabilities = Object.fromEntries([
  "chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration",
  "tools", "skills", "routines", "durableEvents", "idempotency", "imageGeneration",
  "stop", "portraitGeneration", "avatarMetadata",
].map((key) => [key, { supported: true }])) as Bootstrap["capabilities"];
let boot: Bootstrap;
let conversation: Conversation;
let mount: Mount;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia();
  history.replaceState(null, "", "/");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  boot = {
    user: { id: "one", name: "One", email: "one@example.test" },
    household: [],
    preferences: { ...defaultPreferences, startPage: "assistant", favorites: ["kitchen"] },
    bots: [
      { id: "shared", name: "Shared", shared: true, model: "test", activity: "idle" },
      { id: "kitchen", name: "Kitchen companion", shared: true, model: "test", activity: "idle", unread: true, lastMessage: { text: "Pot roast", at: "2026-10-25T12:00:00Z" } },
    ],
    capabilities, connection: { connected: true }, csrfToken: "test",
  };
  conversation = { botId: "shared", messages: [], approvals: [], files: [], activity: { state: "idle" } };
  vi.mocked(api).mockImplementation(async <T>(path: string) => (path === "/bootstrap?roster=lean" ? boot
    : path.endsWith("/draft") ? { text: "", attachments: [] }
    : /^\/bots\/\w+\/conversation\?/.test(path) ? { ...conversation, botId: path.split("/")[2] }
    : path.startsWith("/search") ? { hits: [], unavailableBots: [] }
    : null) as T);
  vi.mocked(write).mockImplementation(async <T>(path: string, value?: unknown) => (path === "/preferences" ? value : {}) as T);
  mount = mountRoot();
});

const render = async () => { await mount.render(createElement(App)); await advance(0); };
const loaded = () => act(async () => { await vi.dynamicImportSettled(); });
const key = (init: KeyboardEventInit, target: EventTarget = document.body) => act(async () => {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
});
const palette = () => document.body.querySelector<HTMLDialogElement>("dialog.command-palette");
const paletteInput = () => palette()!.querySelector<HTMLInputElement>("input")!;
const options = () => [...palette()!.querySelectorAll('[role="option"]')].map(option => option.querySelector(".palette-label")!.textContent);
const activeOption = () => palette()!.querySelector('[role="option"][aria-selected="true"] .palette-label')?.textContent;

describe("command palette", () => {
  it("opens on Ctrl+K even from the composer, filters, and opens an assistant with Enter", async () => {
    await render();
    const composer = mount.container.querySelector<HTMLTextAreaElement>("#message")!;
    composer.focus();
    await key({ key: "k", ctrlKey: true }, composer);
    expect(palette()?.open).toBe(true);
    expect(document.activeElement).toBe(paletteInput());
    // Pinned assistants lead, with their shortcut and unread state.
    expect(options().slice(0, 2)).toEqual(["Kitchen companion", "Shared"]);
    expect(palette()!.querySelector('[role="option"] kbd')?.textContent).toBe("Ctrl+1");
    expect(palette()!.querySelector('[role="option"] small')?.textContent).toBe("Unread");
    await typeInto(paletteInput(), "kitch");
    expect(activeOption()).toBe("Kitchen companion");
    expect(paletteInput().getAttribute("aria-activedescendant")).toBe(palette()!.querySelector('[aria-selected="true"]')!.id);
    await key({ key: "ArrowDown" }, paletteInput());
    expect(activeOption()).toBe('Search messages for "kitch"');
    await key({ key: "ArrowUp" }, paletteInput());
    await key({ key: "Enter" }, paletteInput());
    expect(palette()).toBeNull();
    expect(new URL(location.href).searchParams.get("bot")).toBe("kitchen");
    expect(mount.container.querySelector("#message")?.getAttribute("placeholder")).toBe("Message Kitchen companion…");
  });

  it("closes with Escape or Ctrl+K and returns focus", async () => {
    await render();
    const composer = mount.container.querySelector<HTMLTextAreaElement>("#message")!;
    composer.focus();
    await key({ key: "k", ctrlKey: true }, composer);
    await act(async () => palette()!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(palette()).toBeNull();
    expect(document.activeElement).toBe(composer);
    await key({ key: "k", ctrlKey: true }, composer);
    await key({ key: "k", ctrlKey: true }, paletteInput());
    expect(palette()).toBeNull();
  });

  it("searches messages for the typed words and sets the appearance", async () => {
    await render();
    await key({ key: "k", ctrlKey: true });
    await typeInto(paletteInput(), "dark");
    expect(activeOption()).toBe("Appearance: Dark");
    await key({ key: "Enter" }, paletteInput());
    expect(write).toHaveBeenCalledWith("/preferences", expect.objectContaining({ theme: "dark" }), "PATCH");
    await key({ key: "k", ctrlKey: true });
    await typeInto(paletteInput(), "north gate");
    await act(async () => [...palette()!.querySelectorAll<HTMLElement>('[role="option"]')].at(-1)!.click());
    await loaded(); await advance(0);
    expect(new URL(location.href).searchParams.get("view")).toBe("find");
    expect(mount.container.querySelector<HTMLInputElement>('[aria-label="Search conversations"]')?.value).toBe("north gate");
    expect(api).toHaveBeenCalledWith("/search?q=north+gate");
  });
});

describe("keyboard shortcuts", () => {
  it("opens pinned assistants by number and leaves unpinned numbers alone", async () => {
    await render();
    await key({ key: "1", ctrlKey: true });
    expect(new URL(location.href).searchParams.get("bot")).toBe("kitchen");
    const unclaimed = new KeyboardEvent("keydown", { key: "2", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => document.body.dispatchEvent(unclaimed));
    expect(unclaimed.defaultPrevented).toBe(false);
  });

  it("shows the shortcut list with ? but not while typing", async () => {
    await render();
    await key({ key: "?", shiftKey: true }, mount.container.querySelector("#message")!);
    expect(document.body.querySelector(".shortcuts-dialog")).toBeNull();
    await key({ key: "?", shiftKey: true });
    const dialog = document.body.querySelector(".shortcuts-dialog")!;
    expect(dialog.textContent).toContain("Find in this chat");
    expect(dialog.textContent).toContain("Ctrl+F");
    // While a dialog is open, other shortcuts wait.
    await key({ key: "k", ctrlKey: true });
    expect(palette()).toBeNull();
  });

  it("asks before Ctrl+. stops active work", async () => {
    conversation = { ...conversation, activity: { state: "working", runId: "run" } };
    await render();
    await key({ key: ".", ctrlKey: true });
    const confirm = document.body.querySelector('[role="alertdialog"]')!;
    expect(confirm.textContent).toContain("Stop Shared's work?");
    expect(document.activeElement?.textContent).toBe("Keep working");
    await act(async () => [...confirm.querySelectorAll("button")].find(button => button.textContent === "Stop work")!.click());
    expect(write).toHaveBeenCalledWith("/bots/shared/stop", {});
  });

  it("ignores Ctrl+. when nothing is running", async () => {
    await render();
    await key({ key: ".", ctrlKey: true });
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
  });
});

describe("undo toast", () => {
  const pinFromMenu = async (name: string, item: string) => {
    // Rows swap to the real menu once its code has loaded, which would replace a row found earlier.
    await act(async () => { await preloadBotMenu(); });
    const row = [...mount.container.querySelectorAll<HTMLElement>(".bot-item")].find(button => button.textContent?.includes(name))!;
    await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 })));
    await act(async () => [...document.body.querySelectorAll<HTMLElement>('.bot-menu [role="menuitem"]')].find(entry => entry.textContent === item)!.click());
  };
  const toast = () => document.body.querySelector(".toast");

  it("undoes a pin with Ctrl+Z and announces it in a live region", async () => {
    await render();
    await pinFromMenu("Shared", "Pin to top");
    expect(write).toHaveBeenLastCalledWith("/preferences", expect.objectContaining({ favorites: ["kitchen", "shared"] }), "PATCH");
    expect(toast()?.closest('[role="status"]')).not.toBeNull();
    expect(toast()?.textContent).toContain("Pinned Shared");
    await key({ key: "z", ctrlKey: true });
    expect(write).toHaveBeenLastCalledWith("/preferences", expect.objectContaining({ favorites: ["kitchen"] }), "PATCH");
    expect(toast()).toBeNull();
    // With no toast, Ctrl+Z keeps its usual meaning.
    const plain = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => document.body.dispatchEvent(plain));
    expect(plain.defaultPrevented).toBe(false);
  });

  it("restores an unpinned assistant to its place with the Undo button, and leaves after five seconds", async () => {
    boot.preferences.favorites = ["kitchen", "shared"];
    await render();
    await pinFromMenu("Kitchen companion", "Unpin");
    expect(write).toHaveBeenLastCalledWith("/preferences", expect.objectContaining({ favorites: ["shared"] }), "PATCH");
    await act(async () => [...toast()!.querySelectorAll("button")].find(button => button.textContent === "Undo")!.click());
    expect(write).toHaveBeenLastCalledWith("/preferences", expect.objectContaining({ favorites: ["kitchen", "shared"] }), "PATCH");
    await pinFromMenu("Kitchen companion", "Unpin");
    // Hovering holds it; leaving lets it go after the full five seconds.
    await act(async () => toast()!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: document.body })));
    await advance(10_000);
    expect(toast()).not.toBeNull();
    await act(async () => toast()!.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
    await advance(4_900);
    expect(toast()).not.toBeNull();
    await advance(200);
    expect(toast()).toBeNull();
  });

  it("leaves with the account that made the change, and its Undo never acts for another", async () => {
    boot.bots[0] = { ...boot.bots[0], shared: false, ownerId: "one", name: "Private ledger" };
    await render();
    await pinFromMenu("Private ledger", "Pin to top");
    expect(toast()?.textContent).toContain("Pinned Private ledger");
    boot = { ...boot, user: { id: "two", name: "Two", email: "two@example.test" }, bots: [boot.bots[1]], preferences: { ...defaultPreferences, startPage: "assistant" } };
    await act(async () => window.dispatchEvent(new Event("focus")));
    await advance(0);
    expect(mount.container.textContent).not.toContain("Private ledger");
    expect(toast()).toBeNull();
    const writes = vi.mocked(write).mock.calls.length;
    await key({ key: "z", ctrlKey: true });
    expect(vi.mocked(write).mock.calls.slice(writes).filter(([path]) => path === "/preferences")).toEqual([]);
  });

  it("is dismissed by signing out, and does not come back when the same person signs in again", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string) => path === "/auth/config" ? { localDevAuth: true } as T : original(path) as Promise<T>);
    await render();
    await pinFromMenu("Shared", "Pin to top");
    expect(toast()).not.toBeNull();
    await act(async () => mount.container.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click());
    await loaded();
    await act(async () => [...mount.container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Sign out")!.click());
    expect(write).toHaveBeenCalledWith("/auth/logout", {});
    expect(toast()).toBeNull();
    await advance(0);
    await act(async () => [...mount.container.querySelectorAll("button")].find(button => button.textContent === "Enter local workspace")!.click());
    await advance(0);
    expect(mount.container.querySelector(".sign-in")).toBeNull();
    expect(toast()).toBeNull();
    const writes = vi.mocked(write).mock.calls.length;
    await key({ key: "z", ctrlKey: true });
    expect(vi.mocked(write).mock.calls.slice(writes).filter(([path]) => path === "/preferences")).toEqual([]);
  });
});

describe("status dock", () => {
  it("counts waiting decisions and moves focus to the first one", async () => {
    conversation = { ...conversation, approvals: [
      { id: "a1", status: "pending", title: "Clear the cache", detail: "rm -rf /tmp/cache" },
      { id: "a2", status: "pending", title: "List files", detail: "ls" },
    ] };
    await render();
    const dock = mount.container.querySelector(".status-dock")!;
    expect(dock.textContent).toContain("2 decisions waiting");
    await act(async () => [...dock.querySelectorAll("button")].find(button => button.textContent === "Review")!.click());
    expect(document.activeElement).toBe(mount.container.querySelector(".transcript .approval-card"));
  });

  it("shows the connection notice above the composer while reconnecting", async () => {
    await render();
    await act(async () => window.dispatchEvent(new Event("offline")));
    const dock = mount.container.querySelector(".status-dock")!;
    expect(dock.querySelector(".connection-panel.compact")?.textContent).toContain("You're offline");
    // Moved, not copied: the transcript no longer shows its own.
    expect(mount.container.querySelectorAll(".connection-panel.compact")).toHaveLength(1);
  });
});

describe("app badge", () => {
  it("puts unread chats and waiting decisions in the title", async () => {
    boot.bots[0]!.activity = "waiting";
    await render();
    expect(document.title).toBe("(2) WildBots");
  });
});

describe("composer", () => {
  const field = () => mount.container.querySelector<HTMLTextAreaElement>("#message")!;
  const arrow = (key: string) => act(async () => {
    field().setSelectionRange(key === "ArrowDown" ? field().value.length : 0, key === "ArrowDown" ? field().value.length : 0);
    field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  const mine = (id: string, text: string) => ({ id, role: "user" as const, text, sender: { id: "one", name: "One" } });

  it("recalls this person's earlier messages from an empty composer and restores it", async () => {
    conversation = { ...conversation, messages: [mine("1", "Plan dinner"), { id: "2", role: "assistant", text: "Sure" },
      { id: "3", role: "user", text: "Someone else's", sender: { id: "two", name: "Two" } }, mine("4", "What about Tuesday?")] };
    await render();
    await arrow("ArrowUp");
    expect(field().value).toBe("What about Tuesday?");
    expect(field().selectionStart).toBe(0);
    await arrow("ArrowUp");
    expect(field().value).toBe("Plan dinner");
    await arrow("ArrowDown");
    expect(field().value).toBe("What about Tuesday?");
    await act(async () => field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(field().value).toBe("");
    // A draft of its own keeps the arrows for moving the caret.
    await typeInto(field(), "Half a thought");
    await arrow("ArrowUp");
    expect(field().value).toBe("Half a thought");
  });

  it("never recalls into a draft while its send is in flight", async () => {
    conversation = { ...conversation, messages: [mine("1", "Plan dinner")] };
    vi.mocked(write).mockImplementation(async <T>(path: string, value?: unknown) => path === "/bots/shared/messages"
      ? new Promise<T>(() => {}) : (path === "/preferences" ? value : {}) as T);
    await render();
    await typeInto(field(), "Feed the horses");
    await act(async () => mount.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(field().readOnly).toBe(true);
    await arrow("ArrowUp");
    expect(field().value).toBe("");
    const sent = vi.mocked(write).mock.calls.find(([path]) => path === "/bots/shared/messages")![1] as { text: string };
    expect(sent.text).toBe("Feed the horses");
    expect(vi.mocked(write).mock.calls.filter(([path]) => path === "/bots/shared/draft")).toEqual([]);
  });

  it("attaches a very long paste as a text file and inserts a short one", async () => {
    vi.mocked(uploadFile).mockImplementation(() => new Promise(() => {}));
    await render();
    const paste = (text: string) => act(async () => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { files: [], types: ["text/plain"], getData: () => text } });
      field().dispatchEvent(event);
      return event.defaultPrevented;
    });
    await paste("short");
    expect(uploadFile).not.toHaveBeenCalled();
    await paste("a".repeat(40_000));
    const file = vi.mocked(uploadFile).mock.calls[0]![1] as File;
    expect([file.name, file.type, file.size]).toEqual(["Pasted text.txt", "text/plain", 40_000]);
    expect(mount.container.querySelector("#composer-paste-status")?.textContent).toContain("attached as Pasted text.txt");
    expect(field().getAttribute("aria-describedby")).toBe("composer-paste-status");
  });

  it("discards an unconfirmed send after a warning and keeps its text in the draft", async () => {
    vi.mocked(write).mockImplementation(async <T>(path: string, value?: unknown) => (path === "/bots/shared/messages"
      ? { requestId: (value as { requestId: string }).requestId, status: "uncertain" } : path === "/preferences" ? value : {}) as T);
    vi.mocked(api).mockImplementation(async <T>(path: string) => (path === "/bootstrap?roster=lean" ? boot
      : path.endsWith("/draft") ? { text: "", attachments: [] }
      : path.startsWith("/submissions/") ? { status: "uncertain" }
      : /^\/bots\/\w+\/conversation\?/.test(path) ? conversation : null) as T);
    await render();
    await typeInto(field(), "Feed the horses");
    await act(async () => mount.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    const dock = () => mount.container.querySelector(".status-dock")!;
    expect(dock().textContent).toContain("Checking whether your last message arrived");
    await act(async () => [...dock().querySelectorAll("button")].find(button => button.textContent === "Discard")!.click());
    expect(dock().textContent).toContain("sending it again could deliver it twice");
    await act(async () => [...dock().querySelectorAll("button")].find(button => button.textContent === "Discard and keep my text in the draft")!.click());
    expect(mount.container.querySelector(".status-dock")).toBeNull();
    expect(field().value).toBe("Feed the horses");
    expect(mount.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(false);
    expect(localStorage.getItem(submissionKey("one", "shared"))).toBeNull();
  });
});
