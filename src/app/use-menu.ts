import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

/**
 * A small home-bar menu: the first item takes focus on open, arrows, Home and End move between
 * items, Escape closes and returns focus to the trigger, Tab or a press outside closes it.
 */
export function useMenu<Wrap extends HTMLElement = HTMLSpanElement>() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<Wrap>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)")?.focus();
    const away = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const close = useCallback((focus: boolean) => { setOpen(false); if (focus) trigger.current?.focus(); }, []);
  const keys = useCallback((event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") { setOpen(false); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !wrap.current) return;
    event.preventDefault();
    const items = [...wrap.current.querySelectorAll<HTMLElement>("[role='menuitem']:not(:disabled)")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }, [close]);
  /**
   * Closes the menu, then runs what the item does. Focus goes back to the trigger first, so a dialog the
   * item opens returns focus there when it closes, not to the item that is gone.
   */
  const choose = useCallback((run: () => void) => { setOpen(false); trigger.current?.focus(); run(); }, []);
  return { open, setOpen, wrap, trigger, menuId, keys, close, choose };
}
