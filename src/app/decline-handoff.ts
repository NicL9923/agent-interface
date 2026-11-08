import { useSyncExternalStore } from "react";

/**
 * The approval this person just declined in a chat. Until they send their next message there, the
 * transcript says the assistant stopped that step and the composer asks what to do instead.
 * Held in memory for this tab only: it is a prompt for the next message, never a record.
 */
const declined = new Map<string, string>();
const listeners = new Set<() => void>();
const publish = () => { for (const listener of listeners) listener(); };

export function rememberDecline(botId: string, approvalId: string) {
  declined.set(botId, approvalId);
  publish();
}
export function clearDecline(botId: string) {
  if (declined.delete(botId)) publish();
}
/** The approval declined in this chat, awaiting the person's next message. */
export function useDeclined(botId: string) {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => declined.get(botId));
}
