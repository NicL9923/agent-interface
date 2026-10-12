import type { Message } from "./types";
/** Turns the web client opens with and adds each time the reader reaches the top. */
export const HISTORY_PAGE_TURNS = 20;
export const MAX_HISTORY_TURNS = 500;
/**
 * The newest part of a conversation, cut only where a prompt starts a turn so no
 * reply is shown without the prompt it answers. `start` keeps a loaded window from
 * sliding as new turns arrive, and `turns` adds that many turns before it. A start
 * that is no longer in the history falls back to the latest page.
 */
export function historyWindow(messages: Message[], { start, turns = 0 }: { start?: string; turns?: number }) {
  let end = start ? messages.findIndex(message => message.id === start) : -1;
  if (end < 0) {
    end = messages.length;
    turns = Math.max(turns, HISTORY_PAGE_TURNS);
  }
  let from = end;
  while (from > 0 && turns > 0) if (messages[--from].role === "user") turns--;
  return { messages: messages.slice(from), earlier: from };
}
