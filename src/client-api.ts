let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
// GET bodies by exact path. A 304, or a 200 with identical text, returns the same object so React can skip the update.
type Cached = { etag: string | null; text: string; data: unknown };
const responses = new Map<string, Cached>();
const MAX_RESPONSES = 64, MAX_CACHED_CHARS = 4_000_000;
let cachedChars = 0, generation = 0;
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
