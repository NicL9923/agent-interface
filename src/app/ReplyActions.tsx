import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Message } from "../shared/types";
import { request as apiRequest } from "../client-api";
import { Icon } from "../components/Icon";
import { useAction } from "./use-action";
import { replyTitle } from "./transcript-logic";

/** What reply actions need from the conversation around them. Kept in context so the memoized transcript never re-renders for it. */
export type TranscriptTools = {
  botId: string;
  sessionId?: string;
  unavailable: boolean;
  /** Adds a Markdown quote to the draft, or explains that it cannot while a send is on its way. */
  quote(text: string): void;
  /** Speaks a short result through the conversation's live region. */
  announce(text: string): void;
};
export const TranscriptTools = createContext<TranscriptTools | null>(null);

const canShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";

/** Copy, share, save and quote for one reply. Shown on hover or focus with a mouse, always with touch. */
export function ReplyActions({ message }: { message: Message }) {
  const tools = useContext(TranscriptTools);
  const save = useAction();
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!tools) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
      tools.announce("Copied");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch { tools.announce("Couldn't copy. Select the reply and copy it manually."); }
  };
  const share = () => navigator.share({ text: message.text }).catch(() => { /* Dismissing the share sheet is not an error. */ });
  const keep = () => void save.run(() => apiRequest("POST /saved", { body: {
    kind: "session", botId: tools.botId, sessionId: tools.sessionId!, messageId: message.id, title: replyTitle(message.text),
  } }), {
    onSuccess: () => { setSaved(true); tools.announce("Reply saved. Find it in Search under Saved items."); },
    onError: cause => { tools.announce(`Couldn't save this reply. ${(cause as Error).message}`); return null; },
  });
  const unsaved = !tools.sessionId || tools.unavailable;
  return <div className="reply-actions" role="group" aria-label="Reply actions">
    <button type="button" className="reply-action" onClick={() => void copy()} aria-label={copied ? "Copied" : "Copy reply"} title="Copy reply">
      <Icon name={copied ? "check" : "copy"} size={16} />
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
