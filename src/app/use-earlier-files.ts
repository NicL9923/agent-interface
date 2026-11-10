import { useEffect, useState } from "react";
import { request } from "../client-api";
import { onAccountEnd } from "./account-epoch";
import type { EarlierFiles } from "../shared/history";

type Entry = { messages?: EarlierFiles["messages"]; failed?: boolean };
// One read per assistant, session and window start, shared by the reply chips and the Artifacts panel
// so both attribute files from the same history. A few windows are kept; older ones are read again.
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
const keep = 8;
// Keyed by chat and session, which a shared assistant's next account could share.
onAccountEnd(() => cache.clear());
const none: EarlierFiles["messages"] = [];

/**
 * The file-bearing messages before a conversation window, for a window that starts after the
 * beginning. `wanted` false reads nothing. `retry` reads again after a failure, as reopening the
 * panel does. The result names the window it is for, so a stale answer never reaches another.
 */
export function useEarlierFiles(botId: string, window: { sessionId?: string; messages: { id: string }[]; earlier?: number; earlierFiles?: number } | null | undefined,
  wanted: boolean, retry = false) {
  const needed = !!window && ((window.earlier ?? 0) > 0 || (window.earlierFiles ?? 0) > 0);
  const key = needed && wanted ? `${botId}\n${window.sessionId ?? ""}\n${window.messages[0]?.id ?? ""}` : undefined;
  const [, changed] = useState(0);
  useEffect(() => {
    const listener = () => changed(value => value + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  useEffect(() => {
    if (!key) return;
    const known = cache.get(key);
    if (known && !(known.failed && retry)) return;
    const entry: Entry = {};
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > keep) cache.delete(cache.keys().next().value!);
    const before = window!.messages[0]?.id;
    request("GET /bots/:id/files", { params: { id: botId }, query: { before } })
      .then(value => { entry.messages = value.messages; }, () => { entry.failed = true; })
      .then(() => { for (const listener of listeners) listener(); });
  }, [key, retry]);
  const entry = key ? cache.get(key) : undefined;
  return { needed, messages: needed ? entry?.messages : none, loading: !!key && !entry?.messages && !entry?.failed, failed: !!entry?.failed };
}
