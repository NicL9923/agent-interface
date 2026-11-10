import { useSyncExternalStore } from "react";

/**
 * What Return does in a message box. With a hardware keyboard, Enter sends and Shift+Enter starts a
 * new line. On a touch screen with only an on-screen keyboard, Return starts a new line and the
 * Send button sends, so a phone can write more than one line.
 *
 * No browser reports a hardware keyboard, so two signals stand in for one:
 * - A mouse or trackpad (`any-pointer: fine`) means a computer, a touch-screen laptop, or a tablet
 *   with a trackpad keyboard, where a keyboard is plausibly at hand. A computer with no pointer at
 *   all (`any-pointer: none`) is driven by its keyboard. Both keep Enter sending.
 * - Only a device whose sole pointer is coarse, a phone or tablet, starts with Return as a new line,
 *   until this tab sees a key no on-screen keyboard sends: a lone modifier, Tab, Escape, a function
 *   key, or a Ctrl or Cmd chord. A tablet with a keyboard but no trackpad shows one at its first
 *   capital letter or shortcut.
 */
const SEEN = "agent-interface:hardware-keyboard";
const HARDWARE_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab", "Escape"]);

/** Whether a key press could only have come from a hardware keyboard. */
export function hardwareKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey">) {
  return HARDWARE_KEYS.has(event.key) || /^F\d{1,2}$/.test(event.key) || event.ctrlKey || event.metaKey;
}

const seen = () => { try { return sessionStorage.getItem(SEEN) === "1"; } catch { return false; } };
const media = (query: string) => typeof matchMedia === "function" ? matchMedia(query) : undefined;

/** Whether Enter sends here. Where the browser cannot say, it does, as on a computer. */
export function enterSends() {
  const coarse = media("(any-pointer: coarse)"), fine = media("(any-pointer: fine)");
  if (!coarse || !fine) return true;
  return !coarse.matches || fine.matches || seen();
}

const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const noteKey = (event: KeyboardEvent) => {
  if (!hardwareKey(event) || seen()) return;
  try { sessionStorage.setItem(SEEN, "1"); } catch { /* Private browsing can refuse storage; the next key tries again. */ }
  notify();
};
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener("keydown", noteKey, true);
  listeners.add(listener);
  // Attaching or removing a trackpad keyboard changes the answer while the page is open.
  const queries = ["(any-pointer: coarse)", "(any-pointer: fine)"].map(media);
  for (const query of queries) query?.addEventListener?.("change", listener);
  return () => {
    for (const query of queries) query?.removeEventListener?.("change", listener);
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("keydown", noteKey, true);
  };
}

/** Whether Enter sends in a message box, updated as a keyboard or pointer appears. */
export function useEnterSends() {
  return useSyncExternalStore(subscribe, enterSends, () => true);
}
