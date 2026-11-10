import { useEffect, useState, type RefObject } from "react";

/**
 * Closes the open panel the way its own close button does, for something outside it that needs it
 * gone, such as a notification tapped while the app is open. A form with unsaved work asks first.
 * The panel calls its onClose once it has closed, or `onStay` instead if the person keeps it open.
 */
export type CloseRequest = (onStay: () => void) => void;
/** A mounted sheet's close, and which mount of the sheet offers it. */
export type SheetClose = { close: CloseRequest; sheet: object };

/** Offers this panel's close on `closer` while the panel is mounted. Panels without one close at once. */
export function useCloseRequest(closer: RefObject<SheetClose | null> | undefined, close: CloseRequest) {
  // One per mount: a sheet opened again is another sheet.
  const [sheet] = useState(() => ({}));
  useEffect(() => {
    if (!closer) return;
    closer.current = { close, sheet };
    return () => { if (closer.current?.sheet === sheet) closer.current = null; };
  });
}

/**
 * Something waiting for a sheet to close, such as the chat a notification named over an edited form.
 * It belongs to that mount of the sheet and to the account it was raised for. Only that sheet's own
 * close, for the same account, takes it: a sheet taken away some other way, such as by a sign-in as
 * someone else, leaves it to be dropped by the next sheet's close, which finds nothing.
 */
export function waitingOnClose<T>() {
  let waiting: { value: T; sheet: object; account: string | undefined } | null = null;
  return {
    /** Waits on `sheet`. Returns what cancels this wait, and only this one. */
    wait(value: T, sheet: object, account: string | undefined) {
      const entry = { value, sheet, account };
      waiting = entry;
      return () => { if (waiting === entry) waiting = null; };
    },
    /** A sheet closed: what waited on it for this account, if anything. Nothing waits after. */
    take(sheet: object | undefined, account: string | undefined) {
      const entry = waiting;
      waiting = null;
      return entry && entry.sheet === sheet && entry.account === account ? entry.value : null;
    },
  };
}
