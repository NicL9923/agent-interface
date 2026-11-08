import type { Preferences } from "../shared/types";

/**
 * Saves whole preferences objects one at a time. Two saves in flight could land in either
 * order and the older one would win, so each waits for the one before it. Edits apply to the
 * newest queued value, so a quick second tap builds on the first even before it is saved.
 *
 * Every saved answer goes on screen, so the screen always holds what the server last confirmed
 * and a failed save leaves nothing to recover. A bootstrap read that overlapped a save may hold
 * older preferences; `fresh` tells the session whether to take its copy.
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
  // Counts saves starting and settling, so a read can tell whether one overlapped it.
  let generation = 0;
  let saving = 0;
  const save = (value: Preferences) => {
    const account = options.account();
    const current = () => options.account() === account;
    const entry = { value, account };
    newest = entry;
    generation++;
    saving++;
    const run = tail.then(async () => {
      if (!current()) return;
      try {
        const saved = await options.send(value);
        if (!current()) return;
        if (newest === entry) newest = null;
        options.apply(saved);
      } catch (error) {
        if (!current()) return;
        if (newest === entry) newest = null;
        options.failed(error as Error);
      }
    }).finally(() => { saving--; generation++; });
    tail = run;
    return run;
  };
  /** `saved` is the screen's current preferences, used when nothing is queued for this account. */
  const edit = (change: (value: Preferences) => Preferences, saved: Preferences | undefined) => {
    const latest = newest?.account === options.account() ? newest.value : saved;
    return latest ? save(change(latest)) : Promise.resolve();
  };
  /** Taken when a read starts; `fresh` is true only if no save was running or ran since. */
  const mark = () => saving ? -1 : generation;
  const fresh = (marked: number) => marked === generation && !saving;
  return { save, edit, mark, fresh };
}
