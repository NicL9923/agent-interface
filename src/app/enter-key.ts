import { useSyncExternalStore } from "react";
import { imeKey } from "./ime";

/**
 * What Enter does in a message box, decided by the device's pointers alone and never remembered:
 * - With a mouse or trackpad (`any-pointer: fine`), with no touch screen (no `any-pointer: coarse`),
 *   or where the browser cannot answer a media query, Enter sends and Shift+Enter starts a new line.
 * - On a device whose only pointer is coarse, a phone or tablet, Return starts a new line and the
 *   Send button sends, so a person can write more than one line on an on-screen keyboard.
 * - Everywhere, Ctrl+Enter and Cmd+Enter send.
 *
 * No browser reports a hardware keyboard, and no key proves one: iOS fires Shift and Caps Lock key
 * events from its on-screen keyboard (WebKit bug 191475), Android lets an input method send hardware
 * key events, and third-party keyboards send Tab, Escape and Ctrl. So a tablet with a keyboard and no
 * trackpad gets a new line from Enter, and sends with Ctrl+Enter, Cmd+Enter or the Send button.
 */
const media = (query: string) => typeof matchMedia === "function" ? matchMedia(query) : undefined;

/** Whether plain Enter sends on this device. Where the browser cannot say, it does, as on a computer. */
export function enterSends() {
  const coarse = media("(any-pointer: coarse)"), fine = media("(any-pointer: fine)");
  if (!coarse || !fine) return true;
  return !coarse.matches || fine.matches;
}

/**
 * Whether a key press in a message box sends it: Ctrl+Enter or Cmd+Enter always, and Enter without
 * Shift where `enterSends`. A key an input method is using, such as the Enter that confirms a word,
 * never sends.
 */
export function sendsOnKey(event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "isComposing" | "keyCode">, enterSends: boolean) {
  if (event.key !== "Enter" || imeKey(event)) return false;
  return event.ctrlKey || event.metaKey || (enterSends && !event.shiftKey);
}

function subscribe(listener: () => void) {
  // Connecting or removing a trackpad keyboard changes the answer while the page is open.
  const queries = ["(any-pointer: coarse)", "(any-pointer: fine)"].map(media);
  for (const query of queries) query?.addEventListener?.("change", listener);
  return () => { for (const query of queries) query?.removeEventListener?.("change", listener); };
}

/** Whether plain Enter sends in a message box, updated as a pointer appears or leaves. */
export function useEnterSends() {
  return useSyncExternalStore(subscribe, enterSends, () => true);
}
