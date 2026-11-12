import { request, responseScope } from "../client-api";
import { routeUrl, type ApiQuery, type ApiResponse } from "../shared/api";
import { HISTORY_PAGE_TURNS } from "../shared/history";

export type PageQuery = ApiQuery<"GET /bots/:id/conversation">;
export const firstQuery: PageQuery = { turns: HISTORY_PAGE_TURNS };
/** The cache key of the page an opened conversation reads first. */
export const firstPage = (botId: string) => routeUrl("GET /bots/:id/conversation", { id: botId }, firstQuery);

type Page = ApiResponse<"GET /bots/:id/conversation">;

/**
 * The view with an earlier page in front of the message it was read `before`, or undefined when the view no longer holds
 * that message. Only the page's messages, files and earlier counts are taken: everything else, such as live state, the
 * version and the draft, stays as the view's own reads left it. Files keep conversation order, each once.
 */
export function prependPage<V extends Pick<Page, "messages" | "files" | "earlier" | "earlierFiles">>(view: V, page: Page, before: string): V | undefined {
  const at = view.messages.findIndex(message => message.id === before);
  if (at < 0) return undefined;
  const known = new Set(view.files.map(file => file.id));
  const files = [...page.files.filter(file => !known.has(file.id)), ...view.files];
  return { ...view, messages: [...page.messages, ...view.messages.slice(at)], files, earlier: page.earlier, earlierFiles: page.earlierFiles };
}
/** A page read this recently is as good as a new one for the click that follows the hover. */
const FRESH_MS = 5_000;
/** The server serializes some reads, so a sweep across a list never queues more than this. */
const MAX_PREFETCHES = 2;
const inflight = new Map<string, Promise<Page>>();
const readAt = new Map<string, number>();
/**
 * The read a link started as the page loaded (see linked-chat.ts). It is the one finished read a
 * chat may open from, because nothing a person does can come before the first chat load after the
 * page loaded. That load takes it or discards it, whichever chat it is for.
 */
let startup: { path: string; read: Promise<Page> } | undefined;
// Reads belong to the account they were made for. A new account starts with none to join.
let scope = responseScope();
function current() {
  if (scope === responseScope()) return;
  scope = responseScope();
  inflight.clear();
  readAt.clear();
  startup = undefined;
}

/**
 * What a chat's first load may take instead of reading: the read a link started as the page
 * loaded, on its way or finished, if this is the first chat load since; otherwise a prefetch still
 * on its way. A prefetch that finished only filled the response cache, which the chat shows while
 * it reads again. Call it once per chat load that may take one, since it uses up the startup read.
 */
export function prefetchedFirstPage(botId: string): Promise<Page> | undefined {
  current();
  const path = firstPage(botId);
  const linked = startup?.path === path ? startup.read : undefined;
  startup = undefined;
  return linked ?? inflight.get(path);
}

/** Reads the chat a link names as the page loads, for that chat's first load to open from. */
export function prefetchLinkedPage(botId: string) {
  prefetchFirstPage(botId);
  const path = firstPage(botId);
  const read = inflight.get(path);
  startup = read && { path, read };
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
  if (Date.now() - (readAt.get(path) ?? -Infinity) < FRESH_MS) return;
  const read = request("GET /bots/:id/conversation", { params: { id: botId }, query: firstQuery });
  inflight.set(path, read);
  const made = scope;
  // A read that finishes after a sign-out leaves the next account's state alone.
  void read.then(() => { if (made === responseScope()) readAt.set(path, Date.now()); }, () => {})
    .finally(() => { if (inflight.get(path) === read) inflight.delete(path); });
}
