import { write } from "../client-api";
import { beginAccountChange, closeShownNotifications, forgetSignIn, rememberSignIn } from "./account-epoch";
import { forgetAccountContent } from "./storage";

/**
 * Signs in through `path`. Every tab drops its account before the request can change the cookie,
 * and draws again from bootstrap once it settles. A refused sign-in leaves the cookie as it was, so
 * the record goes back and the tabs that waited read their account again.
 */
export async function signInWith(path: string, body: unknown) {
  const change = beginAccountChange();
  let answer: { user?: { id?: unknown } } | undefined;
  try {
    answer = await write<typeof answer>(path, body);
  } catch (error) {
    change.undo();
    throw error;
  }
  rememberSignIn();
  // The first bootstrap names the account if the answer does not.
  change.settle({ user: typeof answer?.user?.id === "string" ? answer.user.id : undefined });
}

/**
 * Signs `user` out of this browser. A tab that has not yet seen another tab's transition is refused
 * before it can sign out an account it does not show. Once the server ends the session, the records
 * that hold this member's content leave the browser, and every tab shows sign-in.
 */
export async function signOutOf(user: string) {
  const change = beginAccountChange({ ownTree: true });
  try {
    await write("/auth/logout", {});
  } catch (error) {
    change.undo();
    throw error;
  }
  forgetAccountContent(user);
  forgetSignIn();
  closeShownNotifications();
  change.settle({ signedOut: true, user });
}
