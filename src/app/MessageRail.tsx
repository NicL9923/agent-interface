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
  // One array per ordered list of sent messages, so the position cache below can tell when they changed.
  // A streaming reply rebuilds the entries on every update while their IDs stay the same; the array stays too.
  const ids = useRef<string[]>([]);
  const entryIds = useMemo(() => {
    const next = entries.map((entry) => entry.id);
    const previous = ids.current;
    return next.length === previous.length && next.every((id, at) => id === previous[at])
      ? previous
      : next;
  }, [entries]);
  ids.current = entryIds;
  // The window's first entry, kept so ticks hold still while the anchor stays inside them.
  const [windowStart, setWindowStart] = useState<number>();
  // The tick that takes focus once the window holds it, after a key moved past the window's edge.
  const focusNext = useRef<string>(undefined);

  // Where each entry's message sits in the scrolled content, measured all at once only when the
  // messages, the content's size or the view's size change. A scroll searches it; see activeTick.
  // `width` is the column's when it was measured: a narrower column rewraps every turn.
  const places = useRef<{ ids: string[]; list: RailPlace[]; width: number } | null>(null);
  // Set when a turn above the last sent message changed size, which can move messages above it and leave it in place.
  const stale = useRef(false);
  const offsetOf = (view: HTMLElement, row: Element) =>
    row.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
  const rowOf = (view: HTMLElement, id: string) =>
    view.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
  // Each turn's height when the positions were measured, so a size report that matches it moved nothing.
  const heights = useRef(new WeakMap<Element, number>());
  const locate = (view: HTMLElement, width: number) => {
    // Changes to the column not yet reported came before this measurement, which sees them already.
    // Their turns still need watching, but they are no reason to measure again.
    const unreported = columnChanges.current?.takeRecords();
    if (unreported?.length) settle(view, unreported, null);
    const index = new Map(ids.current.map((id, at) => [id, at]));
    const list: RailPlace[] = [];
    for (const row of view.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const at = index.get(row.dataset.messageId!);
      if (at !== undefined) list.push({ index: at, offset: offsetOf(view, row) });
    }
    places.current = { ids: ids.current, list: list.sort((a, b) => a.offset - b.offset), width };
    const measured = new WeakMap<Element, number>();
    for (const turn of view.firstElementChild?.children ?? [])
      measured.set(turn, turn.getBoundingClientRect().height);
    heights.current = measured;
    stale.current = false;
  };
  /**
   * Whether a turn's reported size is exactly the one it had when the positions were measured. Any
   * difference measures again: shifts too small to matter alone add up across turns. Chromium and
   * WebKit report the same number as getBoundingClientRect, except under CSS zoom, which measures again.
   */
  const unchanged = ({ target, borderBoxSize }: ResizeObserverEntry) => {
    const known = heights.current.get(target);
    // Safari before 15.4 reports no border box.
    return known !== undefined && borderBoxSize?.[0]?.blockSize === known;
  };
  const lastRow = (view: HTMLElement) => {
    const cached = places.current;
    const last = cached?.list.at(-1);
    return cached && last ? rowOf(view, cached.ids[last.index]!) : null;
  };
  // Growth below the last sent message, such as a streaming reply, moves no tick's message. A turn above
  // it that changed size, or a new column width, can move messages above it and leave it in place, so
  // those measure all. Anything else that moved messages moved the last one too, so with `check` one
  // measurement of it tells whether the cache still holds.
  const revalidate = (view: HTMLElement, width: number, check: boolean) => {
    const cached = places.current;
    const last = cached?.list.at(-1);
    if (!cached || cached.ids !== ids.current || !last || stale.current || cached.width !== width)
      return locate(view, width);
    if (!check) return;
    const row = lastRow(view);
    if (!row || Math.abs(offsetOf(view, row) - last.offset) > 0.5) locate(view, width);
  };
  // Read by the observers below, which outlive a render. While the rail is hidden they do no work.
  const shownNow = useRef(false);
  shownNow.current = shown;
  const readActive = useRef(() => {});
  readActive.current = () => {
    const view = scroll.current;
    if (!view || !shownNow.current) return;
    if (!places.current || places.current.ids !== ids.current)
      locate(view, view.firstElementChild?.getBoundingClientRect().width ?? 0);
    const at = activeTick(places.current!.list, view.scrollTop, view.clientHeight, atTrueEnd(view));
    setActiveId(ids.current[at]);
  };
  /** `check`: whether something may have moved the last sent message, so it is measured again. */
  const measure = useRef((_check?: boolean) => {});
  measure.current = (check = true) => {
    const view = scroll.current;
    const column = view?.firstElementChild;
    if (!view || !column)
      return setLayout((previous) => (sameLayout(previous, hidden) ? previous : hidden));
    const scrollbar = Math.max(0, view.offsetWidth - view.clientWidth);
    const box = column.getBoundingClientRect();
    const next: Layout = {
      canHover: canHoverNow(),
      gutter: view.getBoundingClientRect().right - scrollbar - box.right,
      overflows: view.scrollHeight > view.clientHeight + 1,
      height: view.clientHeight - RAIL_INSET * 2,
      scrollbar,
    };
    setLayout((previous) => (sameLayout(previous, next) ? previous : next));
    // Nothing keeps the positions current while the rail is hidden, so it measures them all when it shows again.
    if (!railShown({ ...next, count: ids.current.length })) {
      shownNow.current = false;
      places.current = null;
      return;
    }
    shownNow.current = true;
    revalidate(view, box.width, check);
    readActive.current();
  };
  // Each turn in the column is watched for size changes while the rail shows; see `resized` below. Turns
  // and run cards come and go without a message changing, so the column's mutations add and drop them.
  const turnObserver = useRef<ResizeObserver>(undefined);
  const watched = useRef(new Set<Element>());
  const watch = (turn: Node) => {
    const observer = turnObserver.current;
    if (!observer || !(turn instanceof Element) || watched.current.has(turn)) return;
    observer.observe(turn);
    watched.current.add(turn);
  };
  const unwatch = (turn: Node) => {
    if (!(turn instanceof Element) || !watched.current.delete(turn)) return;
    turnObserver.current?.unobserve(turn);
  };
  // A turn or run card that joins, leaves or moves above the last sent message moves the messages after it,
  // and the browser may report only the column's new size, or nothing at all when the height is the same.
  const columnChanges = useRef<MutationObserver>(undefined);
  /** Watches the turns that joined the column and drops those that left. True when one sat above `last`. */
  const settle = (view: HTMLElement, records: MutationRecord[], last: Element | null) => {
    const column = view.firstElementChild;
    let shifted = false;
    for (const { addedNodes, removedNodes, nextSibling } of records) {
      for (const node of removedNodes) unwatch(node);
      for (const node of addedNodes)
        if (node.parentNode === column) {
          watch(node);
          if (last && above(node, last)) shifted = true;
        }
      // A removed turn sat just before its next sibling. One whose sibling went too may have sat anywhere.
      if (
        last &&
        removedNodes.length &&
        nextSibling &&
        (nextSibling.parentNode !== column ||
          nextSibling.contains(last) ||
          above(nextSibling, last))
      )
        shifted = true;
    }
    return shifted;
  };
  // All at once only when the rail shows or hides, or the observer starts.
  const watchAll = useRef(() => {});
  watchAll.current = () => {
    const column = scroll.current?.firstElementChild;
    if (shownNow.current && column) for (const turn of column.children) watch(turn);
    else for (const turn of watched.current) unwatch(turn);
  };
  // New messages, or an earlier page, change what overflows. Whether they moved any sent message is
  // revalidate's to tell: new IDs measure all, and anything else checks the last sent message alone.
  useLayoutEffect(() => measure.current(), [entries]);
  useLayoutEffect(() => watchAll.current(), [shown]);
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
    // The view, the column and each turn in it. A turn that ends above the last sent message makes the
    // positions stale. The last turn, where a reply streams, and the column growing with it, do not:
    // the render that grew them already checked the last sent message. Nor does a turn's first report after
    // it joins, when the measurement that saw it join found it this size.
    const resized = (entries: ResizeObserverEntry[] | undefined) => {
      const last = lastRow(view);
      let check = !entries || !last;
      for (const entry of entries ?? []) {
        if (entry.target === view) check = true;
        // The column and the last turn hold the last sent message, so they pass here.
        else if (last && above(entry.target, last) && !unchanged(entry)) stale.current = true;
      }
      measure.current(check);
    };
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resized);
    observer?.observe(view);
    if (view.firstElementChild) observer?.observe(view.firstElementChild);
    turnObserver.current = observer;
    watchAll.current();
    const joined =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver((records) => {
            if (!shownNow.current) return;
            const last = lastRow(view);
            // With no last sent message on the page, the positions are of messages that left.
            if (settle(view, records, last) || !last) {
              stale.current = true;
              measure.current();
            }
          });
    columnChanges.current = joined;
    if (view.firstElementChild) joined?.observe(view.firstElementChild, { childList: true });
    return () => {
      cancelAnimationFrame(frame);
      view.removeEventListener("scroll", scrolled);
      media?.removeEventListener?.("change", changed);
      observer?.disconnect();
      joined?.disconnect();
      columnChanges.current = undefined;
      turnObserver.current = undefined;
      watched.current.clear();
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
                // Tab arrives here with no key move, and the window has to keep this tick from then on.
                setRoverId(entry.id);
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

/** A turn that ends above the last sent message: a change to it can move messages above that one and not it. */
const above = (node: Node, last: Element) =>
  !node.contains(last) && !!(node.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING);

/** Keyboard focus shows the preview; a click's focus does not, so a jump leaves nothing over the text. */
function focusVisible(element: Element) {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}
