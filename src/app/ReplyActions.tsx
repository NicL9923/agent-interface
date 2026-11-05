import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Message } from "../shared/types";
import { request as apiRequest } from "../client-api";
import { Icon } from "../components/Icon";
import { When } from "../components/When";
import { useAction } from "./use-action";
import type { ReplySpeech } from "./use-reply-speech";
import { savedReplyTitle } from "../shared/discovery";

/** What reply actions need from the conversation around them. Kept in context so the memoized transcript never re-renders for it. */
export type TranscriptTools = {
  botId: string;
  sessionId?: string;
  unavailable: boolean;
  /** Adds a Markdown quote to the draft, or explains that it cannot while a send is on its way. */
  quote(text: string): void;
  /** Speaks a short result through the conversation's live region. */
  announce(text: string): void;
  /** Reading replies aloud. One reply plays at a time across the transcript. */
  speech: ReplySpeech;
};
export const TranscriptTools = createContext<TranscriptTools | null>(null);

const canShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";

/**
 * The line under a message: its time or delivery status, and its actions. A person's own message is
 * on the right with its bubble, a reply on the left. A reply made of several parts shows the time
 * once, under the last, while each part keeps its own actions.
 */
export function MessageMeta({ message, own, when, delivery, actions }: {
  message: Message;
  own: boolean;
  /** Shown as the message's time. Omitted for the parts of a reply before the last. */
  when?: string;
  delivery?: "sending" | "unconfirmed";
  actions: boolean;
}) {
  const tools = useContext(TranscriptTools);
  // Always visible, unlike the actions, so a refused reply is never hidden by the pointer leaving.
  const speechError = tools?.speech.error?.id === message.id ? tools.speech.error.text : undefined;
  if (!when && !delivery && !actions) return null;
  return <>
    <div className={`message-meta message-meta-${own ? "own" : "reply"}`}>
      {delivery ? <span className="message-delivery">{delivery === "sending" ? "Sending…" : "Not confirmed yet"}</span> : when && <When value={when} />}
      {actions && <MessageActions message={message} />}
    </div>
    {speechError && <p className="speech-error" role="alert">{speechError}</p>}
  </>;
}

/** Copy on any message, and for a reply also listen, share, save and quote. Shown on hover or focus with a mouse, always with touch. */
function MessageActions({ message }: { message: Message }) {
  const tools = useContext(TranscriptTools);
  const save = useAction();
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!tools) return null;
  const reply = message.role === "assistant";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
      tools.announce("Copied");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch { tools.announce(`Couldn't copy. Select the ${reply ? "reply" : "message"} and copy it manually.`); }
  };
  const share = () => navigator.share({ text: message.text }).catch(() => { /* Dismissing the share sheet is not an error. */ });
  const keep = () => void save.run(() => apiRequest("POST /saved", { body: {
    kind: "session", botId: tools.botId, sessionId: tools.sessionId!, messageId: message.id, title: savedReplyTitle(message.text),
  } }), {
    onSuccess: () => { setSaved(true); tools.announce("Reply saved. Find it in Search under Saved items."); },
    onError: cause => { tools.announce(`Couldn't save this reply. ${(cause as Error).message}`); return null; },
  });
  const unsaved = !tools.sessionId || tools.unavailable;
  const noun = reply ? "reply" : "message";
  const spoken = tools.speech.current?.id === message.id ? tools.speech.current.phase : undefined;
  const listen = spoken === "preparing" ? "Preparing spoken reply" : spoken === "speaking" ? "Stop speaking" : spoken === "ready" ? "Play audio" : "Listen to reply";
  return <div className="message-actions" role="group" aria-label={reply ? "Reply actions" : "Message actions"}>
    <button type="button" className="reply-action" onClick={() => void copy()} aria-label={copied ? "Copied" : `Copy ${noun}`} title={`Copy ${noun}`}>
      <Icon name={copied ? "check" : "copy"} size={16} />
    </button>
    {reply && <>
      {/* Preparing can be cancelled too, so the button never dead-ends while audio loads. */}
      <button type="button" className="reply-action" data-speech={spoken} onClick={() => tools.speech.toggle(message)}
        disabled={tools.unavailable && !spoken} aria-label={listen} title={tools.unavailable && !spoken ? "Reconnect to listen to this reply." : spoken === "preparing" ? "Cancel" : listen}>
        <Icon name={spoken === "preparing" ? "spinner" : spoken === "speaking" ? "stop" : "speaker"} className={spoken === "preparing" ? "spin" : undefined} size={16} />
      </button>
      {canShare() && <button type="button" className="reply-action" onClick={() => void share()} aria-label="Share reply" title="Share reply">
        <Icon name="share" size={16} />
      </button>}
      <button type="button" className="reply-action" onClick={keep} disabled={save.busy || saved || unsaved}
        aria-label={saved ? "Reply saved" : save.busy ? "Saving reply" : "Save reply"}
        title={unsaved && !saved ? tools.unavailable ? "Reconnect to save this reply." : "This reply can't be saved yet." : saved ? "Reply saved" : "Save reply"}>
        <Icon name={saved ? "check" : save.busy ? "spinner" : "bookmark"} className={save.busy ? "spin" : undefined} size={16} />
      </button>
      <button type="button" className="reply-action" onClick={() => tools.quote(message.text)} aria-label="Quote in reply" title="Quote in reply">
        <Icon name="quote" size={16} />
      </button>
    </>}
  </div>;
}

/**
 * A small Quote button beside text selected inside one assistant reply. It quotes only the selection.
 * Pressing it keeps the selection, so the button reads what the person chose.
 */
export function QuoteSelection({ frame, scroll }: { frame: RefObject<HTMLElement | null>; scroll: RefObject<HTMLElement | null> }) {
  const tools = useContext(TranscriptTools);
  const [place, setPlace] = useState<{ text: string; top: number; left: number } | null>(null);
  useEffect(() => {
    const measure = () => {
      const selection = document.getSelection();
      const box = frame.current;
      if (!selection || selection.isCollapsed || !selection.rangeCount || !box) return setPlace(null);
      const reply = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest(".message-assistant .message-markdown");
      const start = reply(selection.anchorNode);
      const text = selection.toString().trim();
      if (!start || start !== reply(selection.focusNode) || !scroll.current?.contains(start) || !text) return setPlace(null);
      const rect = selection.getRangeAt(0).getBoundingClientRect(), outer = box.getBoundingClientRect();
      // Touch keeps the system's own menu above a selection, so the button goes below it there.
      const below = matchMedia("(pointer: coarse)").matches;
      const top = (below ? rect.bottom + 8 : rect.top - 44) - outer.top;
      const left = Math.min(Math.max(8, rect.left + rect.width / 2 - outer.left - 40), outer.width - 96);
      setPlace({ text, top: Math.max(4, top), left });
    };
    const view = scroll.current;
    document.addEventListener("selectionchange", measure);
    view?.addEventListener("scroll", measure, { passive: true });
    return () => {
      document.removeEventListener("selectionchange", measure);
      view?.removeEventListener("scroll", measure);
    };
  }, [frame, scroll]);
  if (!tools || !place) return null;
  return <button type="button" className="quote-selection" style={{ top: place.top, left: place.left }}
    onPointerDown={event => event.preventDefault()}
    onClick={() => { tools.quote(place.text); document.getSelection()?.removeAllRanges(); }}>
    <Icon name="quote" size={14} /> Quote
  </button>;
}
