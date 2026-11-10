import { clearResponseCache } from "../client-api";
import { SESSION_MAX_AGE_MS } from "../shared/session";
import { prefetchFirstPage } from "./conversation-page";
import { localRead, localRemove, localSave, signInHintKey } from "./storage";
import { initialMessage, initialView } from "./view";

/**
 * What this browser last knew about its own sign-in: when the session cookie lapses, the account it
 * belongs to, and the chats that account could open. It holds no content, and it is gone after a
 * sign-out or a refused session. The session cookie is unreadable to scripts, so this is how the
 * first load can tell that reading a linked chat beside bootstrap will be answered, instead of
 * logging a refusal for a signed-out person. The account is unknown from sign-in until the first
 * bootstrap after it names one, and a record without one starts no read.
 */
type SignInHint = { until: number; user?: string; bots: string[] };
// A minute early, so a cookie about to lapse is never counted on.
const MARGIN_MS = 60_000;

function parseHint(value: unknown): SignInHint | null {
  if (!value || typeof value !== "object") return null;
  const hint = value as Partial<SignInHint>;
  // A list is all that is checked of the chats: an entry that is not an ID never matches one.
  if (typeof hint.until !== "number" || !Array.isArray(hint.bots)) return null;
  if (hint.user !== undefined && typeof hint.user !== "string") return null;
  return hint.until > Date.now() ? hint as SignInHint : null;
}
const readHint = () => parseHint(localRead(signInHintKey));

/** This browser just signed in; its session cookie lasts the server's session lifetime from now. */
export function rememberSignIn() {
  localSave(signInHintKey, { until: Date.now() + SESSION_MAX_AGE_MS - MARGIN_MS, bots: [] } satisfies SignInHint);
}

/**
 * The account and chats a connected bootstrap found. Without a sign-in this browser saw, there is
 * nothing to update. A record that names another account is not this cookie's, so it is dropped.
 */
export function rememberChats(user: string, ids: string[]) {
  const hint = readHint();
  if (!hint) return;
  if (hint.user !== undefined && hint.user !== user) return forgetSignIn();
  if (hint.user === user && hint.bots.length === ids.length && hint.bots.every((id, index) => id === ids[index])) return;
  localSave(signInHintKey, { ...hint, user, bots: ids } satisfies SignInHint);
}

export function forgetSignIn() {
  localRemove(signInHintKey);
}

/**
 * The account a read started beside bootstrap was made for, until a bootstrap or another tab says
 * whether that is still who is signed in. Nothing shows the read before then: the chat opens only
 * once bootstrap has answered.
 */
let speculative: string | null = null;

/** Forgets the read and every response cached with it, so the chat reads again when it opens. */
function drop() {
  settled();
  clearResponseCache();
}
function settled() {
  speculative = null;
  window.removeEventListener("storage", changed);
}

// Another tab signed out, or signed in again, while the read was out. The cookie the read carried
// may not be the one bootstrap carries, so it is dropped unless the record still names its account.
function changed(event: StorageEvent) {
  if (event.key !== signInHintKey && event.key !== null) return;
  let next: SignInHint | null = null;
  try { next = parseHint(JSON.parse(event.newValue ?? "null")); } catch { /* Unreadable is gone. */ }
  if (next?.user !== speculative) drop();
}

/**
 * Bootstrap answered as `user`. A read started beside it for anyone else is dropped before the chat
 * can show it, as when another tab switched accounts in between. A refused bootstrap needs no call:
 * it clears every cached response itself.
 */
export function settleLinkedChat(user: string) {
  if (speculative === null) return;
  if (speculative === user) settled();
  else drop();
}

/**
 * Starts reading the chat the first address names, such as a notification link, beside bootstrap
 * instead of after it. The chat joins this read when it opens (see prefetchedFirstPage), and the
 * read is dropped if bootstrap finds another account or none.
 *
 * It reads only what this browser's last sign-in could open, so a signed-out person or a chat they
 * may not see usually costs no refused request. A session the server ended early, or a chat made
 * private since the last bootstrap, still costs one. A link to a message opens a window around that
 * message, not the latest page, and Today or a group chat shows no chat at all; those wait for
 * bootstrap.
 */
export function prefetchLinkedChat() {
  const botId = new URLSearchParams(location.search).get("bot");
  if (!botId || initialView() !== "conversation" || initialMessage()) return;
  const hint = readHint();
  if (!hint?.user || !hint.bots.includes(botId)) return;
  settled();
  speculative = hint.user;
  window.addEventListener("storage", changed);
  prefetchFirstPage(botId);
}
