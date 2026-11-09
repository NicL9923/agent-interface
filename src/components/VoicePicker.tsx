import { useEffect, useId, useRef, useState } from "react";
import { request } from "../client-api";
import type { Capability } from "../shared/types";
import { DEFAULT_TALK_VOICE, STOP_SPEECH, TALK_VOICES, type TalkVoice } from "../shared/voice";
import { Icon } from "./Icon";
import "./voice-picker.css";

const title = (voice: string) => voice[0]!.toUpperCase() + voice.slice(1);

/** One preview at a time, released when the picker closes. */
function usePreview() {
  const [playing, setPlaying] = useState<TalkVoice | null>(null);
  const [failed, setFailed] = useState<TalkVoice | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const stop = () => {
    const current = audio.current; audio.current = null;
    if (current) { current.onended = current.onerror = null; current.pause(); current.removeAttribute("src"); current.load?.(); }
    setPlaying(null);
  };
  useEffect(() => stop, []);
  const toggle = (voice: TalkVoice) => {
    const same = playing === voice;
    stop(); setFailed(null);
    if (same) return;
    // A reply being read aloud would play over the preview.
    window.dispatchEvent(new Event(STOP_SPEECH));
    const next = new Audio(`/voice-previews/${voice}.m4a`);
    audio.current = next;
    next.onended = () => { if (audio.current === next) { audio.current = null; setPlaying(null); } };
    next.onerror = () => { if (audio.current === next) { stop(); setFailed(voice); } };
    setPlaying(voice);
    void next.play().catch(() => { if (audio.current === next) { stop(); setFailed(voice); } });
  };
  return { playing, failed, toggle };
}

/** The voice an assistant speaks with in live Talk. Choosing one saves it; each has a short sample. */
export function VoicePicker({ botId, name, voice, liveVoice, onSaved }: {
  botId: string; name: string; voice?: TalkVoice; liveVoice?: Capability; onSaved(voice: TalkVoice): void;
}) {
  const [chosen, setChosen] = useState<TalkVoice>(voice ?? DEFAULT_TALK_VOICE);
  const [saving, setSaving] = useState<TalkVoice | null>(null);
  const [error, setError] = useState("");
  const preview = usePreview();
  const group = useId();
  useEffect(() => { if (!saving) setChosen(voice ?? DEFAULT_TALK_VOICE); }, [voice]);
  const choose = async (next: TalkVoice) => {
    if (next === chosen || saving) return;
    const previous = chosen;
    setChosen(next); setSaving(next); setError("");
    try {
      await request("PUT /bots/:id/voice", { params: { id: botId }, body: { voice: next } });
      onSaved(next);
    } catch (cause) {
      setChosen(previous);
      setError(`${title(next)} wasn't saved: ${cause instanceof Error ? cause.message : "try again."}`);
    } finally { setSaving(null); }
  };
  return <section className="voice-picker" aria-labelledby={`${group}-title`}>
    <h3 id={`${group}-title`}>Voice for live Talk</h3>
    <p className="muted">How {name} sounds when you talk with it out loud. Choosing a voice saves it for everyone in the household.</p>
    {liveVoice && !liveVoice.supported && <p className="capability-note">Live Talk isn't available yet. {liveVoice.reason}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="voice-options" role="radiogroup" aria-labelledby={`${group}-title`}>
      {TALK_VOICES.map(option => {
        const selected = chosen === option, playing = preview.playing === option;
        return <div key={option} className="voice-option" data-selected={selected || undefined}>
          <label>
            <input type="radio" name={`${group}-voice`} value={option} checked={selected} disabled={!!saving}
              onChange={() => void choose(option)} />
            <span className="voice-name">{title(option)}</span>
            {option === DEFAULT_TALK_VOICE && <span className="voice-tag">Default</span>}
            {saving === option && <span className="voice-tag" role="status">Saving…</span>}
          </label>
          <button type="button" className="voice-preview" aria-pressed={playing}
            aria-label={playing ? `Stop ${title(option)} sample` : `Play ${title(option)} sample`} onClick={() => preview.toggle(option)}>
            <Icon name={playing ? "stop" : "play"} size={14} />
          </button>
          {preview.failed === option && <p className="voice-failed" role="alert">This sample could not play.</p>}
        </div>;
      })}
    </div>
  </section>;
}
