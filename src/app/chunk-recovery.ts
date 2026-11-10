import { useEffect, useRef } from "react";
import { draftKey, groupSendPrefix, localRead, sameDraft, submissionPrefix, type Draft } from "./storage";

/**
 * In sessionStorage: when this tab last reloaded itself over a missing bundle. A reload keeps it,
 * so the guard below holds across the reload it causes; another tab starts without one.
 */
export const CHUNK_RELOAD_KEY = "agent-interface:chunk-reload";
/** One automatic reload per tab in this long. Another failure within it shows the screen's Reload prompt. */
export const CHUNK_RELOAD_WINDOW_MS = 5 * 60_000;

/** A send that has not settled, from any chat or group, as storage keeps it across a reload. */
function sendPending() {
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index) ?? "";
    if (key.startsWith(submissionPrefix) || key.startsWith(groupSendPrefix) && !key.endsWith(":draft")) return true;
  }
  return false;
}

/**
 * Reloads once when a lazy screen's bundle cannot load, which Vite reports as `vite:preloadError`.
 * A tab left open across a deploy asks for the files of the release it started with, and the server
 * has the new release's, so a reload moves the tab to it. The error still reaches the screen, which
 * shows its own Reload prompt; that is what stays when this does not reload.
 *
 * It does not reload while `canReload` says the page holds work a reload would lose, or while a send
 * is on its way, and never twice within CHUNK_RELOAD_WINDOW_MS. Storage that cannot be read or
 * written means the guard cannot hold, so there is no automatic reload at all.
 */
export function useChunkRecovery(canReload: () => boolean) {
  const allowed = useRef(canReload);
  allowed.current = canReload;
  useEffect(() => {
    const recover = () => {
      try {
        if (!allowed.current() || sendPending()) return;
        const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY));
        // A time ahead of the clock also counts as recent.
        if (Date.now() - last < CHUNK_RELOAD_WINDOW_MS) return;
        sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
      } catch { return; }
      location.reload();
    };
    window.addEventListener("vite:preloadError", recover);
    return () => window.removeEventListener("vite:preloadError", recover);
  }, []);
}

/**
 * Whether a reload would bring this chat draft back. Drafts are written to the device on every edit,
 * so only an empty draft, or one the device holds the same copy of, counts. Full or blocked storage
 * leaves the copies apart.
 */
export function draftKept(draft: Draft, userId = draft.userId, botId = draft.botId) {
  if (!draft.text && !draft.attachments.length) return true;
  if (!userId || !botId) return false;
  const saved = localRead<Draft>(draftKey(userId, botId));
  return !!saved && sameDraft(saved, draft);
}
