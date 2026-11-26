import { useId, useRef, useState } from "react";
import { api, request } from "../client-api";
import { buildBrainDumpPrompt, MAX_BRAIN_DUMP_TEXT } from "../shared/brain-dump";
import type { Bot } from "../shared/types";
import type { VoiceTranscript } from "../shared/voice";
import { Icon } from "./Icon";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { FormMessage } from "./ui/form-message";
import { Textarea } from "./ui/textarea";

export function BrainDumpDialog({
  main,
  voiceSupported,
  onClose,
  onSubmitted,
}: {
  main: Bot;
  voiceSupported: boolean;
  onClose: () => void;
  onSubmitted: (botId: string) => void;
}) {
  const titleId = useId();
  const fieldId = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function toggleRecord() {
    if (recording && recorderRef.current) {
      recorderRef.current.stop();
      setRecording(false);
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Voice recording is not available in this browser.");
      return;
    }
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (!blob.size) return;
        setTranscribing(true);
        const form = new FormData();
        form.append("audio", blob, "recording");
        void api<VoiceTranscript>(`/bots/${encodeURIComponent(main.id)}/voice/transcribe`, {
          method: "POST",
          body: form,
        })
          .then((result) => {
            if (result.text.trim()) {
              setText((current) =>
                current.trim() ? `${current.trim()}\n\n${result.text.trim()}` : result.text.trim(),
              );
            }
          })
          .catch((err: unknown) =>
            setError(err instanceof Error ? err.message : "Could not transcribe voice note."),
          )
          .finally(() => setTranscribing(false));
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Microphone access was denied.");
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    try {
      await request("POST /bots/:id/messages", {
        params: { id: main.id },
        body: {
          requestId: crypto.randomUUID(),
          text: buildBrainDumpPrompt(trimmed),
          attachments: [],
        },
      });
      onSubmitted(main.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send brain dump.");
      setBusy(false);
    }
  }

  return (
    <Dialog
      className="settings-sheet brain-dump-dialog"
      aria-labelledby={titleId}
      initialFocus={`#${CSS.escape(fieldId)}`}
      onCancel={onClose}
      onClose={onClose}
    >
      <header className="sheet-header">
        <h2 id={titleId}>Brain dump to {main.name}</h2>
        <Button className="sheet-close" aria-label="Close brain dump" onClick={onClose}>
          <Icon name="close" />
        </Button>
      </header>
      <form className="sheet-body brain-dump-form" onSubmit={(event) => void submit(event)}>
        <p className="muted">
          Drop messy thoughts, errands, emails to send, or follow-ups. {main.name} will split them
          into tracked tasks, specialist hand-offs, and ready-to-review cards.
        </p>
        <label htmlFor={fieldId} className="sr-only">
          Brain dump notes
        </label>
        <Textarea
          id={fieldId}
          rows={6}
          maxLength={MAX_BRAIN_DUMP_TEXT}
          value={text}
          placeholder="Reply to Sarah about Thursday, schedule the vet checkup, compare solar quotes…"
          onChange={(event) => setText(event.target.value)}
        />
        {error && <FormMessage tone="error">{error}</FormMessage>}
        <div className="brain-dump-actions">
          {voiceSupported && (
            <Button disabled={busy || transcribing} onClick={() => void toggleRecord()}>
              <Icon name={recording ? "stop" : "mic"} size={16} />{" "}
              {recording ? "Stop recording" : transcribing ? "Transcribing…" : "Dictate"}
            </Button>
          )}
          <Button type="submit" className="primary" disabled={busy || !text.trim()}>
            <Icon name="sparkle" size={16} /> {busy ? "Sending…" : `Triage with ${main.name}`}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
