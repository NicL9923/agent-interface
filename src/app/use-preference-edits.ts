import { useRef, useState } from "react";
import type { Preferences } from "../shared/types";

/**
 * Preferences that show each edit at once. Every edit applies to the newest value,
 * including edits still saving, so two quick taps never undo each other. A failed
 * save falls back to what the server last confirmed.
 */
export function usePreferenceEdits(saved: Preferences, save: (value: Preferences) => Promise<void>) {
  const [pending, setPending] = useState<Preferences | null>(null);
  const current = pending ?? saved;
  const latest = useRef(current);
  latest.current = current;
  const commit = (edit: (value: Preferences) => Preferences) => {
    const next = edit(latest.current);
    latest.current = next;
    setPending(next);
    void save(next).finally(() => setPending(value => value === next ? null : value));
  };
  return [current, commit] as const;
}
