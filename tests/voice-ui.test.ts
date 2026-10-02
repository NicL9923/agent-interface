// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { VoiceControls } from "../src/components/VoiceControls.js";
import type { VoiceState } from "../src/shared/voice.js";
const requestApi = vi.hoisted(() => vi.fn());
vi.mock("../src/client-api.js", () => ({ api: requestApi }));
let container: HTMLDivElement, root: Root;
let transcript: ReturnType<typeof vi.fn<(text: string) => void>>, state: ReturnType<typeof vi.fn<(state: VoiceState) => void>>;
let stopped: ReturnType<typeof vi.fn>, getUserMedia: ReturnType<typeof vi.fn>;
const recorders: FakeRecorder[] = [];
class FakeRecorder {
  state = "inactive"; mimeType = "audio/webm;codecs=opus";
  ondataavailable?: (event: { data: Blob }) => void; onstop?: () => void; onerror?: () => void;
  static isTypeSupported(mime: string) { return mime.startsWith("audio/webm"); }
  constructor() { recorders.push(this); }
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["recorded words"], { type: this.mimeType }) }); this.onstop?.(); }
}
const players: FakeAudio[] = [];
class FakeAudio {
  onplaying: (() => void) | null = null; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  pause = vi.fn(); removeAttribute = vi.fn();
  play = vi.fn(async () => { this.onplaying?.(); });
  constructor(public url: string) { players.push(this); }
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); requestApi.mockReset(); recorders.length = 0; players.length = 0;
  stopped = vi.fn(); getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopped }] }));
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", FakeRecorder); vi.stubGlobal("Audio", FakeAudio);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:voice-fixture") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob(["spoken reply"], { type: "audio/mpeg" }) })));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  transcript = vi.fn(); state = vi.fn();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function render(disabled = false) { await act(async () => root.render(createElement(VoiceControls, { botId: "ranch", onTranscript: transcript, onStateChange: state, reply: { id: "reply", text: "Here is your list." }, disabled }))); }
async function click(label: string) { const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.startsWith(label))!; expect(button).toBeTruthy(); await act(async () => button.click()); }
it("records only after a gesture, stops the microphone and adds a transcript for review", async () => {
  requestApi.mockResolvedValue({ text: "Pick up milk" }); await render(); expect(getUserMedia).not.toHaveBeenCalled();
  await click("Record voice"); expect(state).toHaveBeenLastCalledWith("recording"); expect(transcript).not.toHaveBeenCalled();
  await click("Stop recording"); expect(stopped).toHaveBeenCalled(); expect(requestApi).toHaveBeenCalledWith("/bots/ranch/voice/transcribe", expect.objectContaining({ method: "POST", body: expect.any(FormData) }));
  expect(transcript).toHaveBeenCalledExactlyOnceWith("Pick up milk"); expect(container.textContent).toContain("Review it before sending"); expect(state).toHaveBeenLastCalledWith("idle");
});
it("keeps a failed recording for explicit retry while preserving existing draft input", async () => {
  requestApi.mockRejectedValueOnce(new Error("Provider unavailable")).mockResolvedValueOnce({ text: "Retry words" }); await render();
  await click("Record voice"); await click("Stop recording"); expect(transcript).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("recording is kept here for retry");
  await click("Retry transcription"); expect(transcript).toHaveBeenCalledExactlyOnceWith("Retry words"); expect(requestApi).toHaveBeenCalledTimes(2);
});
it("canceling recording discards captured audio without a provider call", async () => {
  await render(); await click("Record voice"); await click("Cancel voice");
  expect(stopped).toHaveBeenCalled(); expect(requestApi).not.toHaveBeenCalled(); expect(transcript).not.toHaveBeenCalled(); expect(state).toHaveBeenLastCalledWith("idle");
});
it("handles microphone denial and releases a late permission result after cancel", async () => {
  getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError")); await render(); await click("Record voice");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("permission was denied");
  let resolve!: (value: { getTracks(): { stop: typeof stopped }[] }) => void;
  getUserMedia.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await click("Record voice"); await click("Cancel voice");
  await act(async () => { resolve({ getTracks: () => [{ stop: stopped }] }); });
  expect(recorders).toHaveLength(0); expect(stopped).toHaveBeenCalledOnce(); expect(state).toHaveBeenLastCalledWith("idle");
});
it("reports silence without changing the draft, and explains unsupported recording", async () => {
  requestApi.mockResolvedValue({ text: "" }); await render(); await click("Record voice"); await click("Stop recording");
  expect(container.textContent).toContain("No speech detected"); expect(transcript).not.toHaveBeenCalled();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined }); await render();
  expect(container.textContent).toContain("unavailable in this browser"); expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Record voice")?.disabled).toBe(true);
});
it("uses canonical server reply audio, reports speaking only during playback and stops it", async () => {
  requestApi.mockResolvedValue({ url: "/api/voice/audio/01234567-0123-4123-8123-012345678901", mime: "audio/mpeg", expiresAt: "future" });
  await render(); await click("Listen to reply");
  expect(requestApi).toHaveBeenCalledWith("/bots/ranch/voice/speak", expect.objectContaining({ body: JSON.stringify({ messageId: "reply" }) }));
  expect(fetch).toHaveBeenCalledWith("/api/voice/audio/01234567-0123-4123-8123-012345678901", expect.objectContaining({ credentials: "same-origin", redirect: "error" }));
  expect(state).toHaveBeenLastCalledWith("speaking");
  await click("Stop speaking"); expect(players[0]!.pause).toHaveBeenCalled(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-fixture"); expect(state).toHaveBeenLastCalledWith("idle");
});
it("aborts a pending transcription when controls become unavailable and ignores its result", async () => {
  let resolve!: (value: { text: string }) => void;
  requestApi.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await render(); await click("Record voice"); await click("Stop recording");
  const signal = requestApi.mock.calls[0]![1].signal as AbortSignal; expect(signal.aborted).toBe(false);
  await render(true); expect(signal.aborted).toBe(true);
  await act(async () => { resolve({ text: "Late transcript" }); }); expect(transcript).not.toHaveBeenCalled();
});
