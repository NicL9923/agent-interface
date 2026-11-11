import { ApiError, request, setCsrf, write } from "../client-api";
import { beginAccountChange, closeShownNotifications, endPushSubscription, forgetSignIn, pendingSignOut, rememberSignIn, signOutFinished } from "./account-epoch";
import { forgetAccountContent } from "./storage";

/**
 * Signs in through `path`. Every tab drops its account before the request can change the cookie,
 * and draws again from bootstrap once it settles. A refused sign-in leaves the cookie as it was, so
 * the record goes back and the tabs that waited read their account again.
 */
export async function signInWith(path: string, body: unknown) {
  const change = await beginAccountChange();
  let answer: { user?: { id?: unknown } } | undefined;
  try {
    answer = await write<typeof answer>(path, body);
  } catch (error) {
    await change.undo();
    throw error;
  }
  rememberSignIn();
  // The first bootstrap names the account if the answer does not.
  await change.settle({ user: typeof answer?.user?.id === "string" ? answer.user.id : undefined });
}

/**
 * Signs `user` out of this browser. A tab that has not yet seen another tab's transition is refused
 * before it can sign out an account it does not show. Once the server ends the session, the records
 * that hold this member's content leave the browser, and every tab shows sign-in.
 */
export async function signOutOf(user: string) {
  const change = await beginAccountChange({ ownTree: true });
  try {
    await write("/auth/logout", {});
  } catch (error) {
    await change.undo();
    throw error;
  }
  forgetAccountContent(user);
  forgetSignIn();
  closeShownNotifications();
  await change.settle({ signedOut: true, user });
}

/**
 * Signs `user` out of this browser when the app cannot be reached, as from the saved home after the
 * first bootstrap failed. It goes at once, as a sign-out the server took does, in every tab, and the
 * record says the server's session may still be live, so nothing reads with it until the sign-in
 * screen ends it there (`finishSignOut`).
 *
 * That record is all that stands between the live session and a later page, so it is written, and
 * found in storage, before this member's copies go. When storage refuses it or does not keep it, the
 * record goes back, nothing is removed, and this returns false: the person is still signed in here.
 */
export async function signOutHere(user: string) {
  const change = await beginAccountChange({ ownTree: true });
  const done = await change.settleKept({ signedOut: true, user, logout: true }, () => {
    forgetAccountContent(user);
    forgetSignIn();
    closeShownNotifications();
    // The online sign-out turns notifications off first (see App); offline only the browser's side can end.
    endPushSubscription();
  });
  if (!done) await change.undo();
  return done;
}

let finishing: Promise<void> | null = null;
/**
 * Ends the server's session that a sign-out without the server left behind. The server's sign-out
 * needs the session's CSRF token, which only bootstrap gives, so it reads bootstrap first and shows
 * none of it. A refused bootstrap means the session is already gone. A failure leaves the mark for
 * the next try, on the next focus, return to the page or network.
 */
export function finishSignOut() {
  if (pendingSignOut() === null) return Promise.resolve();
  finishing ??= (async () => {
    try {
      try {
        const answer = await request("GET /bootstrap", { query: { roster: "lean" } });
        setCsrf(answer.csrfToken ?? "");
        await write("/auth/logout", {});
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) return;
      } finally {
        setCsrf("");
      }
      signOutFinished();
    } finally {
      finishing = null;
    }
  })();
  return finishing;
}
