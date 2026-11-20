import type { Preferences } from "../shared/types";

/**
 * Saves whole preferences objects one at a time. Two saves in flight could land in either
 * order and the older one would win, so each waits for the one before it. Edits apply to the
 * newest queued value, so a quick second tap builds on the first even before it is saved.
 *
 * Every saved answer goes on screen, so the screen always holds what the server last confirmed
 * and a failed save leaves nothing to recover. A bootstrap read that overlapped a save may hold
 * older preferences; `fresh` tells the session whether to take its copy.
 *
 * The chat style choices are the exception to "whole": a save carries one only when the edit behind
 * it changed it. The server keeps a choice a save leaves out, and this tab's copy may be older than
 * a choice made since on another device, which a whole object would write back over it.
 */
export const OWN_CHOICES = ["chatStyle", "ownBubble"] as const;
export type OwnChoice = (typeof OWN_CHOICES)[number];

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
  /** `changed` holds the chat style choices this save may carry. A save given none carries all it holds. */
  const save = (value: Preferences, changed: readonly OwnChoice[] = OWN_CHOICES) => {
    const account = options.account();
    const current = () => options.account() === account;
    const entry = { value, account };
    newest = entry;
    generation++;
    saving++;
    const run = tail
      .then(async () => {
        if (!current()) return;
        try {
          const outgoing = { ...value };
          for (const choice of OWN_CHOICES) if (!changed.includes(choice)) delete outgoing[choice];
          const saved = await options.send(outgoing);
          if (!current()) return;
          if (newest === entry) newest = null;
          options.apply(saved);
        } catch (error) {
          if (!current()) return;
          if (newest === entry) newest = null;
          options.failed(error as Error);
        }
      })
      .finally(() => {
        saving--;
        generation++;
      });
    tail = run;
    return run;
  };
  /**
   * `saved` is the screen's current preferences, used when nothing is queued for this account. `chosen` names the
   * chat style choices the person set with this edit, which a picker knows and the values cannot always show: the
   * screen may hold another device's choice while a save still waiting holds the one the person now picks.
   */
  const edit = (
    change: (value: Preferences) => Preferences,
    saved: Preferences | undefined,
    chosen: readonly OwnChoice[] = [],
  ) => {
    const latest = newest?.account === options.account() ? newest.value : saved;
    if (!latest) return Promise.resolve();
    const next = change(latest);
    // An edit that changes a choice without naming it still carries it. That change is measured against the value
    // the edit was made on, a queued one included, never against what the server last confirmed: a choice changed
    // and changed back while the first save is on its way equals the confirmed one.
    return save(
      next,
      OWN_CHOICES.filter((choice) => chosen.includes(choice) || next[choice] !== latest[choice]),
    );
  };
  /** Taken when a read starts; `fresh` is true only if no save was running or ran since. */
  const mark = () => (saving ? -1 : generation);
  const fresh = (marked: number) => marked === generation && !saving;
  return { save, edit, mark, fresh };
}
