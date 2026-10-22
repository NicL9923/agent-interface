import type { Preferences } from "../shared/types";

/**
 * Saves whole preferences objects one at a time. Two saves in flight could land in either
 * order and the older one would win, so each waits for the one before it, and only the
 * newest queued value is applied once saved. Edits apply to that newest value, so a quick
 * second tap builds on the first even before it is saved.
 */
export function preferenceQueue(options: {
  send(value: Preferences): Promise<Preferences>;
  apply(saved: Preferences): void;
  failed(error: Error): void;
  /** Changes when the signed-in account changes; a save queued for another account does nothing. */
  account(): number;
}) {
  let tail: Promise<void> = Promise.resolve();
  let newest: Preferences | null = null;
  const save = (value: Preferences) => {
    const account = options.account();
    const current = () => options.account() === account;
    newest = value;
    const run = tail.then(async () => {
      if (!current()) return;
      try {
        const saved = await options.send(value);
        if (!current() || newest !== value) return;
        newest = null;
        options.apply(saved);
      } catch (error) {
        if (!current()) return;
        if (newest === value) newest = null;
        options.failed(error as Error);
      }
    });
    tail = run;
    return run;
  };
  const edit = (change: (value: Preferences) => Preferences, saved: Preferences | undefined) => {
    const latest = newest ?? saved;
    return latest ? save(change(latest)) : Promise.resolve();
  };
  return { save, edit };
}
