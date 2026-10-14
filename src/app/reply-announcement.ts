import type { Message } from "../shared/types";
import { isAgentExchange } from "../components/AgentExchange";
import type { SavedConversation } from "./storage";
/** The assistant can still add to its reply in these states. */
const replying = new Set(["thinking", "working"]);
const SNIPPET_LENGTH = 200;
export interface ReplyWatch {
  /** The newest message already accounted for. Pages of older history never move it. */
  lastId?: string;
  /** A reply that arrived while the assistant was still working. */
  waiting?: Message;
}
const speakable = (message: Message) =>
  message.role === "assistant" && !!message.text.trim() && !isAgentExchange(message);
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
 */
export function watchReplies(watch: ReplyWatch, conversation: SavedConversation, baseline: boolean): { watch: ReplyWatch; reply?: Message } {
  const { messages } = conversation;
  const lastId = messages.at(-1)?.id;
  const known = watch.lastId === undefined ? -1 : messages.findIndex(message => message.id === watch.lastId);
  // A conversation that no longer contains the last message seen was replaced, not extended.
  if (baseline || watch.lastId !== undefined && known < 0) return { watch: { lastId } };
  const latest = messages.slice(known + 1).findLast(speakable);
  const reply = latest ?? messages.find(message => message.id === watch.waiting?.id) ?? watch.waiting;
  if (reply && !replying.has(conversation.activity.state)) return { watch: { lastId }, reply };
  return { watch: { lastId, waiting: reply } };
}
