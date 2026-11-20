import type { Message } from "../shared/types";
import { isConversationReply, messageOrigin } from "../shared/message-origin";
import { isReactionMessage } from "../shared/reactions";
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

/**
 * The rail's entries: every message a person sent, theirs or another member's, never a scheduled prompt,
 * tool row or reply. A reaction, one emoji of the set, is a tap rather than a question to find again, so
 * it gets no tick either; the turn it would start still ends the tick before it.
 */
export function railEntries(messages: Message[]): RailEntry[] {
  const entries: RailEntry[] = [];
  let open: RailEntry | undefined;
  for (const message of messages) {
    if (startsTurn(message)) open = undefined;
    if (isReactionMessage(message)) continue;
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

/** The most recent entries whose ticks fit in `height`, oldest first. */
export function fitTicks<T>(entries: T[], height: number, pitch = RAIL_PITCH): T[] {
  const room = Math.floor(Math.max(0, height) / pitch);
  return room > 0 ? entries.slice(-room) : [];
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

/**
 * The entry whose turn is being read: the last message that has reached the upper third of the view,
 * or, at the end of the transcript, the last one in view. Above every message, the first one in view.
 * `tops` are each message's top relative to the view's top, undefined for one not on the page.
 */
export function activeTick(tops: (number | undefined)[], height: number, atEnd: boolean) {
  const line = atEnd ? height : Math.max(ANCHOR_GAP + 1, height / 3);
  let active = -1;
  tops.forEach((top, index) => {
    if (top !== undefined && (atEnd ? top < line : top <= line)) active = index;
  });
  if (active >= 0) return active;
  return tops.findIndex((top) => top !== undefined && top >= 0 && top < height);
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
