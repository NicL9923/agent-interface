let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
// GET bodies by exact path. A 304, or a 200 with identical text, returns the same object so React can skip the update.
type Cached = { etag: string | null; text: string; data: unknown };
const responses = new Map<string, Cached>();
const MAX_RESPONSES = 64, MAX_CACHED_CHARS = 4_000_000;
let cachedChars = 0, generation = 0;
/** The last body read for a GET path, to show while it is fetched again. */
export function cachedResponse<T>(path: string) {
  return responses.get(path)?.data as T | undefined;
}
export function clearResponseCache() {
  responses.clear();
  cachedChars = 0;
  generation++;
}
function remember(path: string, entry: Cached) {
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
    public code?: string,
    public confirmRequired?: boolean,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  const scope = generation;
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
        if (scope === generation && responses.get(path) === cached) remember(path, cached);
        return cached.data as T;
      }
      // Only a request carrying our validator can be answered from memory.
      headers.delete("If-None-Match");
      response = await request();
      if (response.status === 304) throw new ApiError("The app returned an unreadable response. Check the connection before trying again.", 502, "INVALID_RESPONSE");
    }
    const body = await response.text();
    if (get && response.ok && cached?.text === body) {
      if (scope === generation) remember(path, { ...cached, etag: response.headers.get("ETag") });
      return cached.data as T;
    }
    let data: Record<string, any> = {};
    try { data = body ? JSON.parse(body) : {}; }
    catch {
      if (response.ok) throw new ApiError("The app returned an unreadable response. Check the connection before trying again.", 502, "INVALID_RESPONSE");
    }
    if (!response.ok)
      throw new ApiError(
        data?.detail || data?.error || `Request failed (${response.status})`,
        response.status,
        data?.code,
        data?.confirmRequired,
      );
    if (get && scope === generation) remember(path, { etag: response.headers.get("ETag"), text: body, data });
    return data as T;
  } catch (error) {
    if (error instanceof ApiError || init.signal?.aborted) throw error;
    throw new ApiError(controller.signal.aborted
      ? "The app took too long to respond. Your draft is kept; sent messages will be checked before retrying."
      : "Can't reach the app. Your draft is kept. We'll reconnect automatically.",
    controller.signal.aborted ? 504 : 503, "CONNECTION_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}
export function write<T>(path: string, value: unknown, method = "POST") {
  return api<T>(path, { method, body: JSON.stringify(value) });
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
/** Server pings keep a stream this fresh; a quieter one may be a dead connection. */
const STREAM_SILENCE = 60_000;
/**
 * Calls onChange for each change notice on a server event stream, and after a dropped
 * stream reconnects, since notices sent meanwhile are lost. EventSource retries a drop
 * itself but never a refusal, so `open` replaces a closed or silent stream.
 */
export function changeStream(path: string, onChange: () => void) {
  let source: EventSource | undefined, heard = 0;
  const close = () => {
    source?.close();
    source = undefined;
  };
  const open = () => {
    if (typeof EventSource === "undefined") return;
    if (source && source.readyState !== EventSource.CLOSED && Date.now() - heard < STREAM_SILENCE) return;
    close();
    let opened = false;
    const current = source = new EventSource(`/api${path}`);
    heard = Date.now();
    current.onopen = () => {
      heard = Date.now();
      if (opened) onChange();
      opened = true;
    };
    current.addEventListener("ping", () => { heard = Date.now(); });
    current.onmessage = () => {
      heard = Date.now();
      onChange();
    };
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
