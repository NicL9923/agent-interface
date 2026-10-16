import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ComponentProps, RefObject } from "react";
import { OverlayContainerContext } from "../../lib/overlay-container";

export type DialogFocusTarget = string | HTMLElement | RefObject<HTMLElement | null> | (() => HTMLElement | null);
export type DialogProps = Omit<ComponentProps<"dialog">, "open"> & {
  /** Defaults to open for conditionally mounted sheets. False keeps contents mounted. */
  open?: boolean;
  initialFocus?: DialogFocusTarget;
  fallbackFocus?: DialogFocusTarget;
};

function target(value: DialogFocusTarget | undefined, scope: ParentNode): HTMLElement | null {
  if (typeof value === "string") return scope.querySelector<HTMLElement>(value);
  if (typeof value === "function") return value();
  if (value && "current" in value) return value.current;
  return value ?? null;
}

function usable(element: HTMLElement | null): element is HTMLElement {
  return !!element?.isConnected && element !== element.ownerDocument.body && !element.closest("[inert], [hidden], [aria-hidden='true']") && !element.matches(":disabled");
}

function focus(element: HTMLElement | null) {
  if (!usable(element)) return;
  const needsTabIndex = element.tabIndex < 0 && !element.hasAttribute("tabindex");
  if (needsTabIndex) element.setAttribute("tabindex", "-1");
  element.focus({ preventScroll: true });
  if (needsTabIndex) element.removeAttribute("tabindex");
}

/** Native top-layer dialog, with one lifecycle for mounted and persistent sheets. */
export const Dialog = forwardRef<HTMLDialogElement, DialogProps>(function Dialog({
  open = true, initialFocus, fallbackFocus, onClose, children, ...props
}, ref) {
  const [element, setElement] = useState<HTMLDialogElement | null>(null);
  const previous = useRef<HTMLElement | null>(null);
  const options = useRef({ initialFocus, fallbackFocus });
  options.current = { initialFocus, fallbackFocus };
  useImperativeHandle(ref, () => element!, [element]);

  function restoreFocus(dialog: HTMLDialogElement) {
    const document = dialog.ownerDocument;
    const remaining = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).filter(item => item !== dialog).at(-1);
    const requested = previous.current;
    const allowed = usable(requested) && (!remaining || remaining.contains(requested));
    const fallback = target(options.current.fallbackFocus, remaining ?? document);
    if (allowed) focus(requested);
    else if (usable(fallback) && (!remaining || remaining.contains(fallback))) focus(fallback);
    else focus(remaining ?? document.querySelector<HTMLElement>("main, [role='main']"));
    previous.current = null;
  }

  useEffect(() => {
    if (!element) return;
    if (!open) {
      if (element.open) { element.close(); restoreFocus(element); }
      return;
    }
    if (!element.open) {
      previous.current = element.ownerDocument.activeElement instanceof HTMLElement ? element.ownerDocument.activeElement : null;
      element.showModal();
      focus(target(options.current.initialFocus, element));
    }
    return () => {
      if (element.open) element.close();
      if (previous.current) restoreFocus(element);
    };
  }, [element, open]);

  return <OverlayContainerContext value={element}>
    <dialog {...props} ref={setElement} onClose={event => {
      // StrictMode can queue close before immediately reopening the same node.
      if (event.currentTarget.open) return;
      onClose?.(event);
      // A guarded editor may reopen after a noncancelable native dismissal.
      if (event.currentTarget.open) return;
      if (previous.current) restoreFocus(event.currentTarget);
    }}>{children}</dialog>
  </OverlayContainerContext>;
});
