import { useEffect, useRef } from "react";

/**
 * Keyboard shortcuts in one place: the help dialog, palette hints and tooltips read the same
 * table the listener matches against, so a binding cannot drift from what the app says it is.
 */
export type ShortcutId = "palette" | "pinned" | "stop" | "help" | "find" | "undo";
export type Combo = {
  /** `event.key`, compared case-insensitively. "1-9" matches any digit 1 to 9. */
  key: string;
  /** Command on Apple platforms, Control elsewhere. */
  mod?: boolean;
  /** Also fires while typing in a field. Others leave typing alone. */
  inFields?: boolean;
};
export type ShortcutInfo = Combo & { label: string; /** Listed in help but bound elsewhere. */ external?: boolean };

export const shortcuts: Record<ShortcutId, ShortcutInfo> = {
  palette: { key: "k", mod: true, inFields: true, label: "Open the command palette" },
  pinned: { key: "1-9", mod: true, inFields: true, label: "Open a pinned assistant" },
  stop: { key: ".", mod: true, inFields: true, label: "Stop the current response" },
  find: { key: "f", mod: true, inFields: true, label: "Find in this chat", external: true },
  undo: { key: "z", mod: true, label: "Undo the last home change while its notice shows" },
  help: { key: "?", label: "Show keyboard shortcuts" },
};

export const applePlatform = () => typeof navigator !== "undefined"
  && /Mac|iPhone|iPad|iPod/.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent);

/** How a shortcut reads on this platform: ⌘K on a Mac, Ctrl+K elsewhere. */
export function formatCombo(combo: Combo, apple = applePlatform()) {
  const key = combo.key === "1-9" ? "1–9" : combo.key.length === 1 ? combo.key.toUpperCase() : combo.key;
  if (!combo.mod) return key;
  return apple ? `⌘${key}` : `Ctrl+${key}`;
}

/** Text fields, selects and editable regions, where plain keys belong to the person typing. */
export function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"].includes(target.type);
}

type KeyEventLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target" | "isComposing">;

/**
 * Whether a key event is this combo, and the digit for "1-9". Digits also match by physical key,
 * so layouts that need Shift for a digit still work. `?` ignores Shift, which typing it needs.
 */
export function matchCombo(event: KeyEventLike, combo: Combo, apple = applePlatform()): false | { digit?: number } {
  if (event.isComposing || event.altKey) return false;
  const mod = apple ? event.metaKey : event.ctrlKey;
  const otherMod = apple ? event.ctrlKey : event.metaKey;
  if (!!combo.mod !== mod || otherMod) return false;
  if (!combo.inFields && isTypingTarget(event.target)) return false;
  if (combo.key === "1-9") {
    const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : /^Digit[1-9]$/.test(event.code) ? Number(event.code.slice(5)) : 0;
    return digit ? { digit } : false;
  }
  if (combo.key !== "?" && event.shiftKey) return false;
  return event.key.toLowerCase() === combo.key ? {} : false;
}

export type ShortcutHandlers = Partial<Record<ShortcutId, (match: { digit?: number }) => boolean | void>>;

/**
 * One window listener for the app's shortcuts. A handler returning false declines, so the key
 * keeps its normal meaning, such as Cmd+Z undoing typing when no undo notice shows.
 * Modal dialogs other than the palette own the keyboard, so shortcuts wait until they close.
 */
export function useShortcuts(handlers: ShortcutHandlers) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (document.querySelector("dialog[open]:not(.command-palette)")) return;
      for (const id of Object.keys(shortcuts) as ShortcutId[]) {
        const handler = latest.current[id];
        const info = shortcuts[id];
        if (!handler || info.external) continue;
        const match = matchCombo(event, info);
        if (!match) continue;
        if (handler(match) === false) return;
        event.preventDefault();
        return;
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
