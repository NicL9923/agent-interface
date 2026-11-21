import type { Preferences, PreferencesPatch } from "../shared/types";

/**
 * Saves preferences one at a time. Two saves in flight could land in either order and the older one
 * would win, so each waits for the one before it. Edits apply to the newest queued value, so a quick
 * second tap builds on the first even before it is saved.
 *
 * Every saved answer goes on screen, so the screen always holds what the server last confirmed
 * and a failed save leaves nothing to recover. A bootstrap read that overlapped a save may hold
 * older preferences; `fresh` tells the session whether to take its copy.
 *
 * A save carries only the fields the edit behind it set. The server keeps a field a save leaves out,
 * and this tab's copy may be older than a change made since on another device, which sending the
 * whole object would write back over. A list such as `favorites` still goes whole when it changes.
 */
export const PREFERENCE_FIELDS = [
  "presentation",
  "theme",
  "favorites",
  "defaultBotId",
  "sections",
  "followBots",
  "startPage",
  "chatStyle",
  "ownBubble",
  "notifications",
  "hiddenRoutineRuns",
  "mainSuggestionDismissed",
] as const;
export type PreferenceField = (typeof PREFERENCE_FIELDS)[number];
// A field a partial save can set but this list misses would never be sent, so it fails to compile.
type Assert<T extends true> = T;
export type PreferenceFieldsComplete = Assert<
  [Exclude<keyof PreferencesPatch, PreferenceField>] extends [never] ? true : false
>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The merge patch that sets `fields` to their values in `value`. A field the edit removed goes as
 * `null`. An object such as `notifications` goes with every key it holds, and `null` for each key
 * it held in `base`, the value the edit was made on, and no longer does.
 */
export function patchFor(
  value: Preferences,
  fields: readonly PreferenceField[],
  base?: Preferences,
): PreferencesPatch {
  const patch: Record<string, unknown> = {};
  for (const field of fields) {
    const next: unknown = value[field];
    if (next === undefined) patch[field] = null;
    else if (isObject(next)) {
      const before: unknown = base?.[field];
      const keys = new Set([...Object.keys(isObject(before) ? before : {}), ...Object.keys(next)]);
      patch[field] = Object.fromEntries([...keys].map((key) => [key, next[key] ?? null]));
    } else patch[field] = next;
  }
  return patch as PreferencesPatch;
}

export function preferenceQueue(options: {
  send(patch: PreferencesPatch): Promise<Preferences>;
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
  /**
   * `fields` names the fields this save carries; given none, it carries every field `value` holds.
   * `base` is the value the edit was made on, for the keys an object field lost.
   */
  const save = (
    value: Preferences,
    fields: readonly PreferenceField[] = PREFERENCE_FIELDS.filter(
      (field) => value[field] !== undefined,
    ),
    base?: Preferences,
  ) => {
    const account = options.account();
    const current = () => options.account() === account;
    const entry = { value, account };
    const patch = patchFor(value, fields, base);
    newest = entry;
    generation++;
    saving++;
    const run = tail
      .then(async () => {
        if (!current()) return;
        try {
          const saved = await options.send(patch);
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
   * fields the person set with this edit, which a control knows and the values cannot always show: the screen may
   * hold another device's value while a save still waiting holds the one the person now picks.
   */
  const edit = (
    change: (value: Preferences) => Preferences,
    saved: Preferences | undefined,
    chosen: readonly PreferenceField[] = [],
  ) => {
    const latest = newest?.account === options.account() ? newest.value : saved;
    if (!latest) return Promise.resolve();
    const next = change(latest);
    // An edit that changes a field without naming it still carries it. That change is measured against the value
    // the edit was made on, a queued one included, never against what the server last confirmed: a field changed
    // and changed back while the first save is on its way equals the confirmed one.
    return save(
      next,
      PREFERENCE_FIELDS.filter(
        (field) => chosen.includes(field) || !same(next[field], latest[field]),
      ),
      latest,
    );
  };
  /** Taken when a read starts; `fresh` is true only if no save was running or ran since. */
  const mark = () => (saving ? -1 : generation);
  const fresh = (marked: number) => marked === generation && !saving;
  return { save, edit, mark, fresh };
}
