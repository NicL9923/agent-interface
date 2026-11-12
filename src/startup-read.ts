import { accountRecordIs } from "./app/account-epoch";
/**
 * The reads public/boot.js starts from the page's <head>, before this bundle has downloaded: the app's
 * first bootstrap, and a linked chat's first page. boot.js leaves them on window; the first api() read of
 * the same path takes each, once, instead of asking again. A read from a boot.js of another release, or
 * for another path, is never taken: the app reads for itself, as it does without boot.js.
 *
 * A read started before the bundle can only hand over its Response, which then goes through every check
 * api() makes of its own. The chat's read is asked for again by linked-chat.ts as the bundle starts, by
 * the same rules, and api() hands it this one; linked-chat.ts still decides whether it may show.
 */
export const STARTUP_READ_VERSION = 3;
type Read = { path: string; response: PromiseLike<Response>; abort(): void };
/**
 * `epoch` is the account record's text when boot.js started the reads, '' for none. `reads` are bootstrap's and,
 * for an address that names a chat this browser's sign-in could open, that chat's first page (see linked-chat.ts).
 */
type StartupReads = { version: number; epoch: string; reads: Read[] };
declare global {
  interface Window { __wildbotsStartup?: unknown }
}

const isRead = (value: unknown): value is Read => {
  const read = value as Partial<Read> | null;
  return !!read && typeof read === "object" && typeof read.path === "string" && typeof read.abort === "function" && typeof read.response?.then === "function";
};
function parse(value: unknown): StartupReads | null {
  if (!value || typeof value !== "object") return null;
  const startup = value as Partial<StartupReads>;
  // An `epoch` that is not text never equals the stored record, so the claim below drops it.
  return startup.version === STARTUP_READ_VERSION && Array.isArray(startup.reads) && startup.reads.every(isRead) ? startup as StartupReads : null;
}

/** Lets every read go unused, as when the account changes before the app asks for them. */
export function dropStartupRead() {
  if (typeof window === "undefined" || window.__wildbotsStartup === undefined) return;
  const startup = window.__wildbotsStartup as (Partial<StartupReads> & Partial<Read>) | null;
  window.__wildbotsStartup = undefined;
  // Whatever can be aborted, in this shape or another release's, such as one read with its own `abort`.
  const reads: unknown[] = Array.isArray(startup?.reads) ? startup.reads : [startup?.reads];
  for (const read of [startup, ...reads] as (Partial<Read> | null | undefined)[]) {
    try { if (typeof read?.abort === "function") read.abort(); } catch { /* Gone either way. */ }
  }
}

/**
 * The startup read of `path`, if boot.js made one and nothing has taken it. `signal` is the caller's
 * request deadline and cancellation, which abort it too. A read that failed or was aborted on its own
 * hands over to `fallback`, the caller's own request, so a failure costs only the head start. Each read
 * is taken once; the others stay for their own paths.
 */
export function takeStartupRead(path: string, signal: AbortSignal, fallback: () => Promise<Response>): Promise<Response> | undefined {
  if (typeof window === "undefined" || window.__wildbotsStartup === undefined) return undefined;
  const startup = parse(window.__wildbotsStartup);
  if (!startup) {
    dropStartupRead();
    return undefined;
  }
  const index = startup.reads.findIndex(read => read.path === path);
  if (index < 0) return undefined;
  // Made under another account record: the cookie they carried may be another account's. The app asks for itself.
  if (!accountRecordIs(startup.epoch)) {
    dropStartupRead();
    return undefined;
  }
  const [read] = startup.reads.splice(index, 1);
  if (!startup.reads.length) window.__wildbotsStartup = undefined;
  const abort = () => read.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  // An answer that arrives after the record changed is discarded by api(), as any answer is.
  return Promise.resolve(read.response)
    .then(response => response, error => signal.aborted ? Promise.reject(error) : fallback())
    .finally(() => signal.removeEventListener("abort", abort));
}
