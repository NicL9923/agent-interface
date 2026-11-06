import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../client-api";
import { MAX_SPOKEN_TEXT, MAX_VOICE_BYTES, STOP_SPEECH } from "../shared/voice";
import type { VoicePlayback } from "../shared/voice";
import { talkLive } from "./talk-live";

/** Preparing is the request and download, ready is audio the browser would not start by itself, speaking is playing. */
export type SpeechPhase = "preparing" | "ready" | "speaking";
export interface ReplySpeech {
  /** The one reply being prepared or spoken, if any. */
  current: { id: string; phase: SpeechPhase } | null;
  /** Why a reply could not be spoken. It stays until the next try on any reply. */
  error: { id: string; text: string } | null;
  /** Starts speaking the reply, plays prepared audio, or stops this reply. Another reply's playback stops first. */
  toggle(message: { id: string; text: string }): void;
}
const failure = (error: unknown) => error instanceof Error ? error.message : "The reply could not be spoken.";

/**
 * Reads one assistant reply aloud at a time for the whole transcript. The audio is released when
 * another reply starts, when the connection drops, when the assistant changes and when the view closes.
 */
export function useReplySpeech(botId: string, disabled: boolean): ReplySpeech {
  const [current, setCurrent] = useState<ReplySpeech["current"]>(null);
  const [error, setError] = useState<ReplySpeech["error"]>(null);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const live = useRef<ReplySpeech["current"]>(null);
  const show = (next: ReplySpeech["current"]) => { live.current = next; setCurrent(next); };
  const release = () => {
    const audio = player.current; player.current = null;
    if (audio) { audio.onplaying = audio.onended = audio.onerror = null; audio.pause(); audio.removeAttribute("src"); }
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
  };
  const stop = useCallback(() => {
    generation.current++;
    request.current?.abort(); request.current = null;
    release(); show(null);
  }, []);
  useEffect(() => { setError(null); return stop; }, [botId, stop]);
  useEffect(() => { if (disabled) stop(); }, [disabled, stop]);
  useEffect(() => {
    window.addEventListener(STOP_SPEECH, stop);
    return () => window.removeEventListener(STOP_SPEECH, stop);
  }, [stop]);

  async function play(id: string, run: number) {
    const audio = player.current;
    if (!audio) return;
    setError(null); show({ id, phase: "preparing" });
    try { await audio.play(); }
    catch {
      if (generation.current !== run) return;
      show({ id, phase: "ready" });
      setError({ id, text: "Audio could not start. Select Play audio to try again." });
    }
  }
  async function speak(message: { id: string; text: string }) {
    if (message.text.length > MAX_SPOKEN_TEXT) { setError({ id: message.id, text: "This reply is too long to read aloud. Ask for a shorter summary." }); return; }
    const run = ++generation.current;
    const controller = new AbortController(); request.current = controller;
    release(); setError(null); show({ id: message.id, phase: "preparing" });
    try {
      const result = await api<VoicePlayback>(`/bots/${encodeURIComponent(botId)}/voice/speak`, { method: "POST", body: JSON.stringify({ messageId: message.id }), signal: controller.signal });
      if (generation.current !== run) return;
      if (!/^\/api\/voice\/audio\/[0-9a-f-]{36}$/.test(result.url)) throw new Error("The app returned an invalid audio link.");
      const response = await fetch(result.url, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
      if (!response.ok) throw new Error("This audio reply expired. Select Listen to reply to prepare it again.");
      const blob = await response.blob();
      if (generation.current !== run) return;
      if (!blob.size || blob.size > MAX_VOICE_BYTES) throw new Error("The spoken reply could not be loaded.");
      url.current = URL.createObjectURL(blob);
      const audio = new Audio(url.current); player.current = audio;
      audio.onplaying = () => { if (generation.current === run) show({ id: message.id, phase: "speaking" }); };
      // The prepared audio stays, so Play audio replays it without another request.
      audio.onended = () => { if (generation.current === run) show({ id: message.id, phase: "ready" }); };
      audio.onerror = () => {
        if (generation.current !== run) return;
        release(); show(null);
        setError({ id: message.id, text: "This browser could not play the spoken reply." });
      };
      await play(message.id, run);
    } catch (cause) {
      if (generation.current === run && !controller.signal.aborted) { release(); show(null); setError({ id: message.id, text: failure(cause) }); }
    } finally { if (request.current === controller) request.current = null; }
  }
  const toggle = useCallback((message: { id: string; text: string }) => {
    const now = live.current;
    if (now?.id === message.id) {
      if (now.phase === "ready") void play(message.id, generation.current);
      else stop();
      return;
    }
    // Live Talk owns the speaker and microphone; a reply read aloud would talk over it.
    if (talkLive()) { setError({ id: message.id, text: "Replies aren't read aloud during live Talk. End Talk to listen." }); return; }
    void speak(message);
  // `play`, `speak` and `stop` only touch refs and state setters, so they never need to be dependencies.
  }, [botId, stop]);
  return useMemo(() => ({ current, error, toggle }), [current, error, toggle]);
}
