import type { Message } from "../shared/types";
import { isConversationReply, messageOrigin } from "../shared/message-origin";
import { ANCHOR_GAP } from "./scroll-follow";
import { isHumanMessage } from "./transcript-logic";
import { replySnippet } from "./reply-announcement";

/**
 * The message rail: one tick per message a person sent among the loaded messages, so a long chat can
 * be read back by its questions. See MessageRail.tsx for how it is drawn and moved through.
 */

/** Each tick is a 24 px tall target (WCAG 2.2 target size), and ticks sit this far apart. */
export const RAIL_PITCH = 24;
/** Space the rail needs between the reading column and the frame's edge, scroll bar excluded. */
export const RAIL_SPACE = 48;
/** Space kept above and below the rail, clear of Find in chat and the jump to the latest message. */
export const RAIL_INSET = 64;
/** The rail is for finding an earlier question; with fewer than this, scrolling already does it. */
export const RAIL_MIN_MESSAGES = 3;
/** How much of a message a tick's accessible name carries. */
const NAME_CHARS = 80;
/** Replies are long; the preview shows two lines, so only their start is read. */
const REPLY_READ = 600;

export type RailEntry = {
  id: string;
  /** The message's words on one line, or its files' names when it has no words. */
  text: string;
  /** The start of the reply that followed, before the next message that starts a turn. */
  reply?: string;
  at?: Message["createdAt"];
};

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
/** A person's message, or a scheduled prompt: either one starts a new turn. */
const startsTurn = (message: Message) =>
  isHumanMessage(message) ||
  (message.role === "user" && messageOrigin(message)?.kind === "scheduled");

/** The rail's entries: every message a person sent, theirs or another member's, never a scheduled prompt, tool row or reply. */
export function railEntries(messages: Message[]): RailEntry[] {
  const entries: RailEntry[] = [];
  let open: RailEntry | undefined;
  for (const message of messages) {
    if (startsTurn(message)) open = undefined;
    if (isHumanMessage(message)) {
      open = {
        id: message.id,
        text:
          oneLine(message.text) ||
          (message.files ?? []).map((file) => file.name).join(", ") ||
          "Message",
        at: message.createdAt,
      };
      entries.push(open);
    } else if (open && !open.reply && isConversationReply(message) && message.text.trim()) {
      open.reply = replySnippet(message.text.slice(0, REPLY_READ)) || undefined;
    }
  }
  return entries;
}

/** A tick's accessible name. The preview card is hidden from assistive tech, so this carries the words. */
export const tickName = (entry: RailEntry) => `Jump to: ${entry.text.slice(0, NAME_CHARS)}`;

/** How many ticks fit in `height`. A partial pitch does not fit one. */
export const railRoom = (height: number, pitch = RAIL_PITCH) =>
  Math.max(0, Math.floor(height / pitch));

/**
 * Which entries get ticks when not all fit: `room` of `count` in a row, always holding `anchor`, the
 * turn in view or the tick focus moved to. The window stays at `previous` while the anchor is inside it
 * with one tick to spare toward a hidden side, and otherwise moves only as far as that takes, so ticks
 * hold still under the pointer while the reader scrolls within them. Without `previous` it ends at the latest.
 */
export function railWindow(
  count: number,
  room: number,
  anchor: number,
  previous?: number,
): { start: number; end: number } {
  const size = Math.min(count, room);
  if (size <= 0) return { start: 0, end: 0 };
  const last = count - size;
  const at = Math.min(Math.max(anchor, 0), count - 1);
  const margin = size >= 3 ? 1 : 0;
  let start = Math.min(Math.max(previous ?? last, 0), last);
  if (at < start + margin) start = at - margin;
  else if (at > start + size - 1 - margin) start = at - size + 1 + margin;
  start = Math.min(Math.max(start, 0), last);
  return { start, end: start + size };
}

/** What the rail says to assistive tech about entries outside its window, or undefined when all show. */
export function railHidden(earlier: number, later: number) {
  if (!earlier && !later) return undefined;
  const total = earlier + later;
  const which =
    earlier && later
      ? `${earlier} earlier and ${later} later`
      : earlier
        ? `${earlier} earlier`
        : `${later} later`;
  return `${which} ${total === 1 ? "message is" : "messages are"} not shown. Up and Down reach them.`;
}

/** Whether the rail shows. It never covers the reading column, and needs a pointer that can hover. */
export function railShown({
  canHover,
  gutter,
  overflows,
  count,
}: {
  canHover: boolean;
  /** Space between the reading column and the frame's edge, scroll bar excluded. */
  gutter: number;
  overflows: boolean;
  count: number;
}) {
  return canHover && overflows && gutter >= RAIL_SPACE && count >= RAIL_MIN_MESSAGES;
}

/** Where an entry's message sits: its index among the entries and its top in the scrolled content. */
export type RailPlace = { index: number; offset: number };

/**
 * The entry whose turn is being read: the last message that has reached the upper third of the view,
 * or, at the end of the transcript, the last one in view. Above every message, the first one in view.
 * `places` are the entries on the page, in content order, measured once and kept until the content or
 * its size changes, so a scroll only searches them. -1 when none is.
 */
export function activeTick(
  places: readonly RailPlace[],
  scrollTop: number,
  height: number,
  atEnd: boolean,
) {
  const line = scrollTop + (atEnd ? height : Math.max(ANCHOR_GAP + 1, height / 3));
  let low = 0,
    high = places.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const offset = places[middle]!.offset;
    if (atEnd ? offset < line : offset <= line) low = middle + 1;
    else high = middle;
  }
  if (low > 0) return places[low - 1]!.index;
  const first = places[0];
  const top = first ? first.offset - scrollTop : -1;
  return first && top >= 0 && top < height ? first.index : -1;
}

/** The tick a rail key moves to. Up and Down stop at the ends rather than wrapping. */
export function railKey(key: string, index: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  const last = count - 1;
  if (key === "ArrowUp") return Math.max(0, Math.min(last, index - 1));
  if (key === "ArrowDown") return Math.min(last, Math.max(0, index + 1));
  if (key === "Home") return 0;
  if (key === "End") return last;
  return undefined;
}
