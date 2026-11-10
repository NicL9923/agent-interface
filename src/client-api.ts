import { routeParts, routeUrl, type ApiBody, type ApiParams, type ApiQuery, type ApiResponse, type ApiRoute } from "./shared/api";
import type { ErrorCode } from "./shared/errors";
import type { Inflight, InflightDelta } from "./shared/types";
let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
/** Whether a bootstrap signed this page in. Cleared on sign-out and on a lost session. */
export function hasSession() {
  return csrf !== "";
}
// GET bodies by exact path. A 304, or a 200 with identical text, returns the same object so React can skip the update.
// `started` is the start order of the read that last vouched for the body: reads finish out of
// order, and the server saw the most when the latest-started one left.
type Cached = { etag: string | null; text: string; data: unknown; started: number };
const responses = new Map<string, Cached>();
const MAX_RESPONSES = 64, MAX_CACHED_CHARS = 4_000_000;
let cachedChars = 0, generation = 0, reads = 0;
/** The last body read for a GET path, to show while it is fetched again. */
export function cachedResponse<T>(path: string) {
  return responses.get(path)?.data as T | undefined;
}
/** Changes whenever cached responses stop belonging to the signed-in account. */
export function responseScope() {
  return generation;
}
export function clearResponseCache() {
  responses.clear();
  cachedChars = 0;
  generation++;
}
/** Caches a body unless the entry already holds one from a read that started later. */
function remember(path: string, entry: Cached) {
  if ((responses.get(path)?.started ?? -1) > entry.started) return;
  forget(path);
  if (entry.text.length > MAX_CACHED_CHARS) return;
  responses.set(path, entry);
  cachedChars += entry.text.length;
  for (const [oldest] of responses) {
    if (responses.size <= MAX_RESPONSES && cachedChars <= MAX_CACHED_CHARS) break;
    forget(oldest);
  }
}
function forget(path: string) {
  cachedChars -= responses.get(path)?.text.length ?? 0;
  responses.delete(path);
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** An unknown server code still arrives as its string and matches no comparison. */
    public code?: ErrorCode,
    public confirmRequired?: boolean,
    /** The error response body, such as the current draft with a draft conflict. */
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (init.method && init.method !== "GET") headers.set("X-CSRF-Token", csrf);
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener("abort", abort, { once: true });
  const get = !init.method || init.method === "GET";
  const timer = setTimeout(() => controller.abort(), get ? 20_000 : 60_000);
  const cached = get ? responses.get(path) : undefined;
  const scope = generation, started = ++reads;
  if (cached?.etag) headers.set("If-None-Match", cached.etag);
  const request = () => fetch(`/api${path}`, {
    ...init,
    headers,
    signal: controller.signal,
    credentials: "same-origin",
    cache: "no-store",
  });
  try {
    let response = await request();
    if (get && response.status === 304) {
      if (cached?.etag) {
        if (scope === generation) remember(path, { ...cached, started });
        return cached.data as T;
      }
      // Only a request carrying our validator can be answered from memory.
      headers.delete("If-None-Match");
      response = await request();
      if (response.status === 304) throw new ApiError("The app returned an unreadable response. Check the connection before trying again.", 502, "INVALID_RESPONSE");
    }
    const body = await response.text();
    if (get && response.ok && cached?.text === body) {
      if (scope === generation) remember(path, { ...cached, etag: response.headers.get("ETag"), started });
      return cached.data as T;
    }
    let data: Record<string, any> = {};
    try { data = body ? JSON.parse(body) : {}; }
    catch {
      if (response.ok) throw new ApiError("The app returned an unreadable response. Check the connection before trying again.", 502, "INVALID_RESPONSE");
    }
    // An assistant turned private while this read ran; the server dropped it, so read again.
    if (get && response.status === 503 && data?.code === "assistants_changed" && !retried) return api<T>(path, init, true);
    if (!response.ok)
      throw new ApiError(
        data?.detail || data?.error || `Request failed (${response.status})`,
        response.status,
        data?.code,
        data?.confirmRequired,
        data,
      );
    if (get && scope === generation) remember(path, { etag: response.headers.get("ETag"), text: body, data, started });
    return data as T;
  } catch (error) {
    if (error instanceof ApiError || init.signal?.aborted) throw error;
    // Only a write has a draft and a sent message to reassure about; a slow read just needs another try.
    throw new ApiError(controller.signal.aborted
      ? get ? "The app took too long to respond. Try again in a moment." : "The app took too long to respond. Your draft is kept; sent messages will be checked before retrying."
      : "Can't reach the app. Your draft is kept. We'll reconnect automatically.",
    controller.signal.aborted ? 504 : 503, "CONNECTION_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}
export function write<T>(path: string, value: unknown, method = "POST", init?: RequestInit) {
  return api<T>(path, { ...init, method, body: JSON.stringify(value) });
}
type Fields<K extends ApiRoute> =
  & (keyof ApiParams<K> extends never ? { params?: undefined } : { params: ApiParams<K> })
  & (ApiBody<K> extends undefined ? { body?: undefined } : { body: ApiBody<K> })
  & (ApiQuery<K> extends undefined ? { query?: undefined } : {} extends ApiQuery<K> ? { query?: ApiQuery<K> } : { query: ApiQuery<K> });
export type RequestOptions<K extends ApiRoute> = Fields<K> & { signal?: AbortSignal };
/**
 * Calls a route from the shared map, typed by its method and path: `request("GET /bots/:id/draft",
 * { params: { id } })` answers a SavedDraft or null. It reads and caches like api().
 */
export function request<K extends ApiRoute>(route: K, ...[options]: {} extends RequestOptions<K> ? [RequestOptions<K>?] : [RequestOptions<K>]) {
  const { params, body, query, signal } = (options ?? {}) as { params?: ApiParams<K>; body?: unknown; query?: ApiQuery<K>; signal?: AbortSignal };
  const { method } = routeParts(route);
  return api<ApiResponse<K>>(routeUrl(route, params ?? ({} as ApiParams<K>), query), {
    ...(method === "GET" ? {} : { method }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
}
/**
 * Runs refresh every intervalMs while the page is visible. A hidden page pauses it,
 * and showing the page again refreshes at once. Returns a function that stops it.
 */
export function pollWhileVisible(refresh: () => void, intervalMs: number) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => { timer ??= setInterval(refresh, intervalMs); };
  const changed = () => {
    if (document.visibilityState === "hidden") {
      clearInterval(timer);
      timer = undefined;
    } else if (!timer) {
      refresh();
      start();
    }
  };
  if (document.visibilityState !== "hidden") start();
  document.addEventListener("visibilitychange", changed);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", changed);
  };
}
/** The ping interval of a server that does not name one: 25 seconds, as before `?ping=10`. */
const DEFAULT_PING_MS = 25_000;
/** The longest a silent stream waits before its next replacement, however often it was replaced. */
export const MAX_STREAM_SILENCE = 5 * 60_000;
/**
 * How long a stream may stay silent before it counts as dead: two pings and five seconds more, so one
 * lost or late ping never replaces a live stream. A server that pings every 10 seconds, as one opened
 * with `?ping=10` does, is found dead within 25 seconds of its last event; one that names no interval,
 * within 55. Each replacement that hears nothing doubles it, up to MAX_STREAM_SILENCE, and any event
 * resets it.
 */
export function streamSilence(pingMs: number, misses: number) {
  return Math.min((2 * pingMs + 5_000) * 2 ** misses, MAX_STREAM_SILENCE);
}
/** Adds `ping=10`, which asks the server to ping every 10 seconds and say so. */
const withPing = (path: string) => `${path}${path.includes("?") ? "&" : "?"}ping=10`;
/**
 * Calls onChange for each change notice on a server event stream, and each time it
 * connects, since notices sent before the subscription are lost. EventSource retries a drop
 * itself but never a refusal, and a connection a proxy or a sleeping device cut can stay open
 * and silent. A watchdog replaces a stream silent past `streamSilence`, and `open` replaces a
 * closed or silent one at once. A hidden page's late timers replace nothing: showing the page
 * calls `open`, which checks then. `named` handles other named events by their data, such as
 * group chat notices.
 */
export function changeStream(path: string, onChange: () => void, onInflight?: (value: Inflight) => void, named: Record<string, (data: string) => void> = {},
  onInflightDelta?: (value: InflightDelta) => boolean) {
  let source: EventSource | undefined, heard = 0, pingMs = DEFAULT_PING_MS, misses = 0;
  let watchdog: ReturnType<typeof setTimeout> | undefined, due = 0;
  const silence = () => streamSilence(pingMs, misses);
  const silent = () => Date.now() - heard >= silence();
  /**
   * Any event proves the connection, so the next silence is measured from the base again. The timer
   * moves only when that brings the deadline closer, so a stream of growth events sets no timers.
   */
  const alive = () => {
    heard = Date.now();
    misses = 0;
    if (source && heard + silence() < due) watch();
  };
  // One timer per stream, set for when silence would begin. A device waking from sleep fires it once, late.
  const watch = (delay = Math.max(0, heard + silence() - Date.now())) => {
    clearTimeout(watchdog);
    due = Date.now() + delay;
    watchdog = setTimeout(check, delay);
  };
  const check = () => {
    watchdog = undefined;
    if (!source) return;
    // Hidden, it looks again a whole silence later; showing the page calls `open` sooner.
    if (document.visibilityState === "hidden") watch(silence());
    else if (source.readyState === EventSource.CLOSED || silent()) replace();
    else watch();
  };
  const close = () => {
    clearTimeout(watchdog);
    watchdog = undefined;
    source?.close();
    source = undefined;
    misses = 0;
  };
  const replace = () => {
    // A stream that failed or went silent counts against the next one's patience.
    const failed = source ? misses + 1 : 0;
    close();
    misses = failed;
    connect();
  };
  const open = () => {
    if (typeof EventSource === "undefined") return;
    if (source && source.readyState !== EventSource.CLOSED && !silent()) return;
    replace();
  };
  const connect = () => {
    const current = source = new EventSource(`/api${withPing(path)}`);
    heard = Date.now();
    // Learned again from this connection's first ping, which a `?ping=10` server sends at once.
    pingMs = DEFAULT_PING_MS;
    watch();
    // Only the stream this one opened last speaks for it: a replaced one's late events change nothing.
    const on = (name: string, handle: (data: string) => void) =>
      current.addEventListener(name, event => { if (current === source) handle((event as MessageEvent).data); });
    current.onopen = () => {
      if (current !== source) return;
      heard = Date.now();
      onChange();
    };
    if (onInflight) on("inflight", data => {
      alive();
      try { onInflight(JSON.parse(data) as Inflight); } catch { onChange(); }
    });
    // A growth notice the caller cannot apply means this stream and the caller disagree about the
    // live reply. Reload, and reconnect so the server starts again from a whole `inflight` event.
    if (onInflightDelta) on("inflight-delta", data => {
      alive();
      let applied = false;
      try { applied = onInflightDelta(JSON.parse(data) as InflightDelta); } catch { /* Reloads below. */ }
      if (applied) return;
      onChange();
      close();
      open();
    });
    on("roster", () => { alive(); onChange(); });
    for (const [name, handle] of Object.entries(named)) on(name, data => { alive(); handle(data); });
    // A ping names its interval in seconds; an older server's says `ping` and keeps the default.
    on("ping", data => {
      const seconds = Number(data);
      pingMs = Number.isFinite(seconds) && seconds >= 1 && seconds <= 60 ? seconds * 1000 : DEFAULT_PING_MS;
      alive();
    });
    on("message", () => {
      alive();
      onChange();
    });
  };
  return { open, close };
}
// Fetch cannot report request progress, so attachments use XHR. A stall, not a slow link, times out.
export function uploadFile<T>(path: string, file: File, { onProgress, signal }: { onProgress?(sent: number): void; signal?: AbortSignal } = {}) {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;
    const watch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { stalled = true; request.abort(); }, 60_000);
    };
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      settle();
    };
    const cancel = () => request.abort();
    request.open("POST", `/api${path}`);
    request.setRequestHeader("X-CSRF-Token", csrf);
    request.upload.onprogress = event => { watch(); if (event.lengthComputable) onProgress?.(event.loaded / event.total); };
    request.onload = () => finish(() => {
      let data: Record<string, any> = {};
      try { data = request.responseText ? JSON.parse(request.responseText) : {}; }
      catch {
        if (request.status < 300) return reject(new ApiError("The app returned an unreadable response. Try attaching the file again.", 502, "INVALID_RESPONSE"));
      }
      if (request.status >= 200 && request.status < 300) resolve(data as T);
      else reject(new ApiError(data?.detail || data?.error || `Upload failed (${request.status})`, request.status, data?.code));
    });
    request.onerror = () => finish(() => reject(new ApiError("Can't reach the app. Check the connection and try again.", 503, "CONNECTION_UNAVAILABLE")));
    request.onabort = () => finish(() => reject(stalled
      ? new ApiError("The upload stopped making progress. Try again.", 504, "CONNECTION_UNAVAILABLE")
      : new DOMException("Upload canceled", "AbortError")));
    if (signal?.aborted) return reject(new DOMException("Upload canceled", "AbortError"));
    signal?.addEventListener("abort", cancel, { once: true });
    const form = new FormData();
    form.append("file", file);
    watch();
    request.send(form);
  });
}
