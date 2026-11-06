import { CLIENT_ERROR_LIMITS, withoutUrlQueries, type ClientErrorReport } from "../shared/api";
import { hasSession, request } from "../client-api";
import { isChunkFailure } from "./chunk-failure";

/** Reports one page load sends at most. A loop that keeps failing reports its first few, not thousands. */
export const MAX_REPORTS_PER_PAGE = 5;
const reported = new Set<string>();
let sent = 0;

function describe(cause: unknown) {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === "string") return cause;
  try { return JSON.stringify(cause) ?? String(cause); } catch { return String(cause); }
}
/** The built entry script's name, such as `index-DjeCT2iD`, which changes with every release. */
function release() {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  return /\/assets\/(index-[\w-]+)\.js$/.exec(script?.src ?? "")?.[1];
}

/**
 * Tells the server about a crash or uncaught error, so a white screen on a phone is not silent.
 * Sends nothing while signed out, for chunk-load failures the screens already handle, for a
 * report this page already sent, or past this page's share. Never throws.
 */
export function reportClientError(kind: ClientErrorReport["kind"], cause: unknown, componentStack?: string) {
  try {
    if (!hasSession() || isChunkFailure(cause)) return;
    const message = withoutUrlQueries(describe(cause)).slice(0, CLIENT_ERROR_LIMITS.message) || "Unknown error";
    const stack = withoutUrlQueries([cause instanceof Error ? cause.stack : undefined, componentStack].filter(Boolean).join("\n"))
      .slice(0, CLIENT_ERROR_LIMITS.stack) || undefined;
    const key = `${message}\n${stack ?? ""}`;
    if (reported.has(key) || sent >= MAX_REPORTS_PER_PAGE) return;
    reported.add(key);
    sent++;
    const route = location.pathname.slice(0, CLIENT_ERROR_LIMITS.route);
    void request("POST /client-errors", { body: { kind, message, stack, route, release: release() } }).catch(() => {});
  } catch { /* Reporting never adds a failure of its own. */ }
}

/** Reports uncaught errors and unhandled rejections on this page. Returns a function that stops. */
export function installErrorReporting(target: Window = window) {
  const error = (event: ErrorEvent) => {
    // A cross-origin script, such as Google sign-in, hides its error behind this message.
    if (!event.error && /^Script error\.?$/.test(event.message)) return;
    reportClientError("error", event.error ?? event.message);
  };
  const rejection = (event: PromiseRejectionEvent) => reportClientError("rejection", event.reason);
  target.addEventListener("error", error);
  target.addEventListener("unhandledrejection", rejection);
  return () => {
    target.removeEventListener("error", error);
    target.removeEventListener("unhandledrejection", rejection);
  };
}
