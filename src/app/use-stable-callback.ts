import { useCallback, useInsertionEffect, useRef } from "react";

/**
 * A callback whose identity never changes but which always runs the latest render's code, so
 * memoized children such as home are not re-rendered by a fresh closure on every keystroke.
 * Call it from events only, never during render.
 */
export function useStableCallback<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R {
  const latest = useRef(callback);
  useInsertionEffect(() => { latest.current = callback; });
  return useCallback((...args: A) => latest.current(...args), []);
}
