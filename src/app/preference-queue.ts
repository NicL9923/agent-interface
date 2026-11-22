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
 * The screen always shows that same overlay, so every screen offers what the queue builds on: each tap
 * puts its patch on screen at once, each answer becomes the confirmed copy and goes on screen with the
 * patches still waiting laid over it, and a refused save's patch leaves the overlay while the person is
 * told. The patches behind a refused one still go out as built. Each carries the refused change only in
 * the fields it names, because it was built on a screen that showed it.
 *
 * A bootstrap read never changes the confirmed copy while saves wait: `fresh` tells the session to drop
 * the preferences of any read that overlapped a save, even one that lands after the queue empties, and
 * the next clean read brings them. An answer from another preferences route goes through `confirm`.
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

/** How an edit ended: see `edit`. */
export type SaveResult = "saved" | "refused" | "unchanged" | "dropped";

export function preferenceQueue(options: {
  send(patch: PreferencesPatch): Promise<Preferences>;
  apply(saved: Preferences): void;
  failed(error: Error): void;
  /** Changes when the signed-in account changes; nothing queued for another account survives it. */
  account(): number;
}) {
  let tail: Promise<unknown> = Promise.resolve();
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
   *
   * An edit that returns the value it was given changes nothing, queues nothing and answers `"unchanged"`,
   * as when a move names a section that is no longer there. Otherwise it answers `"saved"` or `"refused"`
   * once its save settles, or `"dropped"` when the account changed first.
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
    if (!confirmed) return Promise.resolve<SaveResult>("dropped");
    const base = seen(account, confirmed.value);
    const next = change(base);
    if (next === base) return Promise.resolve<SaveResult>("unchanged");
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
    options.apply(seen(account, confirmed.value));
    const settle = () => {
      waiting = waiting.filter((other) => other !== entry);
    };
    const run = tail
      .then(async (): Promise<SaveResult> => {
        if (!current()) return "dropped";
        try {
          const answer = await options.send(entry.patch);
          if (!current()) return "dropped";
          confirmed = { value: answer, account };
          settle();
          options.apply(seen(account, answer));
          return "saved";
        } catch (error) {
          if (!current()) return "dropped";
          settle();
          if (confirmed?.account === account) options.apply(seen(account, confirmed.value));
          options.failed(error as Error);
          return "refused";
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
  /**
   * Takes preferences another route answered with, such as a new main assistant, as the confirmed copy,
   * and puts them on screen with the patches still waiting laid over them.
   *
   * Not covered: an answer to a preferences save that was already in flight still replaces this copy
   * when it lands. If it was read before the other route's change, it puts back what that route cleared,
   * such as a main assistant, check-ins or a default assistant, until the next clean bootstrap read
   * corrects it. Main has the same gap. Closing it means sending those routes' saves through this queue,
   * one at a time with the preference saves, so no answer can be older than one applied before it.
   */
  const confirm = (value: Preferences) => {
    const account = options.account();
    if (waiting.some((entry) => entry.account === account)) confirmed = { value, account };
    options.apply(seen(account, value));
  };
  /** Taken when a read starts; `fresh` is true only if no save was running or ran since. */
  const mark = () => (saving ? -1 : generation);
  const fresh = (marked: number) => marked === generation && !saving;
  /**
   * What the server last confirmed while saves wait for this account, or undefined when none wait and the
   * screen's copy is the confirmed one. Anything kept for a later launch is written from this, never from
   * the screen, so a change still on its way is not drawn as saved when the tab closes first.
   */
  const confirmedCopy = () => {
    const account = options.account();
    return confirmed?.account === account && waiting.some((entry) => entry.account === account)
      ? confirmed.value
      : undefined;
  };
  return { edit, confirm, confirmedCopy, mark, fresh };
}
