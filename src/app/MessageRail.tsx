import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject, WheelEvent } from "react";
import type { Message } from "../shared/types";
import { Icon } from "../components/Icon";
import { When } from "../components/When";
import { atTrueEnd } from "./scroll-follow";
import {
  activeTick,
  RAIL_INSET,
  RAIL_PITCH,
  railEntries,
  railHidden,
  railKey,
  railRoom,
  railShown,
  railWindow,
  tickName,
  type RailPlace,
} from "./message-rail";
import "./message-rail.css";

const HOVER_QUERY = "(hover: hover) and (pointer: fine)";
const canHoverNow = () => typeof matchMedia === "function" && matchMedia(HOVER_QUERY).matches;

type Layout = {
  canHover: boolean;
  gutter: number;
  overflows: boolean;
  /** Room for ticks, between the insets that keep Find in chat and the jump to the latest clear. */
  height: number;
  /** The transcript's scroll bar, which the rail sits beside rather than over. */
  scrollbar: number;
};
const hidden: Layout = { canHover: false, gutter: 0, overflows: false, height: 0, scrollbar: 0 };
const sameLayout = (a: Layout, b: Layout) =>
  a.canHover === b.canHover &&
  a.gutter === b.gutter &&
  a.overflows === b.overflows &&
  a.height === b.height &&
  a.scrollbar === b.scrollbar;

/**
 * A strip at the right edge of a long chat with one tick per message a person sent, so they can jump
 * back to an earlier question. It covers the loaded messages and grows as earlier pages load. It shows
 * only for a pointer that can hover, beside the reading column rather than over it, once there is
 * something to scroll past. When not every tick fits, it shows a window of them around the turn in view,
 * or around the tick focus moved to, with a chevron toward each hidden side. One tab stop: Up, Down,
 * Home and End move between every loaded sent message, moving the window with them.
 */
export const MessageRail = memo(function MessageRail({
  messages,
  scroll,
  jump,
}: {
  messages: Message[];
  scroll: RefObject<HTMLDivElement | null>;
  /** Brings a loaded message to the top of the view and marks it; see `jumpTo` in use-conversation. */
  jump: (messageId: string) => boolean;
}) {
  const entries = useMemo(() => railEntries(messages), [messages]);
  const [layout, setLayout] = useState<Layout>(hidden);
  const [activeId, setActiveId] = useState<string>();
  const [roverId, setRoverId] = useState<string>();
  const [hoverId, setHoverId] = useState<string>();
  const [focus, setFocus] = useState<{ id: string; visible: boolean }>();
  // The tick whose preview Escape put away, until another tick is previewed.
  const [dismissedId, setDismissedId] = useState<string>();
  const list = useRef<HTMLOListElement>(null);
  const nav = useRef<HTMLElement>(null);
  const hiddenId = useId();
  const shown = railShown({ ...layout, count: entries.length });
  // One array per list of entries, so the position cache below can tell when the entries changed.
  const entryIds = useMemo(() => entries.map((entry) => entry.id), [entries]);
  const ids = useRef<string[]>([]);
  ids.current = entryIds;
  // The window's first entry, kept so ticks hold still while the anchor stays inside them.
  const [windowStart, setWindowStart] = useState<number>();
  // The tick that takes focus once the window holds it, after a key moved past the window's edge.
  const focusNext = useRef<string>(undefined);

  // Where each entry's message sits in the scrolled content, measured all at once only when the
  // messages, the content's size or the view's size change. A scroll searches it; see activeTick.
  const places = useRef<{ ids: string[]; list: RailPlace[] } | null>(null);
  const offsetOf = (view: HTMLElement, row: Element) =>
    row.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
  const rowOf = (view: HTMLElement, id: string) =>
    view.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
  const locate = (view: HTMLElement) => {
    const index = new Map(ids.current.map((id, at) => [id, at]));
    const list: RailPlace[] = [];
    for (const row of view.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const at = index.get(row.dataset.messageId!);
      if (at !== undefined) list.push({ index: at, offset: offsetOf(view, row) });
    }
    places.current = { ids: ids.current, list: list.sort((a, b) => a.offset - b.offset) };
  };
  // Growth below the last sent message, such as a streaming reply, moves no tick's message; anything
  // above it moves that last one too. So one measurement tells whether the cache still holds.
  const revalidate = (view: HTMLElement) => {
    const cached = places.current;
    const last = cached?.list.at(-1);
    const row = cached && last ? rowOf(view, cached.ids[last.index]!) : null;
    if (
      !cached ||
      cached.ids !== ids.current ||
      !last ||
      !row ||
      Math.abs(offsetOf(view, row) - last.offset) > 0.5
    )
      locate(view);
  };
  const readActive = useRef(() => {});
  readActive.current = () => {
    const view = scroll.current;
    if (!view) return;
    if (!places.current || places.current.ids !== ids.current) locate(view);
    const at = activeTick(places.current!.list, view.scrollTop, view.clientHeight, atTrueEnd(view));
    setActiveId(ids.current[at]);
  };
  const measure = useRef(() => {});
  measure.current = () => {
    const view = scroll.current;
    const column = view?.firstElementChild;
    if (!view || !column)
      return setLayout((previous) => (sameLayout(previous, hidden) ? previous : hidden));
    const scrollbar = Math.max(0, view.offsetWidth - view.clientWidth);
    const next: Layout = {
      canHover: canHoverNow(),
      gutter: view.getBoundingClientRect().right - scrollbar - column.getBoundingClientRect().right,
      overflows: view.scrollHeight > view.clientHeight + 1,
      height: view.clientHeight - RAIL_INSET * 2,
      scrollbar,
    };
    setLayout((previous) => (sameLayout(previous, next) ? previous : next));
    if (!railShown({ ...next, count: ids.current.length })) return;
    revalidate(view);
    readActive.current();
  };
  // New messages, or an earlier page, change both what overflows and where each message sits.
  useLayoutEffect(() => {
    places.current = null;
    measure.current();
  }, [entries]);
  useEffect(() => {
    const view = scroll.current;
    if (!view) return;
    let frame = 0;
    // A scroll moves no message within the content, so it only searches the places already measured.
    const scrolled = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        readActive.current();
      });
    };
    view.addEventListener("scroll", scrolled, { passive: true });
    const media = typeof matchMedia === "function" ? matchMedia(HOVER_QUERY) : undefined;
    const changed = () => measure.current();
    media?.addEventListener?.("change", changed);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(changed);
    observer?.observe(view);
    if (view.firstElementChild) observer?.observe(view.firstElementChild);
    return () => {
      cancelAnimationFrame(frame);
      view.removeEventListener("scroll", scrolled);
      media?.removeEventListener?.("change", changed);
      observer?.disconnect();
    };
  }, [scroll]);
  const asked = hoverId ?? (focus?.visible ? focus.id : undefined);
  const previewId = asked === dismissedId ? undefined : asked;
  // Escape puts the preview away wherever focus is, as a pointer can show it without focus (WCAG 1.4.13).
  useEffect(() => {
    if (!previewId) return;
    const dismiss = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setDismissedId(previewId);
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [previewId]);
  // While a tick has focus the window keeps it; otherwise it keeps the turn in view, else the latest.
  // Focus is read from the page, so the render a key starts still sees it on the tick it is leaving.
  const keyed = !!roverId && !!nav.current?.contains(document.activeElement);
  const anchorId = (keyed ? roverId : activeId) ?? ids.current.at(-1);
  const anchor = anchorId ? ids.current.indexOf(anchorId) : -1;
  const span = shown
    ? railWindow(
        entries.length,
        railRoom(layout.height),
        anchor < 0 ? entries.length - 1 : anchor,
        windowStart,
      )
    : { start: 0, end: 0 };
  const ticks = entries.slice(span.start, span.end);
  useLayoutEffect(() => {
    if (shown && span.start !== windowStart) setWindowStart(span.start);
    const id = focusNext.current;
    if (!id) return;
    focusNext.current = undefined;
    list.current?.querySelector<HTMLButtonElement>(`[data-entry-id="${CSS.escape(id)}"]`)?.focus();
  });
  if (!ticks.length) return null;

  // The tab stop stays on the tick last moved to, else the turn in view, else the latest shown.
  const rover = ticks.find((entry) => entry.id === roverId)
    ? roverId
    : ticks.find((entry) => entry.id === activeId)
      ? activeId
      : ticks.at(-1)!.id;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const index = entries.findIndex((entry) => entry.id === rover);
    const next = railKey(event.key, index, entries.length);
    if (next === undefined) return;
    event.preventDefault();
    const id = entries[next]!.id;
    setRoverId(id);
    // A tick the window already shows takes focus now; one beyond it, once the window has moved.
    const button = list.current?.querySelector<HTMLButtonElement>(
      `[data-entry-id="${CSS.escape(id)}"]`,
    );
    if (button) button.focus();
    else focusNext.current = id;
  };
  // The rail sits beside the transcript, not in it, so a wheel over it still scrolls the transcript,
  // and is heard as the reader's own scroll (see scrollIntent).
  const onWheel = (event: WheelEvent<HTMLElement>) => {
    const view = scroll.current;
    // Ctrl or Cmd with the wheel zooms the page instead.
    if (!view || !event.deltaY || event.ctrlKey || event.metaKey) return;
    view.dispatchEvent(new globalThis.WheelEvent("wheel", { deltaY: event.deltaY }));
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.clientHeight : 1;
    view.scrollBy?.({ top: event.deltaY * unit });
  };
  const preview = ticks.findIndex((entry) => entry.id === previewId);
  const card = ticks[preview];
  const center = preview * RAIL_PITCH + RAIL_PITCH / 2;
  const below = preview >= ticks.length / 2;
  const earlier = span.start;
  const later = entries.length - span.end;
  const hiddenText = railHidden(earlier, later);
  return (
    <nav
      ref={nav}
      className="message-rail"
      aria-label="Messages you sent in this chat"
      aria-describedby={hiddenText ? hiddenId : undefined}
      style={{ right: layout.scrollbar }}
      onKeyDown={onKeyDown}
      onWheel={onWheel}
      onPointerLeave={() => setHoverId(undefined)}
    >
      {hiddenText && (
        <span id={hiddenId} className="sr-only">
          {hiddenText}
        </span>
      )}
      {/* A shape, not only a shade, says that more ticks are hidden that way. */}
      {earlier > 0 && (
        <span className="message-rail-more message-rail-more-earlier" aria-hidden="true">
          <Icon name="up" size={14} />
        </span>
      )}
      <ol ref={list}>
        {ticks.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              data-entry-id={entry.id}
              className="message-rail-tick"
              tabIndex={entry.id === rover ? 0 : -1}
              aria-label={tickName(entry)}
              aria-current={entry.id === activeId ? "location" : undefined}
              onPointerEnter={() => {
                setHoverId(entry.id);
                setDismissedId(undefined);
              }}
              onFocus={(event) => {
                setFocus({ id: entry.id, visible: focusVisible(event.target) });
                setDismissedId(undefined);
              }}
              onBlur={() => setFocus(undefined)}
              onClick={() => {
                setRoverId(entry.id);
                jump(entry.id);
              }}
            />
          </li>
        ))}
      </ol>
      {later > 0 && (
        <span className="message-rail-more message-rail-more-later" aria-hidden="true">
          <Icon name="down" size={14} />
        </span>
      )}
      {card && (
        // The tick's name already carries the words, so the card is for the eye only.
        <div
          className="message-rail-preview"
          aria-hidden="true"
          style={below ? { bottom: ticks.length * RAIL_PITCH - center - 20 } : { top: center - 20 }}
        >
          <p className="message-rail-sent">{card.text}</p>
          {card.reply && <p className="message-rail-reply">{card.reply}</p>}
          {card.at && <When className="message-rail-time" value={card.at} />}
        </div>
      )}
    </nav>
  );
});

/** Keyboard focus shows the preview; a click's focus does not, so a jump leaves nothing over the text. */
function focusVisible(element: Element) {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}
