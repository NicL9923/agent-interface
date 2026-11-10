// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { api, uploadFile, write } from "../src/client-api";
import { imageSize, MAX_REMEMBERED, rememberImageSize, reshapes } from "../src/app/image-sizes";
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
/** The shape the image's frame reserves, as its inline aspect-ratio; empty for the stylesheet's 4:3 frame. */
const reserved = (scope: string) => container.querySelector<HTMLElement>(`${scope} .file-frame`)!.style.aspectRatio;
/** An assistant message with one image, read into an open chat. */
async function openWithImage(id: string) {
  conversation.messages.push({ id: "a1", role: "assistant", text: "The gate.", files: [{ id, name: "gate.png", mime: "image/png" }] });
  await open();
  return container.querySelector<HTMLImageElement>('[data-message-id="a1"] .file-link img')!;
}

describe("space reserved for transcript images", () => {
  // The frame is 4:3. Within 10% of it a loaded image keeps the frame; beyond, it takes its own shape.
  it("reshapes a frame only when the loaded shape is more than 10% from it, either way", () => {
    const loaded = (width: number, height: number) => ({ width, height });
    expect([reshapes(undefined, loaded(1466, 1000)), reshapes(undefined, loaded(1467, 1000))]).toEqual([false, true]);
    expect([reshapes(undefined, loaded(1213, 1000)), reshapes(undefined, loaded(1212, 1000))]).toEqual([false, true]);
    expect([reshapes(loaded(1000, 1000), loaded(1099, 1000)), reshapes(loaded(1000, 1000), loaded(1101, 1000))]).toEqual([false, true]);
    // An image with no natural size, as some SVGs load, never reshapes its frame.
    expect([reshapes(undefined, loaded(0, 0)), reshapes(undefined, loaded(640, 0))]).toEqual([false, false]);
  });

  it("forgets the oldest sizes past its bound, and keeps one just used", () => {
    rememberImageSize("first", { naturalWidth: 10, naturalHeight: 10 });
    rememberImageSize("second", { naturalWidth: 20, naturalHeight: 20 });
    rememberImageSize("first", { naturalWidth: 10, naturalHeight: 10 });
    for (let index = 0; index < MAX_REMEMBERED - 1; index += 1) rememberImageSize(`filler-${index}`, { naturalWidth: 1, naturalHeight: 1 });
    expect([imageSize("second"), imageSize("first")]).toEqual([undefined, { width: 10, height: 10 }]);
  });

  it("keeps only a real natural size", () => {
    rememberImageSize("broken", { naturalWidth: 0, naturalHeight: 0 });
    rememberImageSize("no-height", { naturalWidth: 640, naturalHeight: 0 });
    rememberImageSize("no-width", { naturalWidth: 0, naturalHeight: 480 });
    expect([imageSize("broken"), imageSize("no-height"), imageSize("no-width")]).toEqual([undefined, undefined, undefined]);
    rememberImageSize("photo", { naturalWidth: 640, naturalHeight: 480 });
    expect(imageSize("photo")).toEqual({ width: 640, height: 480 });
  });

  it("gives an image of unknown size the fixed frame, and keeps that frame when it loads close to 4:3", async () => {
    const image = await openWithImage("generated-gate");
    expect(reserved('[data-message-id="a1"]')).toBe("");
    await load(image, 1400, 1000);
    // More of the turn arrives, so its rows render again; the frame stays as it was.
    conversation = { ...conversation, messages: [...conversation.messages, { id: "a2", role: "assistant", text: "And the hinge." }] };
    await act(async () => FakeEventSource.notifyAll());
    await waitForUi(() => expect(container.querySelector('[data-message-id="a2"]')).not.toBeNull());
    expect(container.querySelector('[data-message-id="a1"] .file-link img')).toBe(image);
    expect(reserved('[data-message-id="a1"]')).toBe("");
    expect(imageSize("generated-gate")).toEqual({ width: 1400, height: 1000 });
  });

  it("gives an image of unknown size its own shape once it loads far from 4:3", async () => {
    const image = await openWithImage("generated-panorama");
    await load(image, 2520, 1080);
    expect(reserved('[data-message-id="a1"]')).toBe("2520 / 1080");
    expect(container.querySelector('[data-message-id="a1"] .file-link img')).toBe(image);
  });

  // Reshaping a frame in view moves the rows after it, and the reader's place is held at the view's top edge.
  it("waits until the image's row leaves the view to reshape it while the reader is scrolled up, and reshapes at once at the end", async () => {
    const observed: { callback: IntersectionObserverCallback; target?: Element }[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      entry: { callback: IntersectionObserverCallback; target?: Element };
      constructor(callback: IntersectionObserverCallback) { this.entry = { callback }; observed.push(this.entry); }
      observe(target: Element) { this.entry.target = target; }
      disconnect() {}
    });
    const image = await openWithImage("panorama-in-view");
    const view = container.querySelector<HTMLElement>('[role="region"][aria-label="Conversation"]')!;
    const frame = container.querySelector<HTMLElement>('[data-message-id="a1"] .file-frame')!;
    const row = container.querySelector<HTMLElement>('[data-message-id="a1"]')!;
    view.style.overflowY = "auto";
    const box = (top: number, bottom: number) => () => ({ top, bottom, left: 0, right: 450, width: 450, height: bottom - top, x: 0, y: top, toJSON() {} }) as DOMRect;
    Object.assign(view, { getBoundingClientRect: box(0, 600) });
    Object.defineProperties(view, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, writable: true, value: 300 } });
    // The frame is above the view, but the end of its row, the file's name, is still at the top of it.
    Object.assign(frame, { getBoundingClientRect: box(-400, -63) });
    Object.assign(row, { getBoundingClientRect: box(-460, 20) });
    await load(image, 2520, 1080);
    expect(reserved('[data-message-id="a1"]')).toBe("");
    const watching = observed.find(item => item.target === row)!;
    await act(async () => watching.callback([{ isIntersecting: true, target: row } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(reserved('[data-message-id="a1"]')).toBe("");
    await act(async () => watching.callback([{ isIntersecting: false, target: row } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(reserved('[data-message-id="a1"]')).toBe("2520 / 1080");
    // At the chat's end the latest message stays put, so a second image there reshapes as it loads.
    conversation = { ...conversation, messages: [...conversation.messages, { id: "a2", role: "assistant", text: "And the gate.",
      files: [{ id: "tall-at-end", name: "gate.png", mime: "image/png" }] }] };
    await act(async () => FakeEventSource.notifyAll());
    await waitForUi(() => expect(container.querySelector('[data-message-id="a2"] .file-link img')).not.toBeNull());
    view.scrollTop = 1400;
    Object.assign(container.querySelector('[data-message-id="a2"]')!, { getBoundingClientRect: box(150, 590) });
    await load(container.querySelector<HTMLImageElement>('[data-message-id="a2"] .file-link img')!, 1080, 1920);
    expect(reserved('[data-message-id="a2"]')).toBe("1080 / 1920");
  });

  // A file ID names a path, and an assistant can write new bytes to the same path, as when it redraws chart.png.
  it("takes the loaded shape when the size this page remembered for the file no longer holds", async () => {
    rememberImageSize("redrawn-chart", { naturalWidth: 1600, naturalHeight: 1200 });
    const image = await openWithImage("redrawn-chart");
    expect(reserved('[data-message-id="a1"]')).toBe("1600 / 1200");
    await load(image, 1080, 1920);
    expect(reserved('[data-message-id="a1"]')).toBe("1080 / 1920");
    expect(imageSize("redrawn-chart")).toEqual({ width: 1080, height: 1920 });
  });

  it("keeps the frame and says so when an image fails to load", async () => {
    rememberImageSize("lost-photo", { naturalWidth: 900, naturalHeight: 1200 });
    const image = await openWithImage("lost-photo");
    const frame = container.querySelector('[data-message-id="a1"] .file-frame');
    await act(async () => { image.dispatchEvent(new Event("error")); });
    expect(container.querySelector('[data-message-id="a1"] .file-frame')).toBe(frame);
    expect(reserved('[data-message-id="a1"]')).toBe("900 / 1200");
    expect(frame!.querySelector("img")).toBeNull();
    expect(frame!.textContent).toBe("Couldn't load this image");
    // The file's name stays below the frame, once.
    expect(container.querySelector('[data-message-id="a1"] .file-name')!.textContent!.trim()).toBe("gate.png");
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
    expect(reserved(".message-user")).toBe("900 / 1200");
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
    expect(reserved(".message-user")).toBe("");
  });
  // A reshape waiting for the reader is applied as soon as nothing being read would move: the row left the view, the
  // reader is back at the end, or the row can never leave the view at all.
  describe("a reshape that waits for the reader", () => {
    const box = (top: number, bottom: number) => () => ({ top, bottom, left: 0, right: 450, width: 450, height: bottom - top, x: 0, y: top, toJSON() {} }) as DOMRect;
    /** An image in a row the reader sees while scrolled up, in a view `room` px shorter than its content. */
    async function waiting(id: string, row: [number, number], { room = 1400, scrollTop = 300 } = {}) {
      // Each test its own file, since the page remembers a size it learned.
      const image = await openWithImage(id);
      const view = container.querySelector<HTMLElement>('[role="region"][aria-label="Conversation"]')!;
      view.style.overflowY = "auto";
      Object.assign(view, { getBoundingClientRect: box(0, 600) });
      Object.defineProperties(view, { scrollHeight: { configurable: true, value: 600 + room }, clientHeight: { configurable: true, value: 600 },
        scrollTop: { configurable: true, writable: true, value: scrollTop } });
      const element = container.querySelector<HTMLElement>('[data-message-id="a1"]')!;
      Object.assign(element, { getBoundingClientRect: box(...row) });
      await load(image, 1170, 2532);
      return { view, row: element, scroll: (top: number) => act(async () => { view.scrollTop = top; view.dispatchEvent(new Event("scroll")); }) };
    }

    it("stays while a scroll leaves the row in view, and applies once the reader is back at the end", async () => {
      const { scroll } = await waiting("screenshot-back-to-end", [100, 560]);
      expect(reserved('[data-message-id="a1"]')).toBe("");
      await scroll(320);
      expect(reserved('[data-message-id="a1"]')).toBe("");
      await scroll(1400);
      expect(reserved('[data-message-id="a1"]')).toBe("1170 / 2532");
    });

    it("applies once a scroll takes the row out of view, without waiting for the observer", async () => {
      const { scroll, row } = await waiting("screenshot-scrolled-away", [100, 560]);
      Object.assign(row, { getBoundingClientRect: box(-560, -100) });
      await scroll(960);
      expect(reserved('[data-message-id="a1"]')).toBe("1170 / 2532");
    });

    // A short thread: 66 px of scroll room, and the image's row in view at the top of it and at its end.
    it("applies at once when the row can never leave the view", async () => {
      await waiting("screenshot-short-thread", [100, 560], { room: 66, scrollTop: 0 });
      expect(reserved('[data-message-id="a1"]')).toBe("1170 / 2532");
    });

    // 600 px of room in a 600 px view: the row is in view now, and out of it at one end of the scroll.
    it.each<[string, [number, number], number]>([
      ["at the end", [100, 560], 0],
      ["at the top", [200, 500], 500],
    ])("waits when the row would leave the view %s", async (end, row, scrollTop) => {
      await waiting(`screenshot-leaves-${end.replace(" ", "-")}`, row, { room: 600, scrollTop });
      expect(reserved('[data-message-id="a1"]')).toBe("");
    });
  });
});
