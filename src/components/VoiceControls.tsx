import { useEffect, useRef, useState } from "react";
import { api } from "../client-api.js";
import { Icon } from "./Icon.js";
import { MAX_RECORDING_SECONDS, MAX_SPOKEN_TEXT, MAX_VOICE_BYTES } from "../shared/voice.js";
import type { VoicePlayback, VoiceState, VoiceTranscript } from "../shared/voice.js";
import "./voice-controls.css";

export interface VoiceControlsProps {
  botId: string;
  reply?: { id: string; text: string };
  disabled?: boolean;
  onTranscript(text: string): void;
  onStateChange?(state: VoiceState): void;
}
const labels: Record<VoiceState, string> = { idle: "", requesting: "Waiting for microphone permission…", recording: "Recording", transcribing: "Transcribing…", preparing: "Preparing spoken reply…", speaking: "Speaking" };
const message = (error: unknown) => error instanceof Error ? error.message : "Voice could not be completed. Your draft is kept.";

export function VoiceControls({ botId, reply, disabled = false, onTranscript, onStateChange }: VoiceControlsProps) {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recording, setRecording] = useState<Blob | null>(null);
  const [playable, setPlayable] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const callbacks = useRef({ onTranscript, onStateChange }); callbacks.current = { onTranscript, onStateChange };
  const media = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const playback = useRef<HTMLAudioElement | null>(null);
  const audioURL = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const discarded = useRef(false);
  const active = useRef<VoiceState>("idle");
  const transition = (next: VoiceState) => { active.current = next; setState(next); callbacks.current.onStateChange?.(next); };
  const releaseMic = () => {
    if (timer.current) clearInterval(timer.current); timer.current = null;
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
  };
  const releaseAudio = () => {
    const player = playback.current; playback.current = null;
    if (player) { player.onplaying = player.onended = player.onerror = null; player.pause(); player.removeAttribute("src"); }
    if (audioURL.current) URL.revokeObjectURL(audioURL.current); audioURL.current = null;
  };
  const cancel = () => {
    generation.current++; discarded.current = true;
    request.current?.abort(); request.current = null;
    if (media.current?.state !== "inactive") media.current?.stop(); media.current = null;
    releaseMic(); releaseAudio(); setPlayable(false); transition("idle");
  };
  useEffect(() => {
    return () => {
      generation.current++; discarded.current = true; request.current?.abort();
      if (media.current?.state !== "inactive") media.current?.stop(); media.current = null;
      releaseMic(); releaseAudio(); callbacks.current.onStateChange?.("idle");
    };
  }, [botId]);
  useEffect(() => { if (disabled && active.current !== "idle") cancel(); }, [disabled]);

  async function transcribe(blob: Blob) {
    const run = ++generation.current;
    const controller = new AbortController(); request.current = controller;
    setError(""); setNotice(""); transition("transcribing");
    const form = new FormData(); form.append("audio", blob, "recording");
    try {
      const result = await api<VoiceTranscript>(`/bots/${encodeURIComponent(botId)}/voice/transcribe`, { method: "POST", body: form, signal: controller.signal });
      if (generation.current !== run) return;
      if (!result.text.trim()) { setNotice("No speech detected. Try recording again."); setRecording(null); }
      else { callbacks.current.onTranscript(result.text); setRecording(null); setNotice("Added to your draft. Review it before sending."); }
    } catch (e) {
      if (generation.current === run && !controller.signal.aborted) setError(`${message(e)} Your recording is kept here for retry.`);
    } finally { if (generation.current === run) { request.current = null; transition("idle"); } }
  }
  async function startRecording() {
    if (active.current !== "idle" || disabled) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Recording needs a browser with microphone support and a secure connection. You can still type your message."); return;
    }
    const run = ++generation.current; discarded.current = false;
    releaseAudio(); setPlayable(false); setError(""); setNotice(""); setElapsed(0); transition("requesting");
    try {
      const input = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation.current !== run) { input.getTracks().forEach(track => track.stop()); return; }
      stream.current = input;
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(mime => MediaRecorder.isTypeSupported(mime));
      const recorder = new MediaRecorder(input, mimeType ? { mimeType } : undefined); media.current = recorder;
      const chunks: Blob[] = []; let bytes = 0;
      recorder.ondataavailable = event => {
        if (!event.data.size || generation.current !== run) return;
        bytes += event.data.size;
        if (bytes > MAX_VOICE_BYTES) {
          discarded.current = true; setError("This recording reached the 8 MB limit. Try a shorter recording.");
          if (recorder.state !== "inactive") recorder.stop(); releaseMic(); return;
        }
        chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (generation.current !== run) return;
        cancel(); setError("The microphone stopped recording. Try recording again. Your draft is kept.");
      };
      recorder.onstop = () => {
        if (generation.current !== run) return;
        releaseMic(); if (media.current === recorder) media.current = null;
        if (discarded.current) { transition("idle"); return; }
        const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || "audio/webm" });
        if (!blob.size) { setNotice("No audio was captured. Try recording again."); transition("idle"); return; }
        setRecording(blob); void transcribe(blob);
      };
      recorder.start(1000); transition("recording");
      const started = Date.now();
      timer.current = setInterval(() => {
        const seconds = Math.floor((Date.now() - started) / 1000); setElapsed(seconds);
        if (seconds >= MAX_RECORDING_SECONDS && recorder.state !== "inactive") { recorder.stop(); releaseMic(); }
      }, 500);
    } catch (e) {
      if (generation.current !== run) return;
      releaseMic(); transition("idle");
      const name = e instanceof DOMException ? e.name : "";
      setError(name === "NotAllowedError" ? "Microphone permission was denied. Allow it in your browser settings, then try again."
        : name === "NotFoundError" ? "No microphone was found. Connect one, then try again." : message(e));
    }
  }
  const stopRecording = () => { if (media.current?.state === "recording") { media.current.stop(); releaseMic(); } };
  async function playAudio() {
    const player = playback.current; if (!player) return;
    setError(""); transition("preparing");
    const run = generation.current;
    try { await player.play(); }
    catch (e) { if (generation.current === run) { transition("idle"); setError("Audio could not start. Select Play audio to try again."); } }
  }
  async function speak() {
    if (!reply || active.current !== "idle" || disabled) return;
    if (reply.text.length > MAX_SPOKEN_TEXT) { setError("This reply is too long to read aloud. Ask for a shorter summary."); return; }
    const run = ++generation.current; const controller = new AbortController(); request.current = controller;
    releaseAudio(); setPlayable(false); setError(""); setNotice(""); transition("preparing");
    try {
      const result = await api<VoicePlayback>(`/bots/${encodeURIComponent(botId)}/voice/speak`, { method: "POST", body: JSON.stringify({ messageId: reply.id }), signal: controller.signal });
      if (generation.current !== run) return;
      if (!/^\/api\/voice\/audio\/[0-9a-f-]{36}$/.test(result.url)) throw new Error("The app returned an invalid audio link.");
      const response = await fetch(result.url, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
      if (!response.ok) throw new Error("This audio reply expired. Select Listen to reply to prepare it again.");
      const blob = await response.blob();
      if (generation.current !== run) return;
      if (!blob.size || blob.size > MAX_VOICE_BYTES) throw new Error("The spoken reply could not be loaded.");
      audioURL.current = URL.createObjectURL(blob);
      const player = new Audio(audioURL.current); playback.current = player; setPlayable(true);
      player.onplaying = () => { if (generation.current === run) transition("speaking"); };
      player.onended = () => { if (generation.current === run) transition("idle"); };
      player.onerror = () => { if (generation.current === run) { transition("idle"); setError("This browser could not play the spoken reply."); setPlayable(false); releaseAudio(); } };
      await playAudio();
    } catch (e) {
      if (generation.current === run && !controller.signal.aborted) { transition("idle"); setError(message(e)); }
    } finally { if (generation.current === run) request.current = null; }
  }
  const busy = state !== "idle";
  const supported = typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined";
  return <div className="voice-controls" data-voice-state={state}>
    <div className="voice-actions">
      {state === "recording" ? <button type="button" className="voice-recording" onClick={stopRecording}>Stop recording · {elapsed}s</button>
        : <button type="button" aria-label="Record voice" disabled={disabled || busy || !supported} title={!supported ? "Microphone recording is unavailable in this browser. You can still type." : "Record up to two minutes. Review the transcript before sending."} onClick={() => void startRecording()}><Icon name="mic" size={18} /><span className="tool-label">Record voice</span></button>}
      {reply && <button type="button" aria-label="Listen to reply" title="Listen to reply" disabled={disabled || busy} onClick={() => void speak()}><Icon name="speaker" size={18} /><span className="tool-label">Listen to reply</span></button>}
      {busy && <button type="button" onClick={cancel}>{state === "speaking" ? "Stop speaking" : "Cancel voice"}</button>}
      {recording && !busy && <><button type="button" disabled={disabled} onClick={() => void transcribe(recording)}>Retry transcription</button><button type="button" onClick={() => { setRecording(null); setError(""); }}>Discard recording</button></>}
      {playable && !busy && <button type="button" disabled={disabled} onClick={() => void playAudio()}>Play audio</button>}
    </div>
    {(busy || notice) && <p className="voice-status" role="status">{busy ? labels[state] : notice}</p>}
    {!supported && <p className="voice-status">Voice recording is unavailable in this browser. You can still type.</p>}
    {error && <p className="voice-error" role="alert">{error}</p>}
  </div>;
}
