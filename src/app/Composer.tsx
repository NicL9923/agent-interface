import { isConversationReply } from "../shared/message-origin";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ActivityState, Bootstrap, Bot, SubmissionReceipt } from "../shared/types";
import type { VoiceState } from "../shared/voice";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { VoiceControls } from "../components/VoiceControls";
import { ComposerModelPicker, Loading } from "./panels";
import { Button } from "../components/ui/button";
import { request } from "../client-api";
import { MAX_ATTACHMENTS, namePastedFile, pastedFiles, prepareUpload, UPLOAD_ACCEPT } from "../shared/uploads";
import { AttachmentTray, DropOverlay } from "./AttachmentTray";
import type { Draft, LocalUpload, Pending, SavedConversation } from "./storage";
import { sendingDraft } from "./sent-echo";
import { StatusDock, type DockItem } from "./StatusDock";
import { ownPrompts, recallStep, type Recall } from "./prompt-recall";
import { largePasteFile } from "./large-paste";
import { formatBytes } from "../shared/uploads";

/** Stops the open assistant's current response. The composer's Stop button and Cmd+. share it. */
export function useStopResponse(botId: string, report: (message: string) => void) {
  const [stopping, setStopping] = useState(false);
  // A late answer belongs to the assistant it stopped, so it is dropped once another one is open.
  const shown = useRef<string | null>(botId);
  useEffect(() => { shown.current = botId; return () => { shown.current = null; }; }, [botId]);
  useEffect(() => setStopping(false), [botId]);
  const stop = useCallback(() => {
    const target = botId;
    setStopping(true);
    void request("POST /bots/:id/stop", { params: { id: target } })
      .catch(error => { if (shown.current === target) report(error.message); })
      .finally(() => { if (shown.current === target) setStopping(false); });
  }, [botId, report]);
  return { stopping, stop };
}

function ModelPickerPlaceholder({ model, failed = false }: { model: string; failed?: boolean }) {
  const description = failed ? "Model controls unavailable. Reload to try again." : "Loading model controls";
  return <div className="composer-model" role={failed ? "status" : undefined}>
    <Button className="composer-tool" disabled aria-label={description} title={description}>
      <Icon name="robot" size={18} /><span className="tool-label composer-model-name">{model}</span>
    </Button>
  </div>;
}
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
export function Composer({ boot, selected, botId, conversation, state, active, connectionLost, draft, setDraft, draftReady, uploads, previews, uploading, upload, retryUpload, cancelUpload, pending, receipt, sending, send, retry, discard, reviewed, setReviewed, refresh, dock = [], stopping, onStop }: {
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
  /** Gives up on an unconfirmed send and puts its text back in the draft. */
  discard(): void;
  reviewed: boolean;
  setReviewed(value: boolean): void;
  refresh(): void;
  /** Notices from the rest of the app for the dock above the composer: connection, decisions, update. */
  dock?: DockItem[];
  stopping: boolean;
  onStop(): void;
}) {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  // An in-flight send keeps its spinning Send button even if the draft is cleared meanwhile.
  const stopVisible = active && !sending && !draft.text.trim() && !draft.attachments.length;
  // The transcript shows a message on its way, so the composer reads empty until Hermes answers.
  // The draft itself keeps the message until then, and is read-only so it stays the sent copy.
  const handedOff = sendingDraft(draft, pending, sending);
  const shown = draft.botId === botId && !handedOff ? draft : { text: "", attachments: [] };
  const input = useComposerInput(shown.text, botId);
  const advanced = boot.preferences.presentation === "advanced";
  const fileInput = useRef<HTMLInputElement>(null);
  const slots = MAX_ATTACHMENTS - draft.attachments.length - uploads.length;
  const attachUnavailable = !boot.capabilities.uploads.supported
    ? boot.capabilities.uploads.reason || "Hermes can't receive files right now."
    : !draftReady || draft.botId !== botId ? "Your draft is still loading."
    : sending ? "Wait a moment for your message to send."
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
  // Up and Down in an empty composer browse this person's earlier messages here, newest first.
  const [recall, setRecall] = useState<Recall>(null);
  const prompts = useMemo(() => ownPrompts(conversation?.botId === botId ? conversation.messages : undefined, boot.user.id),
    [conversation, botId, boot.user.id]);
  const caret = useRef<"start" | "end" | null>(null);
  // An edit from elsewhere, such as another device or a send, ends browsing.
  useEffect(() => { if (recall && shown.text !== prompts[recall.index]) setRecall(null); }, [recall, shown.text, prompts]);
  useLayoutEffect(() => {
    const field = document.getElementById("message") as HTMLTextAreaElement | null;
    if (!caret.current || !field) return;
    const at = caret.current === "start" ? 0 : field.value.length;
    field.setSelectionRange(at, at);
    caret.current = null;
  }, [shown.text]);
  const recallTo = (text: string, next: Recall, at: "start" | "end") => {
    caret.current = at;
    setRecall(next);
    setDraft(previous => ({ ...previous, dirty: true, text }));
  };
  const [pasteStatus, setPasteStatus] = useState("");
  useEffect(() => {
    if (!pasteStatus) return;
    const timer = setTimeout(() => setPasteStatus(""), 8000);
    return () => clearTimeout(timer);
  }, [pasteStatus]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  useEffect(() => { if (!pending || sending) setConfirmDiscard(false); }, [pending, sending]);
  const notices: DockItem[] = [...dock];
  // A normal send only spins the send button. This appears once the request ended without a receipt.
  if (pending && !sending) notices.push({ id: "send-uncertain", kind: "send", node: <div className="notice" role="status">
    {confirmDiscard
      ? <span>The message may still arrive. Its text goes back into the draft, so sending it again could deliver it twice.</span>
      : <span>Checking whether your last message arrived…</span>}
    <span className="notice-actions">
      {confirmDiscard ? <>
        <button type="button" className="danger" onClick={() => { setConfirmDiscard(false); discard(); }}>Discard and keep my text in the draft</button>
        <button type="button" onClick={() => setConfirmDiscard(false)}>Cancel</button>
      </> : <>
        <button type="button" disabled={sending || !boot.capabilities.idempotency.supported} title={boot.capabilities.idempotency.reason} onClick={retry}>
          Retry this saved message
        </button>
        <button type="button" onClick={() => setConfirmDiscard(true)}>Discard</button>
      </>}
    </span>
  </div> });
  if (receipt?.status === "rejected") notices.push({ id: "send-rejected", kind: "send", node: <div className="notice attention" role="alert">
    {receipt.message || "Hermes did not accept this message. Your draft is saved."}
  </div> });
  if (receipt?.status === "interrupted") notices.push({ id: "send-interrupted", kind: "send", node: <div className="notice attention">
    This submission was interrupted. Review its last actions before trying again.
  </div> });
  if (state === "interrupted") notices.push({ id: "interrupted", kind: "interrupted", node: <label className="interruption-review">
    <input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />{" "}
    I've reviewed the task's last actions.
  </label> });
  return (
    <footer className="composer-area" ref={footer}>
      {drop.over && drop.panel && createPortal(<DropOverlay botName={selected.name} unavailable={attachUnavailable} />, drop.panel)}
      <StatusDock items={notices} />
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
        <p id="composer-paste-status" className="composer-status" role="status">{pasteStatus}</p>
        <AttachmentTray attachments={shown.attachments} uploads={uploads} previews={previews}
          canOpen={boot.capabilities.generatedFiles.supported}
          onRemove={id => setDraft(previous => ({ ...previous, dirty: true, attachments: previous.attachments.filter(file => file.id !== id) }))}
          onCancel={cancelUpload} onRetry={retryUpload} />
        <label className="sr-only" htmlFor="message">
          Message {selected.name}
        </label>
        <textarea
          ref={input.ref}
          id="message"
          value={shown.text}
          placeholder={
            handedOff ? "Sending…"
              : active
              ? `Guide ${selected.name} while they work…`
              : `Message ${selected.name}…`
          }
          aria-describedby={pasteStatus ? "composer-paste-status" : undefined}
          // Read-only rather than disabled, so focus stays here for the next message.
          readOnly={handedOff}
          onChange={(event) => {
            setRecall(null);
            setPasteStatus("");
            setDraft((previous) => ({
              ...previous,
              dirty: true,
              text: event.target.value,
            }));
          }}
          onPaste={(event) => {
            const files = event.clipboardData ? pastedFiles(event.clipboardData) : [];
            if (files.length) {
              event.preventDefault();
              const at = new Date();
              addFiles(files.map((file, index) => namePastedFile(file, at, index)));
              return;
            }
            // A very long paste travels as a text file; when files cannot attach now, it inserts as before.
            const pasted = largePasteFile(event.clipboardData?.getData("text/plain") ?? "");
            if (!pasted || attachUnavailable) return;
            event.preventDefault();
            addFiles([pasted]);
            setPasteStatus(`Your paste was long, so it is attached as ${pasted.name} (${formatBytes(pasted.size)}).`);
          }}
          onKeyDown={(event) => {
            if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
              && !event.nativeEvent.isComposing && !submitting && !handedOff) {
              const field = event.currentTarget;
              const collapsed = field.selectionStart === field.selectionEnd;
              const move = recallStep(recall, event.key, prompts, field.value,
                collapsed && field.selectionStart === 0, collapsed && field.selectionEnd === field.value.length);
              if (move) {
                event.preventDefault();
                recallTo(move.text, move.recall, event.key === "ArrowUp" ? "start" : "end");
                return;
              }
            }
            if (event.key === "Escape" && recall) {
              event.preventDefault();
              recallTo(recall.draft, null, "end");
              return;
            }
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
          {advanced && <Loading loadingFallback={<ModelPickerPlaceholder model={selected.model} />}
            errorFallback={<ModelPickerPlaceholder model={selected.model} failed />}><ComposerModelPicker bot={selected} bootstrap={boot}
            disabled={connectionLost || sending} onSaved={refresh} /></Loading>}
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
            onClick={onStop}>
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
