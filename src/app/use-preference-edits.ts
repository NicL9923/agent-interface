import { useRef, useState } from "react";
import type { Preferences } from "../shared/types";

/** An edit to whole preferences, applied by the session's save queue to its newest value. */
export type PreferenceEdit = (value: Preferences) => Preferences;

/**
 * Preferences that show each edit at once. The same edit goes to the session's save queue,
 * which applies it to the newest value there, including saves queued from other panels, so
 * two quick taps or two panels never undo each other.
 */
export function usePreferenceEdits(saved: Preferences, editSaved: (edit: PreferenceEdit) => Promise<void>) {
  const [pending, setPending] = useState<Preferences | null>(null);
  const current = pending ?? saved;
  const latest = useRef(current);
  latest.current = current;
  const commit = (edit: PreferenceEdit) => {
    const next = edit(latest.current);
    latest.current = next;
    setPending(next);
    void editSaved(edit).finally(() => setPending(value => value === next ? null : value));
  };
  return [current, commit] as const;
}
