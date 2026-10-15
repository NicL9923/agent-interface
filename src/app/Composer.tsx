import { isConversationReply } from "../shared/message-origin";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ActivityState, Bootstrap, Bot, SubmissionReceipt } from "../shared/types";
import type { VoiceState } from "../shared/voice";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { VoiceControls } from "../components/VoiceControls";
import { ComposerModelPicker } from "../components/ComposerModelPicker";
import { write } from "../client-api";
import { MAX_ATTACHMENTS, namePastedFile, pastedFiles, prepareUpload, UPLOAD_ACCEPT } from "../shared/uploads";
import { AttachmentTray, DropOverlay } from "./AttachmentTray";
import type { Draft, LocalUpload, Pending, SavedConversation } from "./storage";
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
// The whole conversation accepts dropped files. Drops elsewhere are refused so the browser never navigates away to the file.
function useFileDrop(footer: React.RefObject<HTMLElement | null>, onDrop: (files: File[]) => void) {
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const [over, setOver] = useState(false);
  const dropped = useRef(onDrop);
  dropped.current = onDrop;
  useEffect(() => {
    const target = footer.current?.closest<HTMLElement>(".conversation-panel") ?? null;
    setPanel(target);
    if (!target) return;
    let depth = 0;
    const carriesFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes("Files");
    const enter = (event: DragEvent) => { if (!carriesFiles(event)) return; depth++; setOver(true); };
    const leave = (event: DragEvent) => { if (carriesFiles(event) && --depth <= 0) { depth = 0; setOver(false); } };
    const overPanel = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setOver(false);
      dropped.current(Array.from(event.dataTransfer!.files));
    };
    const refuse = (event: DragEvent) => {
      if (!carriesFiles(event) || target.contains(event.target as Node)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    };
    const reset = () => { depth = 0; setOver(false); };
    target.addEventListener("dragenter", enter);
    target.addEventListener("dragleave", leave);
    target.addEventListener("dragover", overPanel);
    target.addEventListener("drop", drop);
    window.addEventListener("dragover", refuse);
    window.addEventListener("drop", refuse);
    window.addEventListener("dragend", reset);
    return () => {
      target.removeEventListener("dragenter", enter);
      target.removeEventListener("dragleave", leave);
      target.removeEventListener("dragover", overPanel);
      target.removeEventListener("drop", drop);
      window.removeEventListener("dragover", refuse);
      window.removeEventListener("drop", refuse);
      window.removeEventListener("dragend", reset);
    };
  }, [footer]);
  return { panel, over };
}
export function Composer({ boot, selected, botId, conversation, state, active, connectionLost, draft, setDraft, draftReady, uploads, previews, uploading, upload, retryUpload, cancelUpload, pending, receipt, sending, send, retry, reviewed, setReviewed, refresh, report }: {
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
  uploads: LocalUpload[];
  previews: Record<string, { url: string }>;
  uploading: boolean;
  upload(files: File[], botId: string): void;
  retryUpload(id: string): void;
  cancelUpload(id: string): void;
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
  // An in-flight send keeps its spinning Send button even if the draft is cleared meanwhile.
  const stopVisible = active && !sending && !draft.text.trim() && !draft.attachments.length;
  const input = useComposerInput(draft.text, botId);
  const advanced = boot.preferences.presentation === "advanced";
  const fileInput = useRef<HTMLInputElement>(null);
  const slots = MAX_ATTACHMENTS - draft.attachments.length - uploads.length;
  const attachUnavailable = !boot.capabilities.uploads.supported
    ? boot.capabilities.uploads.reason || "Hermes can't receive files right now."
    : !draftReady || draft.botId !== botId ? "Your draft is still loading."
    : slots <= 0 ? `A message can carry up to ${MAX_ATTACHMENTS} attachments.` : undefined;
  const submitting = sending || pending !== null;
  const [attachNotice, setAttachNotice] = useState<string[]>([]);
  const addFiles = (files: File[]) => {
    if (!files.length) return;
    if (attachUnavailable) return setAttachNotice([attachUnavailable]);
    const problems: string[] = [];
    const accepted: File[] = [];
    for (const file of files) {
      const prepared = prepareUpload(file);
      if ("error" in prepared) problems.push(prepared.error);
      else accepted.push(prepared.file);
    }
    if (accepted.length > slots)
      problems.push(`A message can carry up to ${MAX_ATTACHMENTS} attachments, so ${accepted.length - slots} of these ${accepted.length - slots === 1 ? "wasn't" : "weren't"} added.`);
    setAttachNotice(problems);
    upload(accepted.slice(0, slots), botId);
  };
  const footer = useRef<HTMLElement>(null);
  const drop = useFileDrop(footer, addFiles);
  return (
    <footer className="composer-area" ref={footer}>
      {drop.over && drop.panel && createPortal(<DropOverlay botName={selected.name} unavailable={attachUnavailable} />, drop.panel)}
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
      {/* A normal send only spins the send button. This appears once the request ended without a receipt. */}
      {pending && !sending && (
        <div className="notice" role="status">
          Checking whether your last message arrived…
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
        {!!attachNotice.length && <div className="attachment-notice" role="alert">
          <Icon name="alert" size={15} />
          <div>{attachNotice.map(problem => <p key={problem}>{problem}</p>)}</div>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setAttachNotice([])}><Icon name="close" size={14} /></button>
        </div>}
        <AttachmentTray attachments={draft.botId === botId ? draft.attachments : []} uploads={uploads} previews={previews}
          canOpen={boot.capabilities.generatedFiles.supported}
          onRemove={id => setDraft(previous => ({ ...previous, dirty: true, attachments: previous.attachments.filter(file => file.id !== id) }))}
          onCancel={cancelUpload} onRetry={retryUpload} />
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
          onPaste={(event) => {
            const files = event.clipboardData ? pastedFiles(event.clipboardData) : [];
            if (!files.length) return;
            event.preventDefault();
            const at = new Date();
            addFiles(files.map((file, index) => namePastedFile(file, at, index)));
          }}
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
          {/* A real button opens a hidden picker. An invisible file input overlay
              won iOS touch adjustment for taps meant for the model button beside it. */}
          <button
            type="button"
            className="composer-tool"
            aria-label="Attach images, PDFs, or text"
            title={attachUnavailable || "Attach images, PDFs, or text. You can also paste or drop them here."}
            disabled={!!attachUnavailable}
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="attach" size={18} />
          </button>
          <input
            ref={fileInput}
            hidden
            type="file"
            accept={UPLOAD_ACCEPT}
            multiple
            disabled={!!attachUnavailable}
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          {advanced && <ComposerModelPicker bot={selected} bootstrap={boot}
            disabled={connectionLost || sending} onSaved={refresh} />}
          <div className="composer-voice">
            {voiceState !== "idle" && <span className={`voice-avatar voice-${voiceState}`}><Avatar avatar={selected.avatar} state="idle" size={24} name={selected.name} reducedMotion /></span>}
            <VoiceControls key={`${boot.user.id}:${botId}`} botId={botId}
              reply={!active ? conversation?.messages.findLast(isConversationReply) : undefined}
              disabled={!draftReady || draft.botId !== botId || pending !== null || sending || connectionLost}
              onStateChange={setVoiceState} onTranscript={(text) => setDraft(previous => ({ ...previous, dirty: true,
                text: previous.text.trim() ? `${previous.text}\n${text}` : text }))} />
          </div>
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
            aria-busy={submitting}
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
            <Icon name={submitting ? "spinner" : "send"} className={submitting ? "spin" : undefined} size={19} />
          </button>}
        </div>
      </form>
    </footer>
  );
}
