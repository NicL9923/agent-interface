// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api, uploadFile, write } from "../src/client-api";
import { CHUNK_RELOAD_KEY, CHUNK_RELOAD_WINDOW_MS } from "../src/app/chunk-recovery";
import { draftKey, groupSendKey, submissionKey } from "../src/app/storage";
import { defaultPreferences, type Bootstrap, type Conversation } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { advance, mountRoot, stubMatchMedia, typeInto } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async original => ({
  ...await original<typeof import("../src/client-api")>(),
  api: vi.fn(),
  write: vi.fn().mockResolvedValue({}),
  uploadFile: vi.fn(),
  clearResponseCache: vi.fn(),
}))(original)));
// Presence heartbeats and device activity have their own tests.
vi.mock("../src/app/use-chat-presence", () => ({ useChatPresence: () => {} }));
vi.mock("../src/app/use-device-activity", () => ({ useDeviceActivity: () => {} }));
vi.mock("../src/components/Avatar", async original => ({ ...await original<typeof import("../src/components/Avatar")>(), Avatar: () => null }));

const NOW = Date.UTC(2026, 10, 9, 15);
const bootstrap: Bootstrap = {
  user: { id: "one", name: "One", email: "one@example.test" },
  household: [],
  preferences: { ...defaultPreferences, startPage: "assistant", defaultBotId: "ranch" },
  bots: [{ id: "ranch", name: "Ranch Hand", shared: true, model: "test", activity: "idle" }],
  capabilities: Object.fromEntries(["chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration", "tools", "skills",
    "routines", "durableEvents", "idempotency", "imageGeneration", "stop", "portraitGeneration", "avatarMetadata"].map(key => [key, { supported: true }])) as Bootstrap["capabilities"],
  connection: { connected: true },
  csrfToken: "csrf",
};
const conversation: Conversation = { botId: "ranch", messages: [], approvals: [], files: [], activity: { state: "idle" } };

let root: Root, container: HTMLDivElement, reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.clearAllMocks();
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia();
  history.replaceState(null, "", "/?bot=ranch");
  reload = vi.fn();
  vi.stubGlobal("location", Object.assign(new URL(location.href), { reload }));
  vi.mocked(write).mockReset().mockResolvedValue({});
  vi.mocked(api).mockImplementation(async <T>(path: string) => (path === "/bootstrap?roster=lean" ? bootstrap
    : path.startsWith("/bots/ranch/conversation?") ? conversation
    : null) as T);
  ({ container, root } = mountRoot());
});

async function open() {
  await act(async () => root.render(createElement(App)));
  await advance(0);
}
/** Vite's report that a lazy screen's file could not load. */
const fileGone = () => act(async () => { window.dispatchEvent(new Event("vite:preloadError", { cancelable: true })); });
const field = () => container.querySelector<HTMLTextAreaElement>("textarea")!;

describe("a lazy screen whose file is gone", () => {
  it("reloads the tab once, and not again for another failure", async () => {
    await open();
    await fileGone();
    expect(reload).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBe(String(NOW));
    // The page has not gone yet, and a second screen fails too.
    await fileGone();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("leaves the screen's Reload prompt to the next load inside the window, and reloads again after it", async () => {
    // This tab reloaded itself just now; sessionStorage outlives that reload.
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(NOW - CHUNK_RELOAD_WINDOW_MS + 1));
    await open();
    await fileGone();
    expect(reload).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + 1);
    await fileGone();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("counts a reload time ahead of the clock as recent", async () => {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(NOW + 60_000));
    await open();
    await fileGone();
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads over a draft the device has kept, since the reload brings it back", async () => {
    await open();
    await typeInto(field(), "Check the north gate");
    expect(localStorage.getItem(draftKey("one", "ranch"))).toContain("Check the north gate");
    await fileGone();
    expect(reload).toHaveBeenCalledOnce();
  });

  // Full or blocked storage: the draft lives only in this page.
  const draftsUnsaved = () => vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string) {
    if (this === localStorage && key === draftKey("one", "ranch")) throw new DOMException("full", "QuotaExceededError");
  });

  it("does not reload over a draft the device could not keep", async () => {
    draftsUnsaved();
    await open();
    await typeInto(field(), "Check the north gate");
    await fileGone();
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads with an empty draft even when the device keeps no copy of it", async () => {
    draftsUnsaved();
    await open();
    expect(localStorage.getItem(draftKey("one", "ranch"))).toBeNull();
    await fileGone();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload while a file is still uploading", async () => {
    vi.mocked(uploadFile).mockImplementation(() => new Promise(() => {}));
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:local-preview"), revokeObjectURL: vi.fn() });
    await open();
    await act(async () => {
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", { value: { files: [new File(["pixels"], "gate.png", { type: "image/png" })], types: ["Files"], getData: () => "" } });
      field().dispatchEvent(paste);
    });
    expect(uploadFile).toHaveBeenCalled();
    await fileGone();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload while a message send is on its way", async () => {
    vi.mocked(write).mockImplementation(async <T>(path: string) => path === "/bots/ranch/messages" ? await new Promise<T>(() => {}) : {} as T);
    await open();
    await typeInto(field(), "Is the gate latched?");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(write).toHaveBeenCalledWith("/bots/ranch/messages", expect.objectContaining({ text: "Is the gate latched?" }));
    // Held in memory as well as storage; storage alone is checked below.
    localStorage.removeItem(submissionKey("one", "ranch"));
    await fileGone();
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([
    ["a chat send", submissionKey("one", "trail"), false],
    ["a group send", groupSendKey("one", "room-1"), false],
    ["only a group draft", `${groupSendKey("one", "room-1")}:draft`, true],
  ])("with %s saved on the device, reloads only if nothing is on its way", async (_name, key, reloads) => {
    localStorage.setItem(key, JSON.stringify({ requestId: "r", text: "Howdy" }));
    await open();
    await fileGone();
    expect(reload).toHaveBeenCalledTimes(reloads ? 1 : 0);
  });

  it("does not reload when it cannot remember that it did", async () => {
    await open();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage) {
      if (this === sessionStorage) throw new DOMException("blocked", "SecurityError");
    });
    await fileGone();
    expect(reload).not.toHaveBeenCalled();
  });
});
