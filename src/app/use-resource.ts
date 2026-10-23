import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, pollWhileVisible } from "../client-api";

export type ResourceOptions<T> = {
  /** Extra values that restart the load. The data stays while the new load runs. */
  deps?: readonly unknown[];
  /** False pauses loading, polling and wake refreshes and keeps the data. A function sees the data so far. */
  enabled?: boolean | ((data: T | null) => boolean);
  /** Refreshes quietly every pollMs while the page is visible. */
  pollMs?: number;
  /** Refreshes quietly when the window regains focus, the network returns, or the page is shown. */
  wake?: boolean;
  /** Turns a failure into the text shown. Defaults to the error's message. */
  errorMessage?: (cause: unknown) => string;
  /** Returns text to show instead of making the request, such as while offline. */
  skip?: () => string | undefined;
  /** Throws to reject a response that cannot be used. */
  validate?: (value: T) => void;
  /** Runs for each accepted response, before it is stored. */
  onData?: (value: T) => void;
};

export type Resource<T> = {
  data: T | null;
  error: string;
  /** True from the start of a load a person asked for, such as the first one, until it settles. */
  loading: boolean;
  /** Loads again now and resolves when that load settles. It never rejects: failures land in `error`. */
  reload: () => Promise<void>;
  /** Replaces the data with a fresher copy and drops any load still running, so it cannot overwrite this. */
  setData: Dispatch<SetStateAction<T | null>>;
  /** Drops any load still running and ignores its result. */
  invalidate: () => void;
};

/**
 * Loads a GET path and keeps its result, error and loading state. Each load aborts the one
 * before it, and nothing from an old path, an unmounted component or a dropped load is stored.
 * A null path has nothing to load and no data. Quiet refreshes (poll, wake) never stack and
 * never raise `loading`.
 */
export function useResource<T>(path: string | null, options: ResourceOptions<T> = {}): Resource<T> {
  const { deps = [], enabled = true, pollMs, wake } = options;
  const [data, setData] = useState<T | null>(null);
  const active = path !== null && (typeof enabled === "function" ? enabled(data) : enabled);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(active);
  const latest = useRef(options);
  latest.current = options;
  const inflight = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const previousPath = useRef(path);

  const invalidate = useCallback(() => {
    inflight.current?.abort();
    inflight.current = undefined;
    setLoading(false);
  }, []);
  const load = useCallback(async (quiet: boolean) => {
    if (path === null || !mounted.current || quiet && inflight.current) return;
    const skipped = latest.current.skip?.();
    // A skipped load settles at once, unless a load already running still owns `loading`.
    if (skipped) { setError(skipped); if (!inflight.current) setLoading(false); return; }
    inflight.current?.abort();
    const controller = inflight.current = new AbortController();
    if (!quiet) { setLoading(true); setError(""); }
    try {
      const value = await api<T>(path, { signal: controller.signal });
      if (controller.signal.aborted) return;
      latest.current.validate?.(value);
      latest.current.onData?.(value);
      setData(value);
      setError("");
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(latest.current.errorMessage?.(cause) ?? (cause as Error).message);
    } finally {
      if (inflight.current === controller) { inflight.current = undefined; setLoading(false); }
    }
  }, [path]);
  const reload = useCallback(() => load(false), [load]);
  const replace: Dispatch<SetStateAction<T | null>> = useCallback(value => { invalidate(); setData(value); }, [invalidate]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (previousPath.current !== path) { previousPath.current = path; setData(null); setError(""); }
    if (!active) { setLoading(false); return; }
    void load(false);
    const quiet = () => void load(true);
    const stops = [pollMs ? pollWhileVisible(quiet, pollMs) : undefined];
    if (wake) {
      const woken = () => { if (document.visibilityState !== "hidden") quiet(); };
      window.addEventListener("focus", woken);
      window.addEventListener("online", woken);
      document.addEventListener("visibilitychange", woken);
      stops.push(() => {
        window.removeEventListener("focus", woken);
        window.removeEventListener("online", woken);
        document.removeEventListener("visibilitychange", woken);
      });
    }
    return () => {
      inflight.current?.abort();
      inflight.current = undefined;
      for (const stop of stops) stop?.();
    };
  }, [load, active, pollMs, wake, ...deps]);
  return { data, error, loading, reload, setData: replace, invalidate };
}
