import type { Message } from "../shared/types";
import { isConversationReply } from "../shared/message-origin";
import type { SavedConversation } from "./storage";
/** The assistant can still add to its reply in these states. */
const replying = new Set(["thinking", "working"]);
const SNIPPET_LENGTH = 200;
export interface ReplyWatch {
  /** The newest saved message already accounted for. Pages of older history never move it. */
  lastId?: string;
  /** A reply that arrived while the assistant was still working: its last row, and the words of the rows before it. */
  waiting?: Message;
  waitingBefore?: string[];
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
/** Streamed and saved copies of the same words separate them differently, so compare without whitespace. */
const bare = (text: string) => text.replace(/\s+/g, "");
/**
 * What is left of a reply's parts after the last run of them that spells the words already read aloud.
 * The run can be the whole reply, its tail or its head. With no such run, nothing was read and all of it is left.
 */
function afterHeard(parts: string[], heard: string): string[] {
  const words = bare(heard);
  for (let end = parts.length; end > 0; end--) {
    for (let start = 0; start < end; start++) if (bare(parts.slice(start, end).join("")) === words) return parts.slice(end);
  }
  return parts;
}
/**
 * Decides whether a refreshed conversation holds a reply to read out. Only a message after
 * the last one seen counts, so history above it, the first load and a switch stay quiet,
 * and a reply waits until the assistant stops working, so it is read once rather than as it grows.
 * A turn can save its reply as several rows, such as text, a tool call and more text, and the reply is
 * all of them, joined, including the rows of an earlier read that were still waiting. An unsaved reply
 * that was already read is not read again when saved rows replace it, however many rows they are.
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
  // The reply is every speakable saved row of the newest turn that arrived since the last read, and the rows
  // of that turn an earlier read held back while the assistant was still working. A saved row can grow in
  // place while that lasts, so the held one is read again from the conversation.
  const turnStart = messages.findLastIndex((message, index) => index <= arrivedAt && message.role === "user");
  const heldRow = watch.waiting && (messages.find(message => message.id === watch.waiting?.id) ?? watch.waiting);
  const held = heldRow && saved(heldRow) && messages.indexOf(heldRow) > turnStart ? [...watch.waitingBefore ?? [], heldRow.text] : [];
  let parts = arrived ? [...held, ...messages.slice(Math.max(known, turnStart) + 1, arrivedAt + 1).filter(message => saved(message) && speakable(message)).map(message => message.text)] : [];
  // The saved rows of a reply that was already read replace it silently, and only rows after what was read are new.
  if (!unsaved && arrived && heard && turnAt(arrivedAt) === heard.turn) {
    parts = afterHeard(parts, heard.text);
    if (!parts.length) return { watch: { lastId } };
  }
  const unread = unsaved && unsavedHeard && (unsaved.text !== heard?.text || unsavedHeard.turn !== heard.turn) ? unsaved : undefined;
  // The row that ends the reply, and the words of the rows before it.
  let last: Message | undefined, before: string[] = [];
  if (unsaved) last = unread;
  else if (arrived) { last = arrived; before = parts.slice(0, -1); }
  else { last = heldRow; before = watch.waitingBefore ?? []; }
  if (last && !replying.has(conversation.activity.state)) {
    return { watch: { lastId, heard: last === unsaved ? unsavedHeard : heard }, reply: before.length ? { ...last, text: [...before, last.text].map(part => part.trim()).join("\n\n") } : last };
  }
  return { watch: { lastId, waiting: last, waitingBefore: before.length ? before : undefined, heard } };
}
