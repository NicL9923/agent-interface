import { useLayoutEffect, useMemo, useRef, useState } from "react";

/** An item on screen, and since when it has been leaving, if it has. */
export interface Shown<T> { item: T; key: string; leavingSince?: number }

/**
 * The next list to draw: every current item in order, plus items that just went away, kept at
 * their old places while they play an exit for `ms`. Pure, so it can be tested without timers.
 */
export function mergeLeaving<T>(previous: Shown<T>[], next: T[], keyOf: (item: T) => string, now: number, ms: number): Shown<T>[] {
  const result: Shown<T>[] = next.map(item => ({ item, key: keyOf(item) }));
  if (ms <= 0) return result;
  const current = new Set(result.map(entry => entry.key));
  previous.forEach((entry, index) => {
    if (current.has(entry.key)) return;
    const since = entry.leavingSince ?? now;
    if (now - since >= ms) return;
    result.splice(Math.min(index, result.length), 0, { ...entry, leavingSince: since });
  });
  return result;
}

/**
 * Keeps items that leave a list on screen for `ms`, marked as leaving, so they can animate out.
 * A new `scope`, such as another assistant's chat, starts over without exits.
 */
export function useLeaving<T>(items: T[], keyOf: (item: T) => string, ms: number, scope: string): Shown<T>[] {
  const shown = useRef<{ scope: string; list: Shown<T>[] }>({ scope, list: [] });
  const [tick, setTick] = useState(0);
  const list = useMemo(() => mergeLeaving(shown.current.scope === scope ? shown.current.list : [], items, keyOf, Date.now(), ms),
    // keyOf is read fresh each time; the list only changes with the items, the scope or a finished exit.
    [items, scope, ms, tick]);
  useLayoutEffect(() => {
    shown.current = { scope, list };
    const leaving = list.filter(entry => entry.leavingSince !== undefined);
    if (!leaving.length) return;
    const end = Math.min(...leaving.map(entry => entry.leavingSince! + ms));
    const timer = window.setTimeout(() => setTick(count => count + 1), Math.max(0, end - Date.now()) + 16);
    return () => clearTimeout(timer);
  }, [list, scope, ms]);
  return list;
}
