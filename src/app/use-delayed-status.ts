import { useEffect, useRef, useState } from "react";

/**
 * Delays showing a transient status (such as a loading indicator) until `active` stays true for
 * `delayMs`, and once shown keeps it visible for at least `minHoldMs` so fast local or cached
 * transitions never flash a spinner.
 */
export function useDelayedStatus(active: boolean, delayMs = 150, minHoldMs = 250): boolean {
  const [shown, setShown] = useState(() => active && delayMs <= 0);
  const shownAt = useRef(active && delayMs <= 0 ? Date.now() : 0);

  useEffect(() => {
    if (active) {
      if (shown) return;
      if (delayMs <= 0) {
        shownAt.current = Date.now();
        setShown(true);
        return;
      }
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, delayMs);
      return () => clearTimeout(timer);
    }
    if (!shown) return;
    const remaining = Math.max(0, minHoldMs - (Date.now() - shownAt.current));
    if (remaining <= 0) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(false), remaining);
    return () => clearTimeout(timer);
  }, [active, shown, delayMs, minHoldMs]);

  return shown;
}
