import { request } from "../client-api";
import { routeUrl, type ApiQuery, type ApiResponse } from "../shared/api";
import { HISTORY_PAGE_TURNS } from "../shared/history";

export type PageQuery = ApiQuery<"GET /bots/:id/conversation">;
export const firstQuery: PageQuery = { turns: HISTORY_PAGE_TURNS };
/** The cache key of the page an opened conversation reads first. */
export const firstPage = (botId: string) => routeUrl("GET /bots/:id/conversation", { id: botId }, firstQuery);

type Page = ApiResponse<"GET /bots/:id/conversation">;
/** A page read this recently is as good as a new one for the click that follows the hover. */
const FRESH_MS = 5_000;
/** The server serializes some reads, so a sweep across a list never queues more than this. */
const MAX_PREFETCHES = 2;
const inflight = new Map<string, Promise<Page>>();
const readAt = new Map<string, number>();

/** The latest page being prefetched, so opening the chat joins that read instead of repeating it. */
export function prefetchedFirstPage(botId: string): Promise<Page> | undefined {
  return inflight.get(firstPage(botId));
}

/**
 * Reads a chat's first page ahead of opening it, into the response cache the conversation hook
 * shows from. Hover, press and focus call this for the same row many times, so a page already
 * being read or read a moment ago is skipped. Failures are silent: opening reads again and reports.
 */
export function prefetchFirstPage(botId: string) {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const path = firstPage(botId);
  if (inflight.has(path) || inflight.size >= MAX_PREFETCHES) return;
  if (Date.now() - (readAt.get(path) ?? -Infinity) < FRESH_MS) return;
  const read = request("GET /bots/:id/conversation", { params: { id: botId }, query: firstQuery });
  inflight.set(path, read);
  void read.then(() => readAt.set(path, Date.now()), () => {}).finally(() => inflight.delete(path));
}
