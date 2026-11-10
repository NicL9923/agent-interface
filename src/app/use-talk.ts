import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, request } from "../client-api";
import { STOP_SPEECH } from "../shared/voice";
import { setTalkLive } from "./talk-live";
import { TalkLoop, type TalkCaptions, type TalkPhase } from "./talk-loop";

export type TalkStatus = "idle" | "connecting" | TalkPhase;
export interface Talk {
  status: TalkStatus;
  captions: TalkCaptions;
  muted: boolean;
  /** Why Talk could not start or stopped. It stays until the next start or dismiss. */
  error: string;
  /** Why Talk ended by itself, such as a quiet spell. */
  notice: string;
  start(): void;
  end(): void;
  toggleMute(): void;
  dismiss(): void;
  /** Shows why Talk cannot start, without starting it. */
  explain(message: string): void;
}
const CALLS_URL = "https://api.openai.com/v1/realtime/calls";
export const TALK_IDLE_MS = 5 * 60_000;
export const TALK_MAX_MS = 30 * 60_000;
const empty: TalkCaptions = { you: "", assistant: "" };
// A phone stops a hidden page's audio and timers unpredictably, so Talk ends with it there.
const phone = () => typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

function microphoneError(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  return name === "NotAllowedError" ? "Microphone permission was denied. Allow it in your browser settings, then start Talk again."
    : name === "NotFoundError" ? "No microphone was found. Connect one, then start Talk again."
    : "The microphone could not start. Close other apps using it, then try again.";
}

/**
 * A live duplex voice conversation with one assistant over WebRTC. The server mints a short-lived
 * secret; the browser sends its offer straight to OpenAI. Everything is released when Talk ends,
 * the assistant changes, the view closes or the page goes away.
 */
export function useTalk(botId: string, name: string): Talk {
  const [status, setStatus] = useState<TalkStatus>("idle");
  const [captions, setCaptions] = useState<TalkCaptions>(empty);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const parts = useRef<{ pc?: RTCPeerConnection; channel?: RTCDataChannel; stream?: MediaStream; audio?: HTMLAudioElement; loop?: TalkLoop;
    timer?: ReturnType<typeof setInterval>; live?: boolean; started: number; heard: number }>({ started: 0, heard: 0 });

  const release = useCallback(() => {
    generation.current++;
    const current = parts.current;
    current.loop?.dispose();
    clearInterval(current.timer);
    if (current.channel) { current.channel.onmessage = current.channel.onclose = null; current.channel.close(); }
    if (current.pc) { current.pc.onconnectionstatechange = current.pc.ontrack = null; current.pc.close(); }
    current.stream?.getTracks().forEach(track => track.stop());
    if (current.audio) { current.audio.pause(); current.audio.srcObject = null; }
    parts.current = { started: 0, heard: 0 };
    setTalkLive(false);
    setStatus("idle"); setMuted(false);
  }, []);
  const end = useCallback((why = "") => { release(); setNotice(why); }, [release]);
  const fail = useCallback((message: string) => { release(); setError(message); }, [release]);

  const start = useCallback(async () => {
    if (parts.current.live) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      setError("Talk needs a browser with microphone and WebRTC support over a secure connection. You can still type or record."); return;
    }
    const run = ++generation.current;
    const stale = () => generation.current !== run;
    // The microphone and speaker now belong to Talk: no recording, no reply read aloud.
    window.dispatchEvent(new Event(STOP_SPEECH));
    setTalkLive(true);
    setError(""); setNotice(""); setCaptions(empty); setStatus("connecting");
    const current = parts.current;
    current.live = true;
    try {
      try { current.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch (cause) { if (!stale()) fail(microphoneError(cause)); return; }
      if (stale()) { current.stream.getTracks().forEach(track => track.stop()); return; }
      const session = await request("POST /bots/:id/talk/session", { params: { id: botId } });
      if (stale()) return;
      const pc = current.pc = new RTCPeerConnection();
      const audio = current.audio = new Audio();
      audio.autoplay = true;
      pc.ontrack = event => { audio.srcObject = event.streams[0] ?? null; void audio.play().catch(() => {}); };
      for (const track of current.stream.getAudioTracks()) pc.addTrack(track, current.stream);
      const channel = current.channel = pc.createDataChannel("oai-events");
      const loop = current.loop = new TalkLoop({
        send: event => { if (channel.readyState === "open") channel.send(JSON.stringify(event)); },
        ask: (requestId, text, signal, heard) => request("POST /bots/:id/talk/ask", { params: { id: botId }, body: { requestId, request: text, ...(heard.length ? { heard: [...heard] } : {}) }, signal }),
        phase: phase => { if (!stale()) setStatus(phase); },
        captions: next => { if (!stale()) setCaptions(next); },
        activity: () => { current.heard = Date.now(); },
        problem: message => { if (!stale()) setError(message); },
        newId: () => crypto.randomUUID(),
      }, name);
      channel.onopen = () => { if (!stale()) { current.heard = Date.now(); setStatus("listening"); } };
      channel.onmessage = event => { try { loop.handle(JSON.parse(String(event.data))); } catch { /* A malformed event changes nothing. */ } };
      channel.onclose = () => { if (!stale()) fail("The voice connection closed. Start Talk again."); };
      pc.onconnectionstatechange = () => { if (!stale() && pc.connectionState === "failed") fail("The voice connection dropped. Start Talk again."); };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      let response: Response;
      try {
        response = await fetch(CALLS_URL, { method: "POST", body: offer.sdp, credentials: "omit", cache: "no-store", redirect: "error",
          headers: { Authorization: `Bearer ${session.clientSecret}`, "Content-Type": "application/sdp" } });
      } catch { if (!stale()) fail("Could not reach OpenAI. Check your connection, then start Talk again."); return; }
      if (stale()) return;
      if (!response.ok) { fail(`OpenAI did not accept the voice call (HTTP ${response.status}). Start Talk again.`); return; }
      await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
      if (stale()) return;
      current.started = current.heard = Date.now();
      current.timer = setInterval(() => {
        const now = Date.now();
        if (now - current.started >= TALK_MAX_MS) end("Talk ended after 30 minutes. Start it again to keep talking.");
        else if (now - current.heard >= TALK_IDLE_MS) end("Talk ended after five quiet minutes.");
      }, 10_000);
    } catch (cause) {
      if (stale()) return;
      fail(cause instanceof ApiError ? cause.message : "Talk could not start. Try again, or type your message.");
    }
  }, [botId, name, end, fail]);

  useEffect(() => {
    const leave = () => end();
    const hidden = () => { if (document.visibilityState === "hidden" && phone()) end("Talk ended when the app went to the background."); };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("pagehide", leave); document.removeEventListener("visibilitychange", hidden); };
  }, [end]);
  // A different assistant, or leaving the chat, ends the conversation.
  useEffect(() => () => release(), [botId, release]);

  const toggleMute = useCallback(() => {
    const tracks = parts.current.stream?.getAudioTracks() ?? [];
    if (!tracks.length) return;
    const next = tracks[0]!.enabled;
    for (const track of tracks) track.enabled = !next;
    setMuted(next);
  }, []);
  const actions = useMemo(() => ({ start: () => void start(), end: () => end(), toggleMute,
    dismiss: () => { setError(""); setNotice(""); }, explain: (message: string) => { setNotice(""); setError(message); } }), [start, end, toggleMute]);
  return { status, captions, muted, error, notice, ...actions };
}
