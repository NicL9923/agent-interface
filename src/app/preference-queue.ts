import type { Preferences } from "../shared/types";

/**
 * Saves whole preferences objects one at a time. Two saves in flight could land in either
 * order and the older one would win, so each waits for the one before it. Edits apply to the
 * newest queued value, so a quick second tap builds on the first even before it is saved.
 * Only the newest save updates the screen; if it fails, the screen shows the last value the
 * server confirmed, so the next edit never builds on a save that was lost.
 */
export function preferenceQueue(options: {
  send(value: Preferences): Promise<Preferences>;
  apply(saved: Preferences): void;
  failed(error: Error): void;
  /** Changes when the signed-in account changes; nothing queued for another account survives it. */
  account(): number;
}) {
  let tail: Promise<void> = Promise.resolve();
  let newest: { value: Preferences; account: number } | null = null;
  let confirmed: { value: Preferences; account: number } | null = null;
  const save = (value: Preferences) => {
    const account = options.account();
    const current = () => options.account() === account;
    const entry = { value, account };
    newest = entry;
    const run = tail.then(async () => {
      if (!current()) return;
      try {
        const saved = await options.send(value);
        if (!current()) return;
        confirmed = { value: saved, account };
        if (newest !== entry) return;
        newest = null;
        options.apply(saved);
      } catch (error) {
        if (!current()) return;
        if (newest === entry) {
          newest = null;
          if (confirmed?.account === account) options.apply(confirmed.value);
        }
        options.failed(error as Error);
      }
    });
    tail = run;
    return run;
  };
  /** `saved` is the screen's current preferences, used when nothing is queued for this account. */
  const edit = (change: (value: Preferences) => Preferences, saved: Preferences | undefined) => {
    const latest = newest?.account === options.account() ? newest.value : saved;
    return latest ? save(change(latest)) : Promise.resolve();
  };
  return { save, edit };
}
