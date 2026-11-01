import { Avatar } from "./Avatar";
import type { Avatar as AvatarConfig } from "../shared/types";
import { useEffect, useRef, useState } from "react";
import { api } from "../client-api.js";
import { Icon } from "./Icon.js";
import { MAX_RECORDING_SECONDS, MAX_VOICE_BYTES, STOP_SPEECH } from "../shared/voice.js";
import type { VoiceState, VoiceTranscript } from "../shared/voice.js";
import "./voice-controls.css";

export interface VoiceControlsProps {
  avatar?: AvatarConfig;
  name?: string;
  botId: string;
  disabled?: boolean;
  onTranscript(text: string): void;
  onStateChange?(state: VoiceState): void;
}
const labels: Record<VoiceState, string> = { idle: "", requesting: "Waiting for microphone permission…", recording: "Recording", transcribing: "Transcribing…" };
const message = (error: unknown) => error instanceof Error ? error.message : "Voice could not be completed. Your draft is kept.";

export function VoiceControls({ botId, disabled = false, onTranscript, onStateChange, avatar, name }: VoiceControlsProps) {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recording, setRecording] = useState<Blob | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const callbacks = useRef({ onTranscript, onStateChange }); callbacks.current = { onTranscript, onStateChange };
  const media = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
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
  const cancel = () => {
    generation.current++; discarded.current = true;
    request.current?.abort(); request.current = null;
    if (media.current?.state !== "inactive") media.current?.stop(); media.current = null;
    releaseMic(); transition("idle");
  };
  useEffect(() => {
    return () => {
      generation.current++; discarded.current = true; request.current?.abort();
      if (media.current?.state !== "inactive") media.current?.stop(); media.current = null;
      releaseMic(); callbacks.current.onStateChange?.("idle");
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
    // Speech from a reply must not end up in the recording.
    window.dispatchEvent(new Event(STOP_SPEECH));
    setError(""); setNotice(""); setElapsed(0); transition("requesting");
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
  const busy = state !== "idle";
  const supported = typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined";
  return <div className="voice-controls" data-voice-state={state}>
    <div className="voice-actions">
      {state === "recording" ? <button type="button" className="voice-recording" aria-label={`Stop recording, ${elapsed} seconds`} onClick={stopRecording}><span className="sr-only">Stop recording · </span><Icon name="stop" size={16} /><span>{elapsed}s</span></button>
        : <button type="button" aria-label="Record voice" disabled={disabled || busy} title={!supported ? "Microphone recording is unavailable in this browser. You can still type." : "Record up to two minutes. Review the transcript before sending."} onClick={() => void startRecording()}><Icon name="mic" size={18} /><span className="tool-label">Record voice</span></button>}
    </div>
    <div className="voice-panel">
      {busy && <span className={`voice-avatar voice-${state}`}><Avatar avatar={avatar} name={name} state="idle" size={24} reducedMotion /></span>}
      {busy && <button type="button" onClick={cancel}>Cancel voice</button>}
      {recording && !busy && <><button type="button" disabled={disabled} onClick={() => void transcribe(recording)}>Retry transcription</button><button type="button" onClick={() => { setRecording(null); setError(""); }}>Discard recording</button></>}
    {(busy || notice) && <p className="voice-status" role="status">{busy ? labels[state] : notice}</p>}
    {error && <p className="voice-error" role="alert">{error}</p>}
    </div>
  </div>;
}
