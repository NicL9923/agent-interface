// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { MessageMeta, TranscriptTools } from "../src/app/ReplyActions";
import { useReplySpeech } from "../src/app/use-reply-speech";
import { MAX_SPOKEN_TEXT, STOP_SPEECH } from "../src/shared/voice";
import type { Message } from "../src/shared/types";
import { mountRoot } from "./ui-harness";

const requestApi = vi.hoisted(() => vi.fn());
vi.mock("../src/client-api", async () => (await import("./helpers/request-mock")).withRequest({ api: requestApi }));
const audioUrl = (id: number) => `/api/voice/audio/01234567-0123-4123-8123-01234567890${id}`;
const players: FakeAudio[] = [];
class FakeAudio {
  onplaying: (() => void) | null = null; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  pause = vi.fn(); removeAttribute = vi.fn();
  play = vi.fn(async () => { this.onplaying?.(); });
  constructor(public url: string) { players.push(this); }
}
const reply = (id: string, text = `Reply ${id}`): Message => ({ id, role: "assistant", text });
const own: Message = { id: "mine", role: "user", text: "My words" };
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  requestApi.mockReset(); players.length = 0;
  vi.stubGlobal("Audio", FakeAudio);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:spoken") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob(["spoken reply"], { type: "audio/mpeg" }) })));
  ({ container, root } = mountRoot());
});
// A transcript's worth of messages sharing one speech controller, as Conversation does.
function Transcript({ bot = "ranch", unavailable = false, messages }: { bot?: string; unavailable?: boolean; messages: Message[] }) {
  const speech = useReplySpeech(bot, unavailable);
  const tools = { botId: bot, sessionId: "session", unavailable, quote: vi.fn(), announce: vi.fn(), speech };
  return createElement(TranscriptTools.Provider, { value: tools }, messages.map(message =>
    createElement("div", { key: message.id, "data-id": message.id }, createElement(MessageMeta, { message, own: message.role === "user", actions: true }))));
}
const render = (props: Parameters<typeof Transcript>[0]) => act(async () => root.render(createElement(Transcript, props)));
const button = (id: string, label: string) => container.querySelector<HTMLButtonElement>(`[data-id="${id}"] [aria-label="${label}"]`);
const press = async (id: string, label: string) => { const found = button(id, label); expect(found, `${label} on ${id}`).toBeTruthy(); await act(async () => found!.click()); };
const answer = (id = 1) => requestApi.mockResolvedValue({ url: audioUrl(id), mime: "audio/mpeg", expiresAt: "future" });

it("puts a small Copy button under a person's own message, and only Copy", async () => {
  await render({ messages: [own, reply("a")] });
  const labels = (id: string) => [...container.querySelectorAll(`[data-id="${id}"] button`)].map(item => item.getAttribute("aria-label"));
  expect(labels("mine")).toEqual(["Copy message"]);
  expect(labels("a")).toContain("Listen to reply");
  expect(labels("a")).toContain("Copy reply");
});
it("speaks the chosen reply, reports speaking only during playback and stops it", async () => {
  answer(); await render({ messages: [reply("a")] });
  await press("a", "Listen to reply");
  expect(requestApi).toHaveBeenCalledWith("/bots/ranch/voice/speak", expect.objectContaining({ method: "POST", body: JSON.stringify({ messageId: "a" }) }));
  expect(fetch).toHaveBeenCalledWith(audioUrl(1), expect.objectContaining({ credentials: "same-origin", redirect: "error" }));
  expect(button("a", "Stop speaking")).toBeTruthy();
  await press("a", "Stop speaking");
  expect(players[0]!.pause).toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:spoken");
  expect(button("a", "Listen to reply")).toBeTruthy();
});
it("plays one reply at a time across the transcript, in any reply", async () => {
  answer(1); await render({ messages: [reply("a"), reply("b")] });
  await press("a", "Listen to reply");
  answer(2); await press("b", "Listen to reply");
  expect(players[0]!.pause).toHaveBeenCalled();
  expect(requestApi).toHaveBeenLastCalledWith("/bots/ranch/voice/speak", expect.objectContaining({ body: JSON.stringify({ messageId: "b" }) }));
  expect(button("b", "Stop speaking")).toBeTruthy();
  expect(button("a", "Listen to reply")).toBeTruthy();
});
it("replays finished audio without asking the server again", async () => {
  answer(); await render({ messages: [reply("a")] });
  await press("a", "Listen to reply");
  await act(async () => players[0]!.onended?.());
  await press("a", "Play audio");
  expect(players[0]!.play).toHaveBeenCalledTimes(2);
  expect(requestApi).toHaveBeenCalledTimes(1);
});
it("shows what went wrong under the reply and clears it on the next try", async () => {
  await render({ messages: [reply("long", "x".repeat(MAX_SPOKEN_TEXT + 1)), reply("a")] });
  await press("long", "Listen to reply");
  expect(requestApi).not.toHaveBeenCalled();
  expect(container.querySelector('[data-id="long"] [role="alert"]')?.textContent).toContain("too long to read aloud");
  requestApi.mockRejectedValueOnce(new Error("Spoken replies are unavailable on this Hermes connection."));
  await press("a", "Listen to reply");
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(container.querySelector('[data-id="a"] [role="alert"]')?.textContent).toContain("unavailable on this Hermes connection");
  expect(button("a", "Listen to reply")).toBeTruthy();
});
it("tells the person when the browser would not start the audio, and offers to play it", async () => {
  answer(); await render({ messages: [reply("a")] });
  vi.stubGlobal("Audio", class extends FakeAudio {
    constructor(url: string) { super(url); this.play = vi.fn(async () => { throw new DOMException("blocked", "NotAllowedError"); }); }
  });
  await press("a", "Listen to reply");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Audio could not start");
  expect(button("a", "Play audio")).toBeTruthy();
});
it("is unavailable while disconnected, and stops playing when the connection drops", async () => {
  answer(); await render({ messages: [reply("a")] });
  await press("a", "Listen to reply");
  await render({ messages: [reply("a")], unavailable: true });
  expect(players[0]!.pause).toHaveBeenCalled();
  expect(button("a", "Listen to reply")!.disabled).toBe(true);
  expect(button("a", "Listen to reply")!.title).toContain("Reconnect");
});
it("releases the audio when the assistant changes, when recording starts and when the view closes", async () => {
  answer(); await render({ messages: [reply("a")] });
  await press("a", "Listen to reply");
  await render({ bot: "other", messages: [reply("a")] });
  expect(players[0]!.pause).toHaveBeenCalled();
  expect(button("a", "Listen to reply")).toBeTruthy();
  await press("a", "Listen to reply");
  await act(async () => { window.dispatchEvent(new Event(STOP_SPEECH)); });
  expect(players[1]!.pause).toHaveBeenCalled();
  expect(button("a", "Listen to reply")).toBeTruthy();
  await press("a", "Listen to reply");
  await act(async () => root.unmount());
  expect(players[2]!.pause).toHaveBeenCalled();
});
it("lets the person cancel while the reply is still being prepared, and ignores its late answer", async () => {
  let late!: (value: unknown) => void;
  requestApi.mockImplementationOnce(() => new Promise(done => { late = done; }));
  await render({ messages: [reply("a")] });
  await press("a", "Listen to reply");
  expect(button("a", "Preparing spoken reply")).toBeTruthy();
  await press("a", "Preparing spoken reply");
  expect(button("a", "Listen to reply")).toBeTruthy();
  await act(async () => { late({ url: audioUrl(1), mime: "audio/mpeg", expiresAt: "future" }); });
  expect(players).toHaveLength(0);
  expect(button("a", "Listen to reply")).toBeTruthy();
});
