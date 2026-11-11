import { cssSizesField, shouldStackComposer, textWidth, type ComposerSlot } from "./composer-layout";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ActivityState, Bootstrap, Bot, Message, SubmissionReceipt } from "../shared/types";
import type { VoiceState } from "../shared/voice";
import { Icon } from "../components/Icon";
import { VoiceControls } from "../components/VoiceControls";
import { TalkPanel } from "../components/TalkPanel";
import { useTalk } from "./use-talk";
import { request } from "../client-api";
import { MAX_ATTACHMENTS, namePastedFile, pastedFiles, prepareUpload, UPLOAD_ACCEPT } from "../shared/uploads";
import { AttachmentTray, DropOverlay } from "./AttachmentTray";
import type { Draft, LocalUpload, Pending } from "./storage";
import { sendingDraft } from "./sent-echo";
import { StatusDock, type DockItem } from "./StatusDock";
import { ownPrompts, recallStep, type Recall } from "./prompt-recall";
import { largePasteFile } from "./large-paste";
import { formatBytes } from "../shared/uploads";
import { clearDecline, useDeclined } from "./decline-handoff";
import { imeKey } from "./ime";
import { sendsOnKey, useEnterSends } from "./enter-key";
import { CHECKING_CONNECTION, NOT_SENT_CHECKING, WAITING_FOR_CONNECTION } from "./use-conversation";

/**
 * Stops the open assistant's current response. The composer's Stop button and Cmd+. share it. Each names the run the
 * person was shown, so the server stops that run and refuses when it is no longer the one running.
 */
export function useStopResponse(botId: string, report: (message: string) => void) {
  const [stopping, setStopping] = useState(false);
  // A late answer belongs to the assistant it stopped, so it is dropped once another one is open.
  const shown = useRef<string | null>(botId);
  useEffect(() => { shown.current = botId; return () => { shown.current = null; }; }, [botId]);
  useEffect(() => setStopping(false), [botId]);
  const stop = useCallback((runId?: string) => {
    const target = botId;
    setStopping(true);
    void request("POST /bots/:id/stop", { params: { id: target }, body: runId ? { runId } : {} })
      .catch(error => { if (shown.current === target) report(error.message); })
      .finally(() => { if (shown.current === target) setStopping(false); });
  }, [botId, report]);
  return { stopping, stop };
}

/**
 * This person's earlier messages for recall, newest first. The same array comes back while the
 * messages are unchanged, so a streaming reply does not hand the composer a new list on every update.
 */
export function useOwnPrompts(messages: readonly Message[] | undefined, userId: string | undefined) {
  const kept = useRef<string[]>([]);
  const next = ownPrompts(messages, userId ?? "");
  if (next.length !== kept.current.length || next.some((text, index) => text !== kept.current[index])) kept.current = next;
  return kept.current;
}

// Fits on mount too, so a restored multi-line draft is sized when returning from another view.
function useComposerInput(text: string, botId: string, voiceState: VoiceState) {
  const composerInput = useRef<HTMLTextAreaElement>(null);
  // Where CSS grows the field with its text, a keystroke reads no layout at all.
  const [cssSized] = useState(cssSizesField);
  // Changes with the window, the controls beside the field, and the assistant, never with typing.
  const slot = useRef<ComposerSlot | null>(null);
  const fitComposer = useCallback(() => {
    const input = composerInput.current;
    if (!input) return;
    const form = input.closest<HTMLFormElement>("form");
    if (form) {
      const measured = slot.current ??= readSlot(form, input);
      const layout = shouldStackComposer(input.value, measured.available,
        () => textWidth(input.value, measured, form.querySelector<HTMLElement>(".composer-measure"))) ? "stacked" : "inline";
      if (form.dataset.layout !== layout) form.dataset.layout = layout;
    }
    if (cssSized) return;
    // Grow the composer with its draft up to the CSS max-height, then scroll.
    input.style.height = input.value ? "auto" : "";
    if (input.value) input.style.height = `${input.scrollHeight}px`;
  }, [cssSized]);
  const refit = useCallback(() => { slot.current = null; fitComposer(); }, [fitComposer]);
  // Another assistant or a voice state change can resize the controls, so the slot is read again first.
  useLayoutEffect(() => { slot.current = null; }, [botId, voiceState]);
  useLayoutEffect(fitComposer, [text, botId, voiceState, fitComposer]);
  const ref = useCallback((input: HTMLTextAreaElement | null) => {
    composerInput.current = input;
    if (!input || typeof ResizeObserver === "undefined") return;
    // Observe the fixed controls and form, not the textarea width that stacking itself changes.
    const observer = new ResizeObserver(refit);
    const form = input.closest("form");
    if (form) {
      observer.observe(form);
      for (const controls of form.querySelectorAll(".composer-tools, .voice-actions")) observer.observe(controls);
    }
    return () => {
      observer.disconnect();
      composerInput.current = null;
    };
  }, [refit]);
  return { ref };
}
/** The width the inline slot leaves for the field, and the field's font. Reading these forces a layout. */
function readSlot(form: HTMLFormElement, input: HTMLTextAreaElement): ComposerSlot {
  const lead = form.querySelector<HTMLElement>(".composer-tools");
  const voice = form.querySelector<HTMLElement>(".voice-actions");
  const send = form.querySelector<HTMLElement>(".send-button");
  const style = getComputedStyle(input);
  return {
    available: form.clientWidth - 8 - (lead?.offsetWidth ?? 0) - (voice?.offsetWidth ?? 0) - (send?.offsetWidth ?? 44) - 12,
    font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
    letterSpacing: style.letterSpacing,
  };
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
// Memoized with stable callbacks from App, so a streaming reply, which changes the conversation up to ten times a second, does not re-render it.
export const Composer = memo(function Composer({ boot, selected, botId, prompts, state, active, connectionLost, connectionShown, draft, setDraft, draftReady, uploads, previews, uploading, upload, retryUpload, cancelUpload, pending, receipt, sending, send, retry, discard, reviewed, setReviewed, dock = [], stopping, onStop, waiting }: {
  boot: Bootstrap;
  selected: Bot;
  botId: string;
  /** This person's earlier messages in the chat, newest first, for Up and Down recall. */
  prompts: readonly string[];
  state: ActivityState;
  active: boolean;
  /** The placeholder while the assistant waits on a request this person could answer by message. */
  waiting?: string;
  /** A read just failed, or the connection is down: Send, Stop and Talk are refused. */
  connectionLost: boolean;
  /** The chat shows it is disconnected, and the dock's connection notice explains it. */
  connectionShown: boolean;
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
  /** Notices from the rest of the app for the dock above the composer: connection, decisions, update. */
  dock?: DockItem[];
  stopping: boolean;
  onStop(): void;
}) {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const talk = useTalk(botId, selected.name);
  const talking = talk.status !== "idle";
  // An older server reports no liveVoice; its absence hides Talk entirely.
  const liveVoice = boot.capabilities.liveVoice as Bootstrap["capabilities"]["liveVoice"] | undefined;
  // An in-flight send keeps its spinning Send button even if the draft is cleared meanwhile.
  const stopVisible = active && !sending && !draft.text.trim() && !draft.attachments.length;
  // The transcript shows a message on its way, so the composer reads empty until Hermes answers.
  // The draft itself keeps the message until then, and is read-only so it stays the sent copy.
  const handedOff = sendingDraft(draft, pending, sending);
  const shown = draft.botId === botId && !handedOff ? draft : { text: "", attachments: [] };
  const input = useComposerInput(shown.text, botId, voiceState);
  const fileInput = useRef<HTMLInputElement>(null);
  const slots = MAX_ATTACHMENTS - draft.attachments.length - uploads.length;
  const attachUnavailable = !boot.capabilities.uploads.supported
    ? boot.capabilities.uploads.reason || "Hermes can't receive files right now."
    : !draftReady || draft.botId !== botId ? "Your draft is still loading."
    : sending ? "Wait a moment for your message to send."
    : slots <= 0 ? `A message can carry up to ${MAX_ATTACHMENTS} attachments.` : undefined;
  const submitting = sending || pending !== null;
  // A press on Send or Stop leaves focus in the message box, so a phone keeps its keyboard up
  // between messages. Focus moves as the default of mousedown, which a touch also fires; a click,
  // a key, a screen reader and voice control still activate the button.
  const keepFocus = (event: React.MouseEvent) => event.preventDefault();
  // On a touch screen with no mouse or trackpad, Return starts a new line. Ctrl+Enter and Cmd+Enter
  // send everywhere. See enter-key.ts.
  const enterSends = useEnterSends();
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
  // After a declined approval the message box asks what to do instead, until Hermes accepts the next message.
  const declinedStep = useDeclined(botId);
  // Only a receipt arriving after the decline counts: the one already showing belongs to an earlier message. A typed
  // stop phrase that ended Hermes's voice chat reached no one, so the question stays.
  useEffect(() => {
    if (declinedStep && receipt?.status === "accepted" && receipt.turn !== "none") clearDecline(botId);
  }, [receipt?.requestId, receipt?.status]);
  // Up and Down in an empty composer browse this person's earlier messages here, newest first.
  const [recall, setRecall] = useState<Recall>(null);
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
  // The status line under the message box: a long paste that became a file, or a send refused while
  // the connection is checked. It is a polite live region that is always present, so a screen reader
  // hears each new line once.
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 8000);
    return () => clearTimeout(timer);
  }, [status]);
  // Why Send and Stop are refused for the connection: their tooltip and, beside their label, their
  // accessible description. During the grace period nothing else says it.
  const connectionReason = connectionLost ? connectionShown ? WAITING_FOR_CONNECTION : CHECKING_CONNECTION : undefined;
  // A send refused during the grace period says so where the person is looking. Once the chat shows it
  // is disconnected, the dock's connection notice explains, so the line steps aside for it.
  const refusedForConnection = () => { if (connectionLost && !connectionShown) setStatus(NOT_SENT_CHECKING); };
  useEffect(() => { if (connectionShown) setStatus(current => current === NOT_SENT_CHECKING ? "" : current); }, [connectionShown]);
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
  // A typed stop phrase ended Hermes's voice chat. Hermes saved nothing, so the sent message leaves the chat and this says why.
  if (receipt?.status === "accepted" && receipt.turn === "none") notices.push({ id: "send-not-admitted", kind: "send", node: <div className="notice" role="status">
    {receipt.message || "Hermes ended its voice chat. Nothing was sent to the assistant."}
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
      <TalkPanel talk={talk} name={selected.name} />
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="composer-extras">
        {!!attachNotice.length && <div className="attachment-notice" role="alert">
          <Icon name="alert" size={15} />
          <div>{attachNotice.map(problem => <p key={problem}>{problem}</p>)}</div>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setAttachNotice([])}><Icon name="close" size={14} /></button>
        </div>}
        <p id="composer-paste-status" className="composer-status" role="status">{status}</p>
        <AttachmentTray attachments={shown.attachments} uploads={uploads} previews={previews}
          canOpen={boot.capabilities.generatedFiles.supported}
          onRemove={id => setDraft(previous => ({ ...previous, dirty: true, attachments: previous.attachments.filter(file => file.id !== id) }))}
          onCancel={cancelUpload} onRetry={retryUpload} />
        </div>
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
        </div>
        <span className="composer-measure-box" aria-hidden="true"><span className="composer-measure" /></span>
        <label className="sr-only" htmlFor="message">
          Message {selected.name}
        </label>
        <textarea
          ref={input.ref}
          id="message"
          value={shown.text}
          placeholder={
            handedOff ? "Sending…"
              : waiting ?? (declinedStep ? `Tell ${selected.name} what to do instead`
              : active
              ? "Guide…"
              : "Message…")
          }
          aria-describedby={status ? "composer-paste-status" : undefined}
          // Read-only rather than disabled, so focus stays here for the next message.
          readOnly={handedOff}
          onChange={(event) => {
            setRecall(null);
            setStatus("");
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
            setStatus(`Your paste was long, so it is attached as ${pasted.name} (${formatBytes(pasted.size)}).`);
          }}
          onKeyDown={(event) => {
            // Keys an input method is using, including the Enter that confirms a word, are its own.
            if (imeKey(event.nativeEvent)) return;
            if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
              && !submitting && !handedOff) {
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
            if (sendsOnKey(event.nativeEvent, enterSends)) {
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
              else if (draft.text.trim() || draft.attachments.length) refusedForConnection();
            }
          }}
          rows={1}
          // Labels the on-screen keyboard's Return key with what it does here.
          enterKeyHint={enterSends ? "send" : "enter"}
          disabled={!draftReady || draft.botId !== botId}
        />

            <VoiceControls avatar={selected.avatar} name={selected.name} key={`${boot.user.id}:${botId}`} botId={botId}
              disabled={!draftReady || draft.botId !== botId || pending !== null || sending || connectionLost || talking}
              extra={liveVoice && <button type="button" className="talk-start" aria-label={`Talk live with ${selected.name}`}
                aria-pressed={talking} disabled={connectionLost && !talking || voiceState !== "idle"}
                title={talking ? "End the live conversation" : liveVoice.supported ? `Talk with ${selected.name} out loud. It hears you and answers as you go.` : liveVoice.reason}
                onClick={() => talking ? talk.end() : liveVoice.supported ? talk.start() : talk.explain(liveVoice.reason ?? "Live talk is unavailable on this Hermes.")}>
                <Icon name="talk" size={18} /><span className="tool-label">Talk</span>
              </button>}
              onStateChange={setVoiceState} onTranscript={(text) => setDraft(previous => ({ ...previous, dirty: true,
                text: previous.text.trim() ? `${previous.text}\n${text}` : text }))} />
          {stopVisible ? <button type="button" className="send-button" aria-label="Stop response" onMouseDown={keepFocus}
            disabled={stopping || connectionLost || !boot.capabilities.stop.supported}
            title={boot.capabilities.stop.reason || connectionReason || "Stop response"}
            onClick={onStop}>
            <Icon name={stopping ? "spinner" : "stop"} className={stopping ? "spin" : undefined} size={19} />
          </button> : <button
            className="send-button"
            aria-label={active ? "Send guidance" : "Send message"}
            onMouseDown={keepFocus}
            aria-busy={submitting}
            title={connectionReason}
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
      </form>
    </footer>
  );
});
