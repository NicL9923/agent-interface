import type { Preferences, PreferencesPatch } from "../shared/types";

/**
 * Saves preferences one at a time. Two saves in flight could land in either order and the older one
 * would win, so each waits for the one before it. An edit runs when its turn comes, on what the server
 * answered to the save before it, so a quick second tap builds on the first and on anything another
 * device saved that the answer brought.
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
 * The keys of an object field a partial save may clear with `null`. A patch that sends the field
 * names each one, so the server never keeps a key the new value does not hold.
 */
export const CLEARABLE_KEYS = { notifications: ["quietStart", "quietEnd"] } as const;
type Notifications = NonNullable<PreferencesPatch["notifications"]>;
type Nullable<T> = { [K in keyof T]-?: null extends T[K] ? K : never }[keyof T];
// A key the patch type lets a save clear but this list misses would be kept by the server, so it fails to compile.
export type ClearableKeysComplete = Assert<
  [Exclude<Nullable<Notifications>, (typeof CLEARABLE_KEYS.notifications)[number]>] extends [never]
    ? true
    : false
>;

/**
 * The merge patch that sets `fields` to their values in `value`. It says everything about each field
 * it names, whatever an older copy held: a field `value` lacks goes as `null`, and an object field
 * goes with every key it holds and `null` for each clearable key it does not.
 */
export function patchFor(value: Preferences, fields: readonly PreferenceField[]): PreferencesPatch {
  const patch: Record<string, unknown> = {};
  for (const field of fields) {
    const next: unknown = value[field];
    if (next === undefined) patch[field] = null;
    else if (isObject(next)) {
      const clearable: readonly string[] =
        field in CLEARABLE_KEYS ? CLEARABLE_KEYS[field as keyof typeof CLEARABLE_KEYS] : [];
      const keys = new Set([...Object.keys(next), ...clearable]);
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
  // What the server last answered for the account whose saves are queued, or the screen's copy
  // when the first of them was queued. Each edit runs on it when its turn to send comes.
  let confirmed: { value: Preferences; account: number } | null = null;
  // Saves queued or running, per account.
  const queued = new Map<number, number>();
  // Counts saves starting and settling, so a read can tell whether one overlapped it.
  let generation = 0;
  let saving = 0;
  /**
   * Queues `change`. It runs when every save before it has settled, on what the server answered last,
   * so it starts from what the person now sees and a failed save's change is not carried into it.
   *
   * `saved` is the screen's current preferences, the starting point when nothing is queued for this
   * account. `chosen` names the fields the person set with this edit, which a control knows and the
   * values cannot always show: a pick can equal what the server holds while the screen shows another
   * device's value. A field the edit changes without naming it is sent too.
   */
  const edit = (
    change: (value: Preferences) => Preferences,
    saved: Preferences | undefined,
    chosen: readonly PreferenceField[] = [],
  ) => {
    const account = options.account();
    const current = () => options.account() === account;
    if (!queued.get(account) || confirmed?.account !== account)
      confirmed = saved ? { value: saved, account } : null;
    if (!confirmed) return Promise.resolve();
    queued.set(account, (queued.get(account) ?? 0) + 1);
    generation++;
    saving++;
    const run = tail
      .then(async () => {
        if (!current() || confirmed?.account !== account) return;
        const base = confirmed.value;
        const next = change(base);
        const patch = patchFor(
          next,
          PREFERENCE_FIELDS.filter(
            (field) => chosen.includes(field) || !same(next[field], base[field]),
          ),
        );
        try {
          const saved = await options.send(patch);
          if (!current()) return;
          confirmed = { value: saved, account };
          options.apply(saved);
        } catch (error) {
          if (!current()) return;
          options.failed(error as Error);
        }
      })
      .finally(() => {
        const left = (queued.get(account) ?? 1) - 1;
        if (left) queued.set(account, left);
        else queued.delete(account);
        saving--;
        generation++;
      });
    tail = run;
    return run;
  };
  /** Taken when a read starts; `fresh` is true only if no save was running or ran since. */
  const mark = () => (saving ? -1 : generation);
  const fresh = (marked: number) => marked === generation && !saving;
  return { edit, mark, fresh };
}
