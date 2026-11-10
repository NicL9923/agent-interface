import { useEffect, type RefObject } from "react";

/**
 * Closes the open panel the way its own close button does, for something outside it that needs it
 * gone, such as a notification tapped while the app is open. A form with unsaved work asks first.
 * The panel calls its onClose once it has closed, or `onStay` instead if the person keeps it open.
 */
export type CloseRequest = (onStay: () => void) => void;

/** Offers this panel's close on `closer` while the panel is mounted. Panels without one close at once. */
export function useCloseRequest(closer: RefObject<CloseRequest | null> | undefined, close: CloseRequest) {
  useEffect(() => {
    if (!closer) return;
    closer.current = close;
    return () => { if (closer.current === close) closer.current = null; };
  });
}
