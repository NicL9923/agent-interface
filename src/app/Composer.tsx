import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ActivityState, Bootstrap, Bot, SubmissionReceipt } from "../shared/types";
import type { VoiceState } from "../shared/voice";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { VoiceControls } from "../components/VoiceControls";
import { ComposerModelPicker } from "../components/ComposerModelPicker";
import { write } from "../client-api";
import type { Draft, Pending, SavedConversation } from "./storage";
// Fits on mount too, so a restored multi-line draft is sized when returning from another view.
function useComposerInput(text: string, botId: string) {
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const fitComposer = useCallback(() => {
    // Grow the composer with its draft up to the CSS max-height, then scroll.
    const input = composerInput.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, []);
  useLayoutEffect(fitComposer, [text, botId, fitComposer]);
  const ref = useCallback((input: HTMLTextAreaElement | null) => {
    composerInput.current = input;
    if (!input || typeof ResizeObserver === "undefined") return;
    // Rotation or a narrower window rewraps the same draft.
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      fitComposer();
    });
    observer.observe(input);
    return () => {
      observer.disconnect();
      composerInput.current = null;
    };
  }, [fitComposer]);
  return { ref };
}
export function Composer({ boot, selected, botId, conversation, state, active, connectionLost, draft, setDraft, draftReady, uploading, upload, pending, receipt, sending, send, retry, reviewed, setReviewed, refresh, report }: {
  boot: Bootstrap;
  selected: Bot;
  botId: string;
  conversation: SavedConversation | null;
  state: ActivityState;
  active: boolean;
  connectionLost: boolean;
  draft: Draft;
  setDraft(update: (current: Draft) => Draft): void;
  draftReady: boolean;
  uploading: boolean;
  upload(files: FileList | null): Promise<void>;
  pending: Pending | null;
  receipt: SubmissionReceipt | null;
  sending: boolean;
  send(): Promise<void>;
  retry(): void;
  reviewed: boolean;
  setReviewed(value: boolean): void;
  refresh(): void;
  report(message: string): void;
}) {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [stopping, setStopping] = useState(false);
  const stopVisible = active && !draft.text.trim() && !draft.attachments.length;
  const input = useComposerInput(draft.text, botId);
  const advanced = boot.preferences.presentation === "advanced";
  return (
    <footer className="composer-area">
      {state === "interrupted" && (
        <label className="interruption-review">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(event) => setReviewed(event.target.checked)}
          />{" "}
          I reviewed the interrupted task and its last actions before
          continuing.
        </label>
      )}
      {pending && (
        <div className="notice" role="status">
          <Icon name="spinner" className="spin" size={16} /> Sending…
          <button
            disabled={sending || !boot.capabilities.idempotency.supported}
            title={boot.capabilities.idempotency.reason}
            onClick={retry}
          >
            Retry this saved message
          </button>
        </div>
      )}
      {receipt?.status === "rejected" && (
        <div className="notice attention" role="alert">
          {receipt.message || "Hermes did not accept this message. Your draft is saved."}
        </div>
      )}
      {receipt?.status === "interrupted" && (
        <div className="notice attention">
          This submission was interrupted. Review its last actions before
          trying again.
        </div>
      )}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="attachment-list">
          {draft.attachments.map((file) => (
            <span key={file.id}>
              {file.name}
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() =>
                  setDraft((previous) => ({
                    ...previous,
                    dirty: true,
                    attachments: previous.attachments.filter(
                      (f) => f.id !== file.id,
                    ),
                  }))
                }
              >
                <Icon name="close" size={14} />
              </button>
            </span>
          ))}
        </div>
        <label className="sr-only" htmlFor="message">
          Message {selected.name}
        </label>
        <textarea
          ref={input.ref}
          id="message"
          value={draft.botId === botId ? draft.text : ""}
          placeholder={
            active
              ? `Guide ${selected.name} while they work…`
              : `Message ${selected.name}…`
          }
          onChange={(event) =>
            setDraft((previous) => ({
              ...previous,
              dirty: true,
              text: event.target.value,
            }))
          }
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (
                !(
                  pending ||
                  sending ||
                  uploading ||
                  connectionLost ||
                  !boot.capabilities.chat.supported ||
                  (state === "interrupted" && !reviewed) ||
                  (active && !boot.capabilities.steering.supported)
                ) &&
                (draft.text.trim() || draft.attachments.length)
              )
                void send();
            }
          }}
          rows={2}
          disabled={!draftReady || draft.botId !== botId}
        />
        <div className="composer-tools">
          <label
            className={`attach-control ${!boot.capabilities.uploads.supported ? "disabled" : ""}`}
            title={boot.capabilities.uploads.reason}
          >
            <Icon name="attach" size={18} />
            <span className="tool-label">Attach</span>
            <input
              aria-label="Attach images, PDFs, or text"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain"
              multiple
              disabled={
                !draftReady ||
                !boot.capabilities.uploads.supported ||
                uploading ||
                draft.attachments.length >= 10
              }
              onChange={(event) => {
                void upload(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
          {advanced && <ComposerModelPicker bot={selected} bootstrap={boot}
            disabled={connectionLost || sending} onSaved={refresh} />}
          <div className="composer-voice">
            {voiceState !== "idle" && <span className={`voice-avatar voice-${voiceState}`}><Avatar avatar={selected.avatar} state="idle" size={24} name={selected.name} /></span>}
            <VoiceControls key={`${boot.user.id}:${botId}`} botId={botId}
              reply={!active ? conversation?.messages.findLast(message => message.role === "assistant") : undefined}
              disabled={!draftReady || draft.botId !== botId || pending !== null || sending || connectionLost}
              onStateChange={setVoiceState} onTranscript={(text) => setDraft(previous => ({ ...previous, dirty: true,
                text: previous.text.trim() ? `${previous.text}\n${text}` : text }))} />
          </div>
          {uploading && <span className="composer-hint" role="status">Uploading…</span>}
          {stopVisible ? <button type="button" className="send-button" aria-label="Stop response"
            disabled={stopping || connectionLost || !boot.capabilities.stop.supported}
            title={boot.capabilities.stop.reason || "Stop response"}
            onClick={() => {
              setStopping(true);
              void write(`/bots/${encodeURIComponent(botId)}/stop`, {})
                .catch(error => { if (mounted.current) report(error.message); })
                .finally(() => { if (mounted.current) setStopping(false); });
            }}>
            <Icon name={stopping ? "spinner" : "stop"} className={stopping ? "spin" : undefined} size={19} />
          </button> : <button
            className="send-button"
            aria-label={active ? "Send guidance" : "Send message"}
            disabled={
              !draftReady ||
              pending !== null ||
              sending ||
              uploading ||
              connectionLost ||
              !boot.capabilities.chat.supported ||
              (active && !boot.capabilities.steering.supported) ||
              (state === "interrupted" && !reviewed) ||
              (!draft.text.trim() && !draft.attachments.length)
            }
          >
            <Icon name={sending ? "spinner" : "send"} className={sending ? "spin" : undefined} size={19} />
          </button>}
        </div>
      </form>
    </footer>
  );
}
