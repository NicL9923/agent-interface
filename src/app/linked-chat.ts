import { SESSION_MAX_AGE_MS } from "../shared/session";
import { prefetchFirstPage } from "./conversation-page";
import { localRead, localRemove, localSave, signInHintKey } from "./storage";
import { initialMessage, initialView } from "./view";

/**
 * What this browser last knew about its own sign-in: when the session cookie lapses, and the chats
 * the account could open. It holds no content, and it is gone after a sign-out or a refused session.
 * The session cookie is unreadable to scripts, so this is how the first load can tell that reading a
 * linked chat beside bootstrap will be answered, instead of logging a refusal for a signed-out person.
 */
type SignInHint = { until: number; bots: string[] };
// A minute early, so a cookie about to lapse is never counted on.
const MARGIN_MS = 60_000;

function readHint(): SignInHint | null {
  const value = localRead<Partial<SignInHint>>(signInHintKey);
  // A list is all that is checked of the chats: an entry that is not an ID never matches one.
  if (!value || typeof value !== "object" || typeof value.until !== "number" || !Array.isArray(value.bots)) return null;
  return value.until > Date.now() ? value as SignInHint : null;
}

/** This browser just signed in; its session cookie lasts the server's session lifetime from now. */
export function rememberSignIn() {
  localSave(signInHintKey, { until: Date.now() + SESSION_MAX_AGE_MS - MARGIN_MS, bots: [] } satisfies SignInHint);
}

/** The chats a bootstrap listed for the signed-in account. Without a sign-in this browser saw, there is nothing to update. */
export function rememberChats(ids: string[]) {
  const hint = readHint();
  if (!hint || hint.bots.length === ids.length && hint.bots.every((id, index) => id === ids[index])) return;
  localSave(signInHintKey, { ...hint, bots: ids } satisfies SignInHint);
}

export function forgetSignIn() {
  localRemove(signInHintKey);
}

/**
 * Starts reading the chat the first address names, such as a notification link, beside bootstrap
 * instead of after it. The chat joins this read when it opens (see prefetchedFirstPage), and the
 * read is dropped if bootstrap finds another account or none.
 *
 * It reads only what this browser's last sign-in could open, so a signed-out person or a chat they
 * may not see costs no refused request. A link to a message opens a window around that message,
 * not the latest page, and Today or a group chat shows no chat at all; those wait for bootstrap.
 */
export function prefetchLinkedChat() {
  const botId = new URLSearchParams(location.search).get("bot");
  if (!botId || initialView() !== "conversation" || initialMessage()) return;
  if (!readHint()?.bots.includes(botId)) return;
  prefetchFirstPage(botId);
}
