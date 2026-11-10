import { useSyncExternalStore } from "react";
import type { AttentionRequest, Conversation } from "../shared/types";
import { onAccountEnd } from "./account-epoch";

/**
 * Whether a message this person sends closes the request, so the assistant reads it instead.
 * Hermes leaves a login the assistant asked for by address with the member whose task asked;
 * anyone else's message waits until they answer or cancel it. See src/hermes/vault.py close_for_chat.
 */
export function messageCloses(request: AttentionRequest, userId: string) {
  if (request.kind === "official") return false;
  const requester = request.secure?.method === "vault.save_login" ? request.secure.explicit?.requestedBy : undefined;
  return !requester || requester.id === userId;
}

/** The composer's placeholder while the assistant waits on a request, or undefined when it doesn't. */
export function waitingPlaceholder(conversation: Conversation | undefined | null, userId: string) {
  if (conversation?.activity.state !== "blocked") return undefined;
  const requests = conversation.attention ?? [];
  if (requests.some(request => messageCloses(request, userId))) return "Or reply here instead…";
  const owner = requests.map(request => request.secure?.method === "vault.save_login" ? request.secure.explicit?.requestedBy : undefined).find(Boolean);
  return owner ? `Your message waits for ${owner.name ?? "the person who asked"}…` : undefined;
}

/**
 * A request this tab just settled, shown as one line after Hermes stops listing it, so the
 * outcome stays visible a moment instead of vanishing with the card. Never holds entered values.
 */
export interface SettledRequest { botId: string; requestId: string; text: string; until: number }
const settled = new Map<string, SettledRequest>();
const listeners = new Set<() => void>();
let snapshot: SettledRequest[] = [];
const publish = () => { snapshot = [...settled.values()]; for (const listener of listeners) listener(); };
onAccountEnd(() => { settled.clear(); publish(); });
/** How long a receipt stays after it settles, if Hermes already stopped listing the request. */
export const RECEIPT_MS = 2500;

export function rememberSettled(botId: string, requestId: string, text: string) {
  const key = `${botId}\n${requestId}`;
  settled.set(key, { botId, requestId, text, until: Date.now() + RECEIPT_MS });
  publish();
  setTimeout(() => {
    if ((settled.get(key)?.until ?? Infinity) <= Date.now()) { settled.delete(key); publish(); }
  }, RECEIPT_MS + 50);
}

export function useSettledRequests(botId: string) {
  const all = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
  return all.filter(item => item.botId === botId);
}
