import type { FileRef, Message } from "./types";
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
const fileIds = (messages: Message[]) => new Set(messages.flatMap(message => message.files ?? []).map(file => file.id));
/**
 * A window's share of the conversation's signed file references: all but those
 * only the `earlier` messages before it carry, which the client fetches on demand.
 */
export function windowFiles(messages: Message[], earlier: number, files: FileRef[]) {
  const shown = fileIds(messages.slice(earlier)), before = fileIds(messages.slice(0, earlier));
  for (const id of shown) before.delete(id);
  return { files: files.filter(file => !before.has(file.id)), earlierFiles: before.size };
}
export type EarlierFiles = { messages: Pick<Message, "id" | "role" | "files">[] };
/** The file-bearing messages before `before`, or in the whole history once it is gone, reduced to their files. */
export function filesBefore(messages: Message[], before?: string): EarlierFiles {
  const end = before ? messages.findIndex(message => message.id === before) : -1;
  return { messages: messages.slice(0, end < 0 ? messages.length : end).filter(message => message.files?.length)
    .map(({ id, role, files }) => ({ id, role, files })) };
}
