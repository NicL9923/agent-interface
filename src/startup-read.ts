/**
 * The read public/boot.js starts from the page's <head>, before this bundle has downloaded: the app's
 * first bootstrap. boot.js leaves it on window; the first api() read of the same path takes it, once,
 * instead of asking again. A read from a boot.js of another release, or for another path, is never
 * taken: the app reads for itself, as it does without boot.js.
 *
 * This is the fetch-level twin of linked-chat.ts's early chat read, which starts inside the bundle and
 * so can hand over parsed data. A read started before the bundle can only hand over its Response,
 * which then goes through every check api() makes of its own.
 */
export const STARTUP_READ_VERSION = 1;
type StartupRead = { version: number; path: string; response: PromiseLike<Response>; abort(): void };
declare global {
  interface Window { __wildbotsStartup?: unknown }
}

function parse(value: unknown): StartupRead | null {
  if (!value || typeof value !== "object") return null;
  const read = value as Partial<StartupRead>;
  if (read.version !== STARTUP_READ_VERSION || typeof read.path !== "string" || typeof read.abort !== "function") return null;
  return typeof read.response?.then === "function" ? read as StartupRead : null;
}

/** Lets the read go unused, as when the account changes before the app asks for it. */
export function dropStartupRead() {
  if (typeof window === "undefined" || window.__wildbotsStartup === undefined) return;
  const read = window.__wildbotsStartup as Partial<StartupRead> | null;
  window.__wildbotsStartup = undefined;
  try { if (typeof read?.abort === "function") read.abort(); } catch { /* Gone either way. */ }
}

/**
 * The startup read of `path`, if boot.js made one and nothing has taken it. `signal` is the caller's
 * request deadline and cancellation, which abort it too. A read that failed or was aborted on its own
 * hands over to `fallback`, the caller's own request, so a failure costs only the head start.
 */
export function takeStartupRead(path: string, signal: AbortSignal, fallback: () => Promise<Response>): Promise<Response> | undefined {
  if (typeof window === "undefined" || window.__wildbotsStartup === undefined) return undefined;
  const read = parse(window.__wildbotsStartup);
  if (!read) {
    dropStartupRead();
    return undefined;
  }
  if (read.path !== path) return undefined;
  window.__wildbotsStartup = undefined;
  const abort = () => read.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return Promise.resolve(read.response)
    .then(response => response, error => signal.aborted ? Promise.reject(error) : fallback())
    .finally(() => signal.removeEventListener("abort", abort));
}
