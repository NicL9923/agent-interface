import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject, WheelEvent } from "react";
import type { Message } from "../shared/types";
import { When } from "../components/When";
import { atTrueEnd } from "./scroll-follow";
import {
  activeTick,
  fitTicks,
  RAIL_INSET,
  RAIL_PITCH,
  railEntries,
  railKey,
  railShown,
  tickName,
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
 * something to scroll past. One tab stop: Up, Down, Home and End move between ticks.
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
  const shown = railShown({ ...layout, count: entries.length });
  const ticks = shown ? fitTicks(entries, layout.height) : [];
  const ids = useRef<string[]>([]);
  ids.current = entries.map((entry) => entry.id);

  // Which turn is in view, read from where each message sits now.
  const readActive = useRef(() => {});
  readActive.current = () => {
    const view = scroll.current;
    if (!view) return;
    const top = view.getBoundingClientRect().top;
    const rows = new Map<string, HTMLElement>();
    for (const row of view.querySelectorAll<HTMLElement>("[data-message-id]"))
      rows.set(row.dataset.messageId!, row);
    const tops = ids.current.map((id) => {
      const row = rows.get(id);
      return row ? row.getBoundingClientRect().top - top : undefined;
    });
    setActiveId(ids.current[activeTick(tops, view.clientHeight, atTrueEnd(view))]);
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
    if (railShown({ ...next, count: ids.current.length })) readActive.current();
  };
  // New messages, or an earlier page, change both what overflows and where each message sits.
  useLayoutEffect(() => measure.current(), [entries]);
  useEffect(() => {
    const view = scroll.current;
    if (!view) return;
    let frame = 0;
    const scrolled = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure.current();
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
  if (!ticks.length) return null;

  // The tab stop stays on the tick last moved to, else the turn in view, else the latest.
  const rover = ticks.find((entry) => entry.id === roverId)
    ? roverId
    : ticks.find((entry) => entry.id === activeId)
      ? activeId
      : ticks.at(-1)!.id;
  const moveTo = (index: number) => {
    setRoverId(ticks[index].id);
    list.current?.querySelectorAll<HTMLButtonElement>("button")[index]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const index = ticks.findIndex((entry) => entry.id === rover);
    const next = railKey(event.key, index, ticks.length);
    if (next === undefined) return;
    event.preventDefault();
    moveTo(next);
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
  return (
    <nav
      className="message-rail"
      aria-label="Messages you sent in this chat"
      style={{ right: layout.scrollbar }}
      onKeyDown={onKeyDown}
      onWheel={onWheel}
      onPointerLeave={() => setHoverId(undefined)}
    >
      <ol ref={list}>
        {ticks.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
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
