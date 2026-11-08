import { useCallback, useEffect, useRef, useState } from "react";

export type ActionOptions<T> = {
  /** Shown as the notice when the work succeeds. */
  success?: string;
  /** Runs after a success, only while the action is still current. */
  onSuccess?: (result: T) => void;
  /**
   * Runs after a failure, only while the action is still current. Return the text to show,
   * or null to show nothing. Returning nothing shows the error's message.
   */
  onError?: (cause: unknown) => string | null | void;
};

/** Passed to the work: false once the component unmounted or `reset` ran. */
export type ActionContext = { current: () => boolean };

/**
 * One mutation at a time. `run` ignores a call made while another is in flight, clears the
 * previous error and notice, and drops every state update from work that was reset or whose
 * component unmounted. Error and notice stay separate so each renders with its own role.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const running = useRef(false);
  const epoch = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async <T,>(work: (context: ActionContext) => Promise<T>, options: ActionOptions<T> = {}): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    const started = epoch.current;
    const current = () => mounted.current && epoch.current === started;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await work({ current });
      if (current()) {
        if (options.success) setNotice(options.success);
        options.onSuccess?.(result);
      }
      return result;
    } catch (cause) {
      if (current()) {
        const message = options.onError?.(cause);
        if (message !== null) setError(message ?? (cause as Error).message);
      }
      return undefined;
    } finally {
      if (epoch.current === started) running.current = false;
      if (current()) setBusy(false);
    }
  }, []);
  /** Drops the work in flight, so a new `run` may start and the old one cannot touch state. */
  const reset = useCallback(() => {
    epoch.current++;
    running.current = false;
    setBusy(false); setError(""); setNotice("");
  }, []);
  return { busy, error, notice, run, setError, setNotice, reset };
}
