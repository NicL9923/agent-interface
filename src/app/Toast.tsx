import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { formatCombo, shortcuts } from "./shortcuts";
import "./shell.css";

export const TOAST_MS = 5000;
export type ToastValue = { id: number; message: string; undo?: () => void };

/**
 * One short-lived notice at a time, with an optional Undo. The timer pauses while the pointer or
 * keyboard focus is on the toast, so nobody loses it while reaching for the button.
 */
export function useToast() {
  const [toast, setToast] = useState<ToastValue | null>(null);
  const next = useRef(0);
  const show = useCallback((message: string, undo?: () => void) => setToast({ id: ++next.current, message, undo }), []);
  const dismiss = useCallback(() => setToast(null), []);
  /** Runs the shown toast's undo once. False when nothing can be undone. */
  const undo = useCallback(() => {
    if (!toast?.undo) return false;
    toast.undo();
    setToast(null);
    return true;
  }, [toast]);
  return { toast, show, dismiss, undo };
}

export function Toast({ toast, onDismiss, onUndo }: { toast: ToastValue | null; onDismiss(): void; onUndo(): void }) {
  const [paused, setPaused] = useState(false);
  const hovered = useRef(false), focused = useRef(false);
  const settle = () => setPaused(hovered.current || focused.current);
  useEffect(() => {
    if (!toast || paused) return;
    const timer = setTimeout(onDismiss, TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast, paused, onDismiss]);
  useEffect(() => { hovered.current = focused.current = false; setPaused(false); }, [toast?.id]);
  // The region stays mounted, so screen readers already watch it when a message arrives.
  return <div className="toast-region" role="status" aria-live="polite">
    {toast && <div key={toast.id} className="toast"
      onPointerEnter={() => { hovered.current = true; settle(); }} onPointerLeave={() => { hovered.current = false; settle(); }}
      onFocus={() => { focused.current = true; settle(); }} onBlur={() => { focused.current = false; settle(); }}>
      <span>{toast.message}</span>
      {toast.undo && <button type="button" className="toast-undo" title={`Undo (${formatCombo(shortcuts.undo)})`} onClick={onUndo}>
        <Icon name="undo" size={15} />Undo
      </button>}
      <button type="button" className="icon-button toast-close" aria-label="Dismiss" onClick={onDismiss}><Icon name="close" size={14} /></button>
    </div>}
  </div>;
}
