import { applyMergePatch } from "../shared/merge-patch";
import type { Preferences, PreferencesPatch } from "../shared/types";

/**
 * Saves preferences one at a time. Two saves in flight could land in either order and the older one
 * would win, so each waits for the one before it.
 *
 * An edit runs once, when the person taps, on what they see: the preferences the server last
 * confirmed with the patches still waiting or in flight laid over them in order. Its patch holds the
 * finished value of each field it set, and the save sends that patch as built. Running an edit later,
 * on a base the person never saw, would move, append or swap against a different list.
 *
 * Each answer becomes the confirmed copy, and the screen shows it with the patches still waiting laid
 * over it. A refused save's patch leaves that overlay and the person is told; the patches behind it
 * still go out as built, and they already hold its change, because they were built on a screen that
 * showed it. A bootstrap read never changes the confirmed copy while saves wait: `fresh` tells the
 * session to hold such a read's preferences back, and the next answer replaces the copy anyway.
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
  // What the server last answered for the account whose saves wait, or the screen's copy when the first
  // of them was queued.
  let confirmed: { value: Preferences; account: number } | null = null;
  // Patches waiting or in flight, oldest first.
  let waiting: { patch: PreferencesPatch; account: number }[] = [];
  // Counts saves starting and settling, so a read can tell whether one overlapped it.
  let generation = 0;
  let saving = 0;
  /** What the person sees: the confirmed copy with this account's waiting patches laid over it. */
  const seen = (account: number, value: Preferences) =>
    waiting
      .filter((entry) => entry.account === account)
      .reduce((shown, entry) => applyMergePatch(shown, entry.patch) as Preferences, value);
  /**
   * Runs `change` now, on what the person sees, and queues the patch it makes.
   *
   * `saved` is the screen's current preferences, the starting point when nothing waits for this account.
   * `chosen` names the fields the person set with this edit, which a control knows and the values cannot
   * always show: a pick can equal what a waiting save holds while the screen shows another device's value.
   * A field the edit changes without naming it is sent too.
   */
  const edit = (
    change: (value: Preferences) => Preferences,
    saved: Preferences | undefined,
    chosen: readonly PreferenceField[] = [],
  ) => {
    const account = options.account();
    const current = () => options.account() === account;
    waiting = waiting.filter((entry) => entry.account === account);
    if (!waiting.length || confirmed?.account !== account)
      confirmed = saved ? { value: saved, account } : null;
    if (!confirmed) return Promise.resolve();
    const base = seen(account, confirmed.value);
    const next = change(base);
    const entry = {
      patch: patchFor(
        next,
        PREFERENCE_FIELDS.filter(
          (field) => chosen.includes(field) || !same(next[field], base[field]),
        ),
      ),
      account,
    };
    waiting.push(entry);
    generation++;
    saving++;
    const settle = () => {
      waiting = waiting.filter((other) => other !== entry);
    };
    const run = tail
      .then(async () => {
        if (!current()) return;
        try {
          const answer = await options.send(entry.patch);
          if (!current()) return;
          confirmed = { value: answer, account };
          settle();
          options.apply(seen(account, answer));
        } catch (error) {
          if (!current()) return;
          settle();
          if (confirmed?.account === account) options.apply(seen(account, confirmed.value));
          options.failed(error as Error);
        }
      })
      .finally(() => {
        settle();
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
