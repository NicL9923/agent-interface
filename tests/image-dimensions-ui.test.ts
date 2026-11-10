// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api, uploadFile, write } from "../src/client-api";
import { imageSize, rememberImageSize } from "../src/app/image-sizes";
import { defaultPreferences } from "../src/shared/types";
import type { Bootstrap, Conversation, FileRef } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { mountRoot, stubMatchMedia, waitForUi } from "./ui-harness";

// Only the client API is faked. Each fake throws on a call the test did not configure.
vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest({
  ...await original<typeof import("../src/client-api")>(),
  api: vi.fn(), write: vi.fn(), uploadFile: vi.fn(), clearResponseCache: vi.fn(),
}));

const bootstrap: Bootstrap = {
  user: { id: "one", name: "One", email: "one@example.test" },
  household: [],
  preferences: { ...defaultPreferences, startPage: "assistant" },
  bots: [{ id: "shared", name: "Shared", shared: true, model: "test", activity: "idle" }],
  capabilities: Object.fromEntries(["chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration", "tools", "skills",
    "routines", "durableEvents", "idempotency", "imageGeneration", "stop", "portraitGeneration", "avatarMetadata"]
    .map(key => [key, { supported: true }])) as Bootstrap["capabilities"],
  connection: { connected: true },
  csrfToken: "test",
};
let conversation: Conversation;
let root: Root;
let container: HTMLElement;
let unexpected: string[];
let finishUpload: ((file: FileRef) => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 10, 15));
  vi.clearAllMocks();
  unexpected = [];
  finishUpload = undefined;
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia();
  Object.assign(SVGElement.prototype, { getTotalLength: () => 100, getPointAtLength: (length: number) => ({ x: length, y: 0 }) });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:local-preview"), revokeObjectURL: vi.fn() });
  history.replaceState(null, "", "/");
  localStorage.clear();
  conversation = { botId: "shared", messages: [{ id: "a0", role: "assistant", text: "Here is the fence." }], approvals: [], files: [], activity: { state: "idle" } };
  vi.mocked(api).mockImplementation(async <T>(path: string) => {
    if (path === "/bootstrap?roster=lean") return bootstrap as T;
    if (path === "/bots/shared/draft") return { text: "", attachments: [], revision: 0 } as T;
    if (path.startsWith("/bots/shared/conversation?")) return conversation as T;
    if (path === "/bots/shared/routine-runs") return { runs: [], unavailable: [] } as T;
    if (path === "/groups") return { supported: true, canSend: true, rooms: [] } as T;
    unexpected.push(`GET ${path}`);
    throw new Error(`This test serves no GET ${path}`);
  });
  vi.mocked(write).mockImplementation(async <T>(path: string, _body?: unknown, method = "POST") => {
    if (method === "PUT" && (path === "/bots/shared/presence" || path === "/devices/activity" || path === "/bots/shared/draft")) return {} as T;
    // The send is left on its way, so its echo stays in the transcript.
    if (path === "/bots/shared/messages") return await new Promise<T>(() => {});
    unexpected.push(`${method} ${path}`);
    throw new Error(`This test serves no ${method} ${path}`);
  });
  vi.mocked(uploadFile).mockImplementation(() => new Promise(resolve => { finishUpload = file => resolve(file as never); }));
  ({ container, root } = mountRoot());
});
afterEach(() => expect(unexpected).toEqual([]));

async function open() {
  await act(async () => root.render(createElement(App)));
  await waitForUi(() => expect(container.querySelector("textarea")).not.toBeNull());
}
/** The browser decoding an image, as jsdom never does: its natural size, then its load event. */
const load = (image: HTMLImageElement, width: number, height: number) => act(async () => {
  Object.defineProperties(image, { naturalWidth: { configurable: true, value: width }, naturalHeight: { configurable: true, value: height } });
  image.dispatchEvent(new Event("load"));
});
/** The width and height the transcript image reserves before it loads, as the browser reads them. */
const reserved = (image: HTMLImageElement | null | undefined) => [image?.getAttribute("width"), image?.getAttribute("height")];

describe("space reserved for transcript images", () => {
  it("keeps only a real natural size", () => {
    rememberImageSize("broken", { naturalWidth: 0, naturalHeight: 0 });
    rememberImageSize("no-height", { naturalWidth: 640, naturalHeight: 0 });
    rememberImageSize("no-width", { naturalWidth: 0, naturalHeight: 480 });
    expect([imageSize("broken"), imageSize("no-height"), imageSize("no-width")]).toEqual([undefined, undefined, undefined]);
    rememberImageSize("photo", { naturalWidth: 640, naturalHeight: 480 });
    expect(imageSize("photo")).toEqual({ width: 640, height: 480 });
  });

  it("gives an image of unknown size the fixed frame, and keeps that frame when it loads", async () => {
    conversation.messages.push({ id: "a1", role: "assistant", text: "The gate.", files: [{ id: "generated-gate", name: "gate.png", mime: "image/png" }] });
    await open();
    const image = container.querySelector<HTMLImageElement>('[data-message-id="a1"] .file-link img')!;
    expect(reserved(image)).toEqual([null, null]);
    await load(image, 1920, 1080);
    // More of the turn arrives, so its rows render again. A size learned on load would resize the frame under the
    // reader then, so this image keeps the frame while it stays.
    conversation = { ...conversation, messages: [...conversation.messages, { id: "a2", role: "assistant", text: "And the hinge." }] };
    await act(async () => FakeEventSource.notifyAll());
    await waitForUi(() => expect(container.querySelector('[data-message-id="a2"]')).not.toBeNull());
    expect(container.querySelector('[data-message-id="a1"] .file-link img')).toBe(image);
    expect(reserved(image)).toEqual([null, null]);
    expect(imageSize("generated-gate")).toEqual({ width: 1920, height: 1080 });
  });

  it("reserves a sent image's own size from the moment it is sent, from its preview in the message box", async () => {
    await open();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [new File(["pixels"], "post.png", { type: "image/png" })] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitForUi(() => expect(finishUpload).toBeDefined());
    await act(async () => finishUpload!({ id: "uploaded-post", name: "post.png", mime: "image/png", size: 6 }));
    await load(container.querySelector<HTMLImageElement>(".attachment-thumb img")!, 900, 1200);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    await waitForUi(() => expect(container.querySelector(".message-user .file-link img")).not.toBeNull());
    expect(reserved(container.querySelector<HTMLImageElement>(".message-user .file-link img"))).toEqual(["900", "1200"]);
  });

  it("does not reserve a size the preview never had", async () => {
    await open();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [new File(["pixels"], "blank.png", { type: "image/png" })] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitForUi(() => expect(finishUpload).toBeDefined());
    await act(async () => finishUpload!({ id: "uploaded-blank", name: "blank.png", mime: "image/png", size: 6 }));
    await load(container.querySelector<HTMLImageElement>(".attachment-thumb img")!, 0, 0);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    await waitForUi(() => expect(container.querySelector(".message-user .file-link img")).not.toBeNull());
    expect(reserved(container.querySelector<HTMLImageElement>(".message-user .file-link img"))).toEqual([null, null]);
  });
});
