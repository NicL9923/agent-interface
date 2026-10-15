import type { Message } from "../shared/types";
import { isConversationReply } from "../shared/message-origin";
import type { SavedConversation } from "./storage";
/** The assistant can still add to its reply in these states. */
const replying = new Set(["thinking", "working"]);
const SNIPPET_LENGTH = 200;
export interface ReplyWatch {
  /** The newest saved message already accounted for. Pages of older history never move it. */
  lastId?: string;
  /** A reply that arrived while the assistant was still working. */
  waiting?: Message;
  /** An unsaved reply already read, or already there on load, until its saved rows arrive. */
  heard?: { text: string; turn?: string };
}
// Hermes shows the unsaved tail of a reply as a message that is replaced by saved rows with new IDs.
const saved = (message: Message) => !message.id.endsWith("-inflight");
const speakable = (message: Message) =>
  isConversationReply(message) && !!message.text.trim();
/** Markdown read aloud as written would spell out its symbols, so keep only the words. */
export function replySnippet(text: string) {
  const plain = text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1\s*$/gm, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, " ")
    .replace(/[`*_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > SNIPPET_LENGTH ? `${plain.slice(0, SNIPPET_LENGTH).trimEnd()}…` : plain;
}
/**
 * Decides whether a refreshed conversation holds a reply to read out. Only a message after
 * the last one seen counts, so history above it, the first load and a switch stay quiet,
 * and a reply waits until the assistant stops working, so it is read once rather than as it grows.
 * An unsaved reply that was already read is not read again when saved rows replace it.
 */
export function watchReplies(watch: ReplyWatch, conversation: SavedConversation, baseline: boolean): { watch: ReplyWatch; reply?: Message } {
  const { messages } = conversation;
  // A turn is named by the prompt that opened it, so a repeat of the same words in a later turn is new.
  const turnAt = (index: number) => messages.slice(0, index + 1).findLast(message => message.role === "user")?.id;
  const tail = messages.at(-1);
  const unsaved = tail && !saved(tail) && speakable(tail) ? tail : undefined;
  const unsavedHeard = unsaved && { text: unsaved.text, turn: turnAt(messages.length - 1) };
  const lastId = messages.findLast(saved)?.id;
  const known = watch.lastId === undefined ? -1 : messages.findIndex(message => message.id === watch.lastId);
  // A conversation that no longer contains the last message seen was replaced, not extended.
  if (baseline || watch.lastId !== undefined && known < 0) return { watch: { lastId, heard: unsavedHeard } };
  const arrivedAt = messages.findLastIndex((message, index) => index > known && saved(message) && speakable(message));
  const arrived = messages[arrivedAt];
  const heard = watch.heard;
  // The saved rows of a reply that was already read replace it silently.
  if (!unsaved && arrived && heard && arrived.text.trim() === heard.text.trim() && turnAt(arrivedAt) === heard.turn) {
    return { watch: { lastId } };
  }
  const unread = unsaved && unsavedHeard && (unsaved.text !== heard?.text || unsavedHeard.turn !== heard.turn) ? unsaved : undefined;
  const latest = unsaved ? unread : arrived;
  const reply = latest ?? (unsaved ? undefined : messages.find(message => message.id === watch.waiting?.id) ?? watch.waiting);
  if (reply && !replying.has(conversation.activity.state)) return { watch: { lastId, heard: reply === unsaved ? unsavedHeard : heard }, reply };
  return { watch: { lastId, waiting: reply, heard } };
}
