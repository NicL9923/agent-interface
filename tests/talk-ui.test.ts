// @vitest-environment jsdom
import { act, createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/client-api";
import { talkLive } from "../src/app/talk-live";
import { useTalk, type Talk } from "../src/app/use-talk";
import { TalkPanel } from "../src/components/TalkPanel";
import { VoicePicker } from "../src/components/VoicePicker";
import { STOP_SPEECH } from "../src/shared/voice";
import { mountRoot, stubMatchMedia } from "./ui-harness";

const press = (label: string) => act(async () => {
  const target = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(target, label).toBeTruthy();
  target!.click();
});

const write = vi.hoisted(() => vi.fn());
vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest({
  ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write,
}));

const players: FakeAudio[] = [];
class FakeAudio {
  onended: (() => void) | null = null; onerror: (() => void) | null = null;
  autoplay = false; srcObject: unknown = null;
  pause = vi.fn(); removeAttribute = vi.fn(); load = vi.fn();
  play = vi.fn(async () => {});
  constructor(public url?: string) { players.push(this); }
}
const peers: FakePeer[] = [];
class FakePeer {
  connectionState = "new";
  ontrack: unknown = null; onconnectionstatechange: unknown = null;
  channel = { readyState: "open", send: vi.fn(), close: vi.fn(), onopen: null as null | (() => void), onmessage: null as unknown, onclose: null as unknown };
  addTrack = vi.fn(); close = vi.fn();
  createDataChannel = vi.fn(() => this.channel);
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "v=0 offer" }));
  setLocalDescription = vi.fn(async () => {}); setRemoteDescription = vi.fn(async () => {});
  constructor() { peers.push(this); }
}
let stopTrack: ReturnType<typeof vi.fn>, getUserMedia: ReturnType<typeof vi.fn>, openai: ReturnType<typeof vi.fn>;
beforeEach(() => {
  write.mockReset(); players.length = 0; peers.length = 0;
  stopTrack = vi.fn();
  const track = { stop: stopTrack, enabled: true };
  getUserMedia = vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }));
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  openai = vi.fn(async () => ({ ok: true, status: 201, text: async () => "v=0 answer" }));
  vi.stubGlobal("fetch", openai);
});

describe("live talk", () => {
  let talk: Talk;
  function Harness({ botId }: { botId: string }) {
    talk = useTalk(botId, "Ranch Hand");
    return createElement(TalkPanel, { talk, name: "Ranch Hand" });
  }
  const session = { clientSecret: "ek_fixture", expiresAt: 1, model: "gpt-realtime-2.1", voice: "marin" };

  it("stops reply speech, connects to OpenAI with the minted secret, and releases everything on end", async () => {
    write.mockResolvedValue(session);
    const mount = mountRoot();
    await mount.render(createElement(Harness, { botId: "ranch" }));
    const stopSpeech = vi.fn(); window.addEventListener(STOP_SPEECH, stopSpeech);
    await act(async () => talk.start());
    window.removeEventListener(STOP_SPEECH, stopSpeech);
    expect(stopSpeech).toHaveBeenCalledOnce();
    expect(talkLive()).toBe(true);
    expect(write).toHaveBeenCalledWith("/bots/ranch/talk/session", {});
    const [url, init] = openai.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    expect(init).toMatchObject({ method: "POST", body: "v=0 offer", credentials: "omit", headers: { Authorization: "Bearer ek_fixture", "Content-Type": "application/sdp" } });
    expect(peers[0]!.createDataChannel).toHaveBeenCalledWith("oai-events");
    expect(peers[0]!.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "v=0 answer" });
    await act(async () => peers[0]!.channel.onopen?.());
    expect(mount.container.textContent).toContain("Listening");
    await press("End talk");
    expect(stopTrack).toHaveBeenCalled();
    expect(peers[0]!.close).toHaveBeenCalled();
    expect(talkLive()).toBe(false);
    expect(mount.container.querySelector(".talk-panel")).toBeNull();
  });

  it("reports the progress lines it said with each follow-up ask, and the request is never sent twice", async () => {
    vi.useFakeTimers();
    try {
      const answers = [{ state: "working", progress: { ids: ["n1"], text: "Checking the forecast." } }, { state: "done", text: "Sunny." }];
      write.mockImplementation(async (path: string) => path.endsWith("/talk/session") ? session : answers.shift());
      const mount = mountRoot();
      await mount.render(createElement(Harness, { botId: "ranch" }));
      await act(async () => talk.start());
      const message = JSON.stringify({ type: "response.function_call_arguments.done", name: "ask_assistant", call_id: "c1", arguments: JSON.stringify({ request: "Weather?" }) });
      await act(async () => (peers[0]!.channel.onmessage as (event: { data: string }) => void)({ data: message }));
      await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
      const asks = write.mock.calls.filter(([path]) => String(path).endsWith("/talk/ask")).map(([, body]) => body as { requestId: string; request: string; heard?: string[] });
      expect(asks).toHaveLength(2);
      // The first ask has heard nothing, so it sends no list. The follow-up names the line it said.
      expect(asks[0]).not.toHaveProperty("heard");
      expect(asks[1]).toMatchObject({ request: "Weather?", heard: ["n1"] });
      expect(asks[1]!.requestId).toBe(asks[0]!.requestId);
      await press("End talk");
    } finally { vi.useRealTimers(); }
  });

  describe("when the page leaves", () => {
    const message = (mount: ReturnType<typeof mountRoot>) => mount.container.querySelector(".talk-message")?.textContent ?? "";
    const hide = () => act(async () => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const live = async () => {
      write.mockResolvedValue(session);
      const mount = mountRoot();
      await mount.render(createElement(Harness, { botId: "ranch" }));
      return mount;
    };

    it.each([
      { name: "idle Talk on a phone, with no notice", coarse: true, started: false, ends: false },
      { name: "live Talk on a desktop, which keeps playing in a hidden tab", coarse: false, started: true, ends: false },
      { name: "live Talk on a phone", coarse: true, started: true, ends: true },
    ])("switching tabs with $name", async ({ coarse, started, ends }) => {
      stubMatchMedia(query => coarse && query === "(pointer: coarse)");
      const mount = await live();
      if (started) await act(async () => talk.start());
      await hide();
      expect(talkLive()).toBe(started && !ends);
      expect(message(mount)).toBe(ends ? "Talk ended when the app went to the background." : "");
    });

    it("leaves an earlier notice alone when a tab switch or page exit finds Talk idle", async () => {
      stubMatchMedia(query => query === "(pointer: coarse)");
      const mount = await live();
      await act(async () => talk.start());
      await hide();
      expect(message(mount)).toBe("Talk ended when the app went to the background.");
      await act(async () => window.dispatchEvent(new Event("pagehide")));
      await hide();
      expect(message(mount)).toBe("Talk ended when the app went to the background.");
    });

    it("releases live Talk when the page is hidden for good, with no notice to show", async () => {
      const mount = await live();
      await act(async () => talk.start());
      await act(async () => window.dispatchEvent(new Event("pagehide")));
      expect(peers[0]!.close).toHaveBeenCalled();
      expect(stopTrack).toHaveBeenCalled();
      expect(talkLive()).toBe(false);
      expect(message(mount)).toBe("");
    });
  });

  it("ends when the assistant changes", async () => {
    write.mockResolvedValue(session);
    const mount = mountRoot();
    await mount.render(createElement(Harness, { botId: "ranch" }));
    await act(async () => talk.start());
    await mount.render(createElement(Harness, { botId: "garden" }));
    expect(peers[0]!.close).toHaveBeenCalled();
    expect(talkLive()).toBe(false);
  });

  it("explains a denied microphone without minting a session", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    const mount = mountRoot();
    await mount.render(createElement(Harness, { botId: "ranch" }));
    await act(async () => talk.start());
    expect(mount.container.querySelector('[role="alert"]')?.textContent).toContain("Microphone permission was denied");
    expect(write).not.toHaveBeenCalled();
    expect(talkLive()).toBe(false);
  });

  it("shows Hermes's reason when the session cannot be minted, and a network failure plainly", async () => {
    write.mockRejectedValueOnce(new ApiError("Sign in to ChatGPT in Hermes to use live voice.", 409));
    const mount = mountRoot();
    await mount.render(createElement(Harness, { botId: "ranch" }));
    await act(async () => talk.start());
    expect(mount.container.querySelector('[role="alert"]')?.textContent).toContain("Sign in to ChatGPT in Hermes");
    expect(stopTrack).toHaveBeenCalled();
    write.mockResolvedValueOnce(session);
    openai.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => talk.start());
    expect(mount.container.querySelector('[role="alert"]')?.textContent).toContain("Could not reach OpenAI");
    expect(peers.at(-1)!.close).toHaveBeenCalled();
  });
});

describe("voice picker", () => {
  it("saves the chosen voice and plays one sample at a time, stopping it when closed", async () => {
    write.mockResolvedValue({ voice: "cedar" });
    const saved = vi.fn();
    const mount = mountRoot();
    await mount.render(createElement(VoicePicker, { botId: "ranch", name: "Ranch Hand", onSaved: saved }));
    const radio = (voice: string) => mount.container.querySelector<HTMLInputElement>(`input[value="${voice}"]`)!;
    expect(radio("marin").checked).toBe(true);
    expect(mount.container.querySelectorAll('input[type="radio"]')).toHaveLength(10);
    await act(async () => radio("cedar").click());
    expect(write).toHaveBeenCalledWith("/bots/ranch/voice", { voice: "cedar" }, "PUT");
    expect(saved).toHaveBeenCalledWith("cedar");
    expect(radio("cedar").checked).toBe(true);
    await press("Play Ash sample");
    expect(players[0]!.url).toBe("/voice-previews/ash.m4a");
    await press("Play Verse sample");
    expect(players[0]!.pause).toHaveBeenCalled();
    expect(players[1]!.url).toBe("/voice-previews/verse.m4a");
    await act(async () => mount.root.unmount());
    expect(players[1]!.pause).toHaveBeenCalled();
  });

  it("puts the previous voice back when saving fails", async () => {
    write.mockRejectedValueOnce(new Error("Hermes is offline."));
    const mount = mountRoot();
    await mount.render(createElement(VoicePicker, { botId: "ranch", name: "Ranch Hand", voice: "sage", onSaved: vi.fn() }));
    await act(async () => mount.container.querySelector<HTMLInputElement>('input[value="echo"]')!.click());
    expect(mount.container.querySelector<HTMLInputElement>('input[value="sage"]')!.checked).toBe(true);
    expect(mount.container.querySelector('[role="alert"]')?.textContent).toContain("Hermes is offline.");
  });
});
