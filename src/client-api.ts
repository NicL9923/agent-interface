let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
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
  const timer = setTimeout(() => controller.abort(),
    !init.method || init.method === "GET" ? 20_000 : 60_000);
  try {
    const response = await fetch(`/api${path}`, {
      ...init,
      headers,
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = await response.text();
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
