import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { SearchHit } from "../shared/discovery";
import { request } from "../client-api";
import { Icon } from "../components/Icon";
import type { SavedConversation } from "./storage";
import { localMatches, mergeFindMatches } from "./transcript-logic";
import type { FindMatch } from "./transcript-logic";
import { shownMessages, matchRanges } from "./find-ranges";

/** Server search waits for a pause in typing, and needs at least this many characters. */
const SEARCH_DELAY = 300;
const SEARCH_MIN = 2;
const highlights = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined" ? CSS.highlights : undefined;

/**
 * Find in this chat. Loaded messages match as the person types; server search then adds matches in
 * history not loaded yet, which open the conversation at that message. Enter goes to the older match,
 * Shift+Enter to the newer one, and Escape closes.
 */
export function FindBar({ botId, conversation, scroll, openMessage, onClose }: {
  botId: string;
  conversation: SavedConversation | null;
  scroll: RefObject<HTMLDivElement | null>;
  openMessage(messageId: string, mark?: boolean, needle?: string): void;
  onClose(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [localResult, setLocal] = useState<{ needle: string; matches: FindMatch[] }>({ needle: "", matches: [] });
  const [remote, setRemote] = useState<{ query: string; hits: SearchHit[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const needle = query.trim().toLocaleLowerCase();
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  // Loaded matches follow what is on screen, including replies still arriving. A new query brings
  // its newest loaded match into view, without loading anything.
  useEffect(() => {
    setLocal({ needle, matches: scroll.current ? localMatches(shownMessages(scroll.current), query) : [] });
  }, [query, needle, conversation, scroll]);
  // Only the latest query's response counts; an older one that lands late is dropped.
  const latest = useRef(0);
  useEffect(() => {
    const q = query.trim();
    const ticket = ++latest.current;
    if (q.length < SEARCH_MIN) return;
    const timer = setTimeout(() => {
      request("GET /search", { query: { q, botId } })
        .then(result => { if (ticket === latest.current) setRemote({ query: q, hits: result.hits }); }, () => { /* Loaded matches still work. */ });
    }, SEARCH_DELAY);
    return () => clearTimeout(timer);
  }, [query, botId]);
  const local = useMemo(() => localResult.needle === needle ? localResult.matches : [], [localResult, needle]);
  const matches = useMemo(() => mergeFindMatches(local, remote?.query === query.trim() ? remote.hits : [], {
    botId, sessionId: conversation?.sessionId, loadedIds: new Set(conversation?.messages.map(message => message.id)),
  }), [local, remote, query, botId, conversation]);
  const chosen = selected ? matches.findIndex(match => match.messageId === selected) : -1;
  const index = chosen >= 0 ? chosen : matches.length - 1;
  const current = matches[index];
  useEffect(() => {
    if (current && chosen < 0) setSelected(current.messageId);
  }, [current?.messageId, chosen]);
  useEffect(() => {
    if (current?.loaded && needle) openMessage(current.messageId, false, needle);
  }, [current?.messageId, current?.loaded, needle, openMessage]);
  useEffect(() => {
    const registry = highlights(), container = scroll.current;
    if (!registry || !container || !needle) return;
    const ranges = (id: string) => {
      const item = container.querySelector<HTMLElement>(`article[data-message-id="${CSS.escape(id)}"]`);
      return item ? matchRanges(item, needle) : [];
    };
    registry.set("find-match", new Highlight(...local.flatMap(match => ranges(match.messageId))));
    if (current?.loaded) registry.set("find-current", new Highlight(...ranges(current.messageId)));
    return () => { registry.delete("find-match"); registry.delete("find-current"); };
  }, [local, needle, current, scroll]);
  const go = (delta: number) => {
    if (!matches.length) return;
    const next = matches[(index + delta + matches.length) % matches.length];
    setSelected(next.messageId);
    openMessage(next.messageId, true, needle);
  };
  const searching = query.trim().length >= SEARCH_MIN && remote?.query !== query.trim();
  const status = !needle ? "" : matches.length ? `${index + 1} of ${matches.length}` : searching ? "Searching…" : "No matches";
  return <div className="find-bar" role="search" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
  }}>
    <Icon name="search" size={16} />
    <input ref={input} type="search" aria-label="Find in chat" placeholder="Find in chat" value={query}
      enterKeyHint="search" autoComplete="off" spellCheck={false}
      onChange={event => { setQuery(event.target.value); setSelected(null); }}
      onKeyDown={event => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        go(event.shiftKey ? 1 : -1);
      }} />
    <span className="find-count" role="status">{status}</span>
    <button type="button" className="icon-button" aria-label="Older match" title="Older match (Enter)" disabled={!matches.length} onClick={() => go(-1)}><Icon name="up" size={16} /></button>
    <button type="button" className="icon-button" aria-label="Newer match" title="Newer match (Shift+Enter)" disabled={!matches.length} onClick={() => go(1)}><Icon name="down" size={16} /></button>
    <button type="button" className="icon-button" aria-label="Close find" title="Close (Escape)" onClick={onClose}><Icon name="close" size={16} /></button>
  </div>;
}
