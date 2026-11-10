import { request, responseScope } from "../client-api";
import { routeUrl, type ApiQuery, type ApiResponse, type MessageRequest } from "../shared/api";
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
// Reads on their way, each with the switch that stops it when something newer supersedes it.
const inflight = new Map<string, { read: Promise<Page>; stop: AbortController }>();
// Reads that finished, by when. A chat opened within FRESH_MS of one takes it as its first load.
const done = new Map<string, { at: number; read: Promise<Page> }>();
// Reads belong to the account they were made for. A new account starts with none to join.
let scope = responseScope();
function current() {
  if (scope === responseScope()) return;
  scope = responseScope();
  inflight.clear();
  done.clear();
}

const fresh = (path: string) => Date.now() - (done.get(path)?.at ?? -Infinity) < FRESH_MS;
/**
 * The latest page being prefetched, or read a moment ago, so opening the chat joins that read
 * instead of repeating it. Only the chat's first load may join it: the change stream's connection
 * and every notice after read fresh, so nothing that changed since is missed.
 */
export function prefetchedFirstPage(botId: string): Promise<Page> | undefined {
  current();
  const path = firstPage(botId);
  return inflight.get(path)?.read ?? (fresh(path) ? done.get(path)?.read : undefined);
}

/**
 * The rule for when a prefetched page stops being usable: the moment anything newer exists for its
 * chat. That is a send to the chat, which the page cannot hold, or any transcript read of the chat
 * that completes, which saw at least as much as every prefetch begun before it. Either one drops
 * every prefetch of the chat made before that moment, finished or still on its way, so the next
 * first load reads fresh. A prefetch still on its way is stopped, so its older page never lands in
 * the response cache over the newer one either; a first load that had joined it reads again. The
 * send path calls this as a send leaves, and the chat's read path as each of its own reads lands.
 */
export function supersedePrefetch(botId: string) {
  current();
  const path = firstPage(botId);
  inflight.get(path)?.stop.abort();
  inflight.delete(path);
  done.delete(path);
}

/** Sends a message to a chat. Every send goes through here, so no prefetch outlives one. */
export function sendMessage(botId: string, body: MessageRequest) {
  supersedePrefetch(botId);
  return request("POST /bots/:id/messages", { params: { id: botId }, body });
}

/**
 * Reads a chat's first page ahead of opening it, into the response cache the conversation hook
 * shows from. Hover, press and focus call this for the same row many times, so a page already
 * being read or read a moment ago is skipped. Failures are silent: opening reads again and reports.
 */
export function prefetchFirstPage(botId: string) {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  current();
  const path = firstPage(botId);
  if (inflight.has(path) || inflight.size >= MAX_PREFETCHES) return;
  if (fresh(path)) return;
  const stop = new AbortController();
  const read = request("GET /bots/:id/conversation", { params: { id: botId }, query: firstQuery, signal: stop.signal });
  const entry = { read, stop };
  inflight.set(path, entry);
  const made = scope;
  // A read that finishes after a sign-out leaves the next account's state alone, and one that
  // something newer superseded on its way stays unusable.
  void read.then(() => { if (made === responseScope() && inflight.get(path) === entry) done.set(path, { at: Date.now(), read }); }, () => {})
    .finally(() => { if (inflight.get(path) === entry) inflight.delete(path); });
}
