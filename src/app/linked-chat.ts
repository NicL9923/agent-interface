import { clearResponseCache } from "../client-api";
import { onAccountEnd, readHint } from "./account-epoch";
import { prefetchLinkedPage } from "./conversation-page";
import { initialMessage, initialView } from "./view";

/**
 * The account a read started beside bootstrap was made for, until bootstrap says whether that is
 * still who is signed in. Nothing shows the read before then: the chat opens only once bootstrap has
 * answered. Another tab's sign-in or sign-out ends this tab's account generation, which discards the
 * read and the response cache with it (see account-epoch.ts).
 */
let speculative: string | null = null;
onAccountEnd(() => { speculative = null; });

/**
 * Bootstrap answered as `user`. A read started beside it for anyone else is dropped before the chat
 * can show it. A refused bootstrap needs no call: it ends the account generation, which clears every
 * cached response.
 */
export function settleLinkedChat(user: string) {
  if (speculative === null) return;
  const made = speculative;
  speculative = null;
  // Forgets the read and every response cached with it, so the chat reads again when it opens.
  if (made !== user) clearResponseCache();
}

/**
 * Starts reading the chat the first address names, such as a notification link, or the chat chosen
 * on the saved home, beside bootstrap instead of after it. The chat's first load after the page loaded opens from this read, on its
 * way or finished, and no later load does (see prefetchedFirstPage). The read is dropped if
 * bootstrap finds another account or none.
 *
 * It reads only what this browser's last sign-in could open, so a signed-out person or a chat they
 * may not see usually costs no refused request. A session the server ended early, or a chat made
 * private since the last bootstrap, still costs one. A link to a message opens a window around that
 * message, not the latest page, and Today or a group chat shows no chat at all; those wait for
 * bootstrap.
 */
export function prefetchLinkedChat(chosen?: string) {
  // A chat chosen on home before bootstrap answers (see saved-roster.ts) is read the same way.
  const botId = chosen ?? new URLSearchParams(location.search).get("bot");
  if (!botId || chosen === undefined && (initialView() !== "conversation" || initialMessage())) return;
  const hint = readHint();
  if (!hint?.user || !hint.bots.includes(botId)) return;
  speculative = hint.user;
  prefetchLinkedPage(botId);
}
