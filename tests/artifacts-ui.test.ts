// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactsButton } from "../src/components/Artifacts";
import type { Bot, Conversation, FileRef } from "../src/shared/types";

const bot: Bot = { id: "ranch", name: "Ranch hand", shared: true, model: "test", activity: "idle" };
const file = (id: string, name: string, mime = "text/plain", url?: string): FileRef =>
  ({ id, name, mime, url: url || `/api/files/${encodeURIComponent(id)}` });
let container: HTMLDivElement;
let root: Root;
let conversation: Conversation;
let fetchFile: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchFile = vi.fn().mockImplementation(async () => new Response("Plain preview", { headers: { "Content-Type": "text/plain" } }));
  vi.stubGlobal("fetch", fetchFile);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  conversation = { botId: "ranch", messages: [], files: [], approvals: [], activity: { state: "idle" } };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function render(value: Conversation | null = conversation, unavailable = false) {
  await act(async () => root.render(createElement(ArtifactsButton, { bot, conversation: value, unavailable })));
}
async function open() { await act(async () => container.querySelector<HTMLButtonElement>(".artifacts-button")!.click()); }
async function select(name: string) {
  const item = [...container.querySelectorAll<HTMLButtonElement>(".artifact-item")].find(item => item.querySelector("strong")?.textContent === name)!;
  await act(async () => item.click());
}
async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("conversation artifacts", () => {
  it("deduplicates discovered/message files, reports their origin, and filters by filename and type", async () => {
    const plan = file("plan", "grazing-plan.md", "text/markdown"), image = file("image", "pasture.png", "image/png"), shared = file("csv", "sensor-history.csv", "text/csv");
    conversation.files = [plan, image, shared];
    conversation.messages = [{ id: "output", role: "assistant", text: "Ready", files: [plan, image] },
      { id: "input", role: "user", text: "Use this", files: [shared] }];
    await render();
    expect(container.querySelector(".artifacts-button")?.getAttribute("aria-label")).toBe("Artifacts (3)");
    await open();
    const items = container.querySelectorAll(".artifact-item");
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain("Generated");
    expect(items[2]?.textContent).toContain("Shared");
    const type = container.querySelector<HTMLSelectElement>(".artifacts-toolbar select")!;
    await act(async () => { type.value = "image"; type.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelectorAll(".artifact-item")).toHaveLength(1);
    expect(container.querySelector(".artifact-detail img")?.getAttribute("src")).toBe("/api/files/image");
    await enter(container.querySelector<HTMLInputElement>('input[type="search"]')!, "no-such-file");
    expect(container.textContent).toContain("No matching files");
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Clear filters")!.click());
    expect(container.querySelectorAll(".artifact-item")).toHaveLength(3);
  });

  it("renders text as escaped content, links authenticated downloads, and cancels an obsolete request", async () => {
    conversation.files = [file("text", "notes.txt"), file("image", "pasture.png", "image/png")];
    fetchFile.mockResolvedValueOnce(new Response('<img src="https://untrusted.test" onerror="alert(1)">'));
    await render(); await open();
    expect(container.querySelector("pre")?.textContent).toContain('<img src="https://untrusted.test"');
    expect(container.querySelector(".artifact-preview img")).toBeNull();
    expect(container.querySelector('a[download="notes.txt"]')?.getAttribute("href")).toBe("/api/files/text");
    expect(fetchFile).toHaveBeenCalledWith("/api/files/text", expect.objectContaining({ credentials: "same-origin", redirect: "error" }));
    await select("pasture.png");
    let signal!: AbortSignal;
    fetchFile.mockImplementationOnce((_url: string, init: RequestInit) => { signal = init.signal as AbortSignal; return new Promise(() => {}); });
    await select("notes.txt");
    expect(signal.aborted).toBe(false);
    await select("pasture.png");
    expect(signal.aborted).toBe(true);
  });

  it("keeps external files behind an explicit source link and rejects active URLs and documents", async () => {
    conversation.files = [file("external", "external.png", "image/png", "https://files.example.test/photo.png"),
      file("script", "bad.txt", "text/plain", "javascript:alert(1)"),
      file("svg", "drawing.svg", "image/svg+xml"), file("html", "page.html", "text/html")];
    await render(); await open();
    expect(fetchFile).not.toHaveBeenCalled();
    expect(container.querySelector(".artifact-preview img")).toBeNull();
    expect(container.querySelector(".artifact-actions a")?.textContent).toContain("Open source");
    await select("bad.txt");
    expect(container.querySelector(".artifact-actions a")).toBeNull();
    await select("drawing.svg");
    expect(container.textContent).toContain("A preview is not available");
    await select("page.html");
    expect(container.querySelector("iframe, object, embed")).toBeNull();
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it("requires an exact app file route before loading a preview", async () => {
    conversation.files = [file("id", "wrong-id.png", "image/png", "/api/files/other"),
      file("query", "query.txt", "text/plain", "/api/files/query?redirect=https://external.test")];
    await render(); await open(); await select("query.txt");
    expect(fetchFile).not.toHaveBeenCalled();
    expect(container.querySelector(".artifact-preview img")).toBeNull();
  });

  it("provides playback controls for supported media and opens PDFs without embedding an active document", async () => {
    conversation.files = [file("audio", "field-recording.mp3", "audio/mpeg"),
      file("video", "pasture-survey.mp4", "video/mp4"), file("pdf", "plan.pdf", "application/pdf")];
    await render(); await open();
    expect(container.querySelector("audio")?.controls).toBe(true);
    expect(container.querySelector("audio")?.getAttribute("src")).toBe("/api/files/audio");
    await select("pasture-survey.mp4");
    expect(container.querySelector("video")?.controls).toBe(true);
    expect(container.querySelector("video")?.playsInline).toBe(true);
    await select("plan.pdf");
    expect(container.textContent).toContain("Open this PDF in a new tab");
    expect(container.querySelector("iframe, object, embed")).toBeNull();
    expect(container.querySelector('a[download="plan.pdf"]')?.getAttribute("href")).toBe("/api/files/pdf");
  });

  it("reports text download failures and retries only when asked", async () => {
    conversation.files = [file("missing", "notes.txt")];
    fetchFile.mockResolvedValueOnce(new Response("Missing", { status: 404 }));
    await render(); await open();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be loaded");
    expect(fetchFile).toHaveBeenCalledTimes(1);
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Retry preview")!.click());
    expect(container.querySelector("pre")?.textContent).toBe("Plain preview");
    expect(fetchFile).toHaveBeenCalledTimes(2);
  });

  it("bounds text previews and retains the full-file download", async () => {
    conversation.files = [file("large", "large.txt")];
    fetchFile.mockResolvedValueOnce(new Response("a".repeat(256 * 1024 + 50)));
    await render(); await open();
    expect(container.querySelector("pre")?.textContent?.length).toBe(256 * 1024);
    expect(container.textContent).toContain("Showing the first 256 KB");
    expect(container.querySelector('a[download="large.txt"]')).not.toBeNull();
  });

  it("handles image errors, offers retry, and restores focus after dismissal", async () => {
    conversation.files = [file("image", "pasture.png", "image/png")];
    await render();
    const trigger = container.querySelector<HTMLButtonElement>(".artifacts-button")!;
    trigger.focus(); await open();
    const image = container.querySelector(".artifact-preview img")!;
    await act(async () => image.dispatchEvent(new Event("error")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("couldn’t load this preview");
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Retry preview")!.click());
    expect(container.querySelector(".artifact-preview img")).not.toBe(image);
    await act(async () => container.querySelector("dialog")!.dispatchEvent(new Event("cancel")));
    expect(container.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("distinguishes empty, loading, unavailable, and another assistant’s stale conversation", async () => {
    await render(); await open();
    expect(container.textContent).toContain("No artifacts yet");
    await render(null);
    expect(container.textContent).toContain("Loading your conversation");
    await render(null, true);
    expect(container.textContent).toContain("Files are unavailable until your assistant reconnects");
    await render({ ...conversation, botId: "another", files: [file("private", "another-bot.txt")] });
    expect(container.textContent).not.toContain("another-bot.txt");
    expect(container.textContent).toContain("Loading your conversation");
  });
});
