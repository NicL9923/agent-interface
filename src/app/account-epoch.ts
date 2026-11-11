import { SESSION_MAX_AGE_MS } from "../shared/session";
import { authEpochKey, localRead, localRemove, localSave, signInHintKey } from "./storage";

/**
 * Which account this browser acts for, shared by every tab through one record in localStorage.
 *
 * The tabs of a browser share one session cookie, so a sign-in, a sign-out or a refused session in
 * one tab changes the account of every other. The record's text changes at each such transition:
 * before a sign-in or sign-out request can change the cookie (`changing`), when that request
 * settles, when the server refuses the session, when a bootstrap names another account, and when
 * the sign-in hint lapses. A tab compares the stored text with the text it acts under, through the
 * storage event, on `pageshow`, on becoming visible or focused, and before and after every request,
 * stream event and upload. Once they differ the tab ends its generation: it drops what it holds in
 * memory for the account, discards every answer still on its way, refuses new requests and draws
 * its account screens again from bootstrap (see App). The event only wakes a tab; the stored text
 * is the truth, so an event that arrives late or out of order changes nothing the check has not
 * already seen.
 *
 * What a browser cannot see is not covered: a session revoked from another device shows here until
 * the next answer from the server, which refuses it.
 */
export type AuthEpoch = {
  /** New at every transition. */
  id: string;
  at: number;
  /** A sign-in or sign-out request is on its way in the tab that wrote this. */
  changing?: true;
  /** On a changing mark: no account was signed in when it began, as the record said signed out or there was none. */
  fromSignedOut?: true;
  /** Settled with no session. */
  signedOut?: true;
  /** The account the last answer named, kept through a sign-out so the next sign-in can tell another account from the same one. */
  user?: string;
};
/** A write times out after 60 seconds, so a mark older than this belongs to a tab that closed mid-request. */
export const CHANGE_STALE_MS = 65_000;

function parseEpoch(text: string): AuthEpoch | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.at !== "number" || record.user !== undefined && typeof record.user !== "string") return null;
  return record as AuthEpoch;
}
function readStored() {
  try { return localStorage.getItem(authEpochKey) ?? ""; } catch { return ""; }
}
/**
 * A record storage refused to write, over the text it still holds. Storage that refuses writes leaves
 * every tab on its own, and each still takes its own transitions: it acts under the record it meant
 * to write until storage holds something else. Without this, a refused session that can never be
 * written would start the tab from bootstrap, be refused, and start it again, forever.
 */
let unwritten: { over: string; text: string } | undefined;
// The raw text is compared, so even a record this code cannot parse is a change when it changes.
function stored() {
  const now = readStored();
  return unwritten?.over === now ? unwritten.text : now;
}
/** Writes and returns the record this tab now acts under. */
function store(text: string) {
  try {
    if (text) localStorage.setItem(authEpochKey, text); else localStorage.removeItem(authEpochKey);
  } catch { /* Kept in memory below. */ }
  const now = readStored();
  unwritten = now === text ? undefined : { over: now, text };
  return stored();
}
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const settled = (fields: Pick<AuthEpoch, "signedOut" | "user">) =>
  JSON.stringify({ id: newId(), at: Date.now(), ...fields.signedOut ? { signedOut: true } : {}, ...fields.user ? { user: fields.user } : {} } satisfies AuthEpoch);
const changingNow = (record: AuthEpoch | null) => !!record?.changing && Date.now() - record.at < CHANGE_STALE_MS;

// Never equal to stored text: a tab that loads during another tab's transition acts under nothing until it settles.
const WAITING = "\u0000waiting";
const initial = stored();
/** The stored text this tab acts under. Requests go out only while storage still holds it. */
let held = changingNow(parseEpoch(initial)) ? WAITING : initial;
/** The stored text this tab has already answered, so one change ends one generation. */
let seen = initial;
/** The changing mark this tab wrote, while its own request is on its way. */
let owned: string | null = null;
/** Counts the tab's account generations; each one's state, answers and requests belong to it alone. */
let generation = 0;
/** Advances when this tab starts or undoes its own sign-in or sign-out, whose request may change the cookie under answers on their way. */
let era = 0;
/** Whether an app is drawing for the record, which is when requests are checked against it. */
let guarding = false;
/**
 * The account whose chats, panels, rooms and messages the address may name: the one the record named
 * when the generation started, or the one its bootstrap named since, which can be learned before the
 * record says it. `{}` is an account not yet named.
 * Null when it can name none, as an address opened while signed out, which the next account keeps;
 * undefined before this tab's first start, when the address is the one the page opened with.
 */
let addressFor: { user?: string } | null | undefined;
/**
 * The account a record says this browser has, as `addressFor` names it. A changing mark names the one
 * signed in when it began: none if it began signed out, though it keeps the last account's name for
 * the next sign-in to compare, and otherwise the account the record named, `{}` when it named none.
 */
const accountOf = (record: AuthEpoch | null) =>
  !record || record.signedOut || record.changing && record.fromSignedOut ? null : { ...record.user ? { user: record.user } : {} };
const listeners = new Set<() => void>();
const endHooks = new Set<() => void>();

/** For `{ current }` readers such as the draft and send hooks: their work is live only while this is unchanged. */
export const accountEpoch = { get current() { return generation; } };
export const accountGeneration = () => generation;
/** Registers memory to clear whenever a generation ends, such as a cache of responses. */
export function onAccountEnd(hook: () => void) {
  endHooks.add(hook);
}
function end() {
  generation++;
  for (const hook of endHooks) hook();
}
function notify() {
  for (const listener of [...listeners]) listener();
}

/** Compares the stored record with the one this tab acts under, and ends the generation if another tab changed it. */
export function checkAccount() {
  const now = stored();
  if (now === seen) return;
  seen = now;
  if (now !== held) end();
  notify();
}
/** Whether this tab waits on another tab's sign-in or sign-out, whose mark has since gone stale. */
const waitedTooLong = () => held === WAITING && !changingNow(current());

/** A request, stream event or upload made for an account this tab no longer acts for. */
export class AccountChanged extends Error {
  override name = "AbortError";
  constructor() { super("This browser signed in or out. Loading again."); }
}
export type AccountMark = { generation: number; era: number };
/** Taken before a request goes out. Throws, and ends the generation, once the account changed. */
export function accountMark(): AccountMark {
  if (guarding) {
    checkAccount();
    if (stored() !== held) throw new AccountChanged();
  }
  return { generation, era };
}
/** Whether an answer to a request marked `mark` may still be used. */
export function accountStill(mark: AccountMark) {
  if (!guarding) return mark.generation === generation;
  checkAccount();
  return mark.generation === generation && mark.era === era && stored() === held;
}

/**
 * Starts watching for transitions made in other tabs and returns the stop. `listener` hears every
 * change of the stored record; `accountStart` says what to draw for it.
 */
export function watchAccount(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("storage", heard);
    window.addEventListener("pagehide", cover);
    window.addEventListener("pageshow", woke);
    window.addEventListener("focus", woke);
    document.addEventListener("visibilitychange", woke);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    // No app draws any more, as after a test unmounts it, so none shows an account.
    guarding = false;
    addressFor = undefined;
    window.removeEventListener("storage", heard);
    window.removeEventListener("pagehide", cover);
    window.removeEventListener("pageshow", woke);
    window.removeEventListener("focus", woke);
    document.removeEventListener("visibilitychange", woke);
  };
}
// A cleared storage reports a null key.
function heard(event: StorageEvent) {
  if (event.key === authEpochKey || event.key === null) checkAccount();
}
// A page restored from the back-forward cache, or one that slept, missed events and timers.
function woke() {
  if (document.visibilityState === "hidden") return;
  checkAccount();
  checkHintExpiry();
  // The text is unchanged, but the mark this tab waits on went stale while it slept, and its own
  // timer may run late in a background tab: start now.
  if (waitedTooLong()) notify();
  if (coveredAt === generation) uncover();
}

// --- The back-forward cache ---

/**
 * The generation drawn when the page was hidden for the back-forward cache, while it stays covered.
 * A frozen page hears no storage events, and a restored one shows its last frame before `pageshow`
 * runs, so the account's screens are hidden as the page leaves: `:root[data-account-covered]` in
 * styles.css. They keep their layout, scroll, drafts and open panels. Coming back, `woke` uncovers
 * them at once if the account is the same; otherwise the change unmounts them, and App uncovers
 * once the next screen is drawn.
 */
let coveredAt: number | undefined;
let covered = { title: "", theme: "" };
function cover() {
  if (coveredAt === undefined) covered = { title: document.title, theme: document.documentElement.dataset.theme ?? "" };
  coveredAt = generation;
  document.documentElement.dataset.accountCovered = "";
  // The title can carry the account's unread count, which the tab strip shows too, and the page
  // behind the cover is painted in the account's theme.
  document.title = "WildBots";
  document.documentElement.dataset.theme = "system";
}
function uncover() {
  if (coveredAt === undefined) return;
  const same = coveredAt === generation;
  coveredAt = undefined;
  delete document.documentElement.dataset.accountCovered;
  if (!same) return;
  document.title = covered.title;
  if (covered.theme) document.documentElement.dataset.theme = covered.theme;
}
/** Called by App once a commit draws nothing of a generation that ended while the page was covered. */
export function uncoverEnded() {
  if (coveredAt !== undefined && coveredAt !== generation) uncover();
}

export type AccountStart = { wait: number } | { start: "bootstrap" | "signed-out"; leftAccount: boolean };
/**
 * Whether an address that belonged to `before` must go before `next`'s first draw: unless it named no
 * account's chats, or the next account is the same one, named. A sign-out or an account not yet named
 * is never the same one.
 */
const addressLeaves = (before: typeof addressFor, next: typeof addressFor) =>
  !!before && !(before.user !== undefined && before.user === next?.user);
/**
 * What the app draws for the stored record, and from then on the record this tab acts under. While
 * another tab's sign-in or sign-out is on its way, nothing: the answer is not yet knowable. After a
 * sign-out this tab saw, the sign-in screen; otherwise bootstrap decides. Call it once per change.
 */
export function accountStart(): AccountStart {
  checkAccount();
  // A page opened after the hint lapsed starts from that transition instead of drawing first.
  checkHintExpiry();
  const now = stored(), record = parseEpoch(now);
  if (changingNow(record) && now !== owned) {
    held = WAITING;
    // A page that opens during a change opened its address under the account the mark started from.
    if (addressFor === undefined) addressFor = accountOf(record);
    return { wait: record!.at + CHANGE_STALE_MS };
  }
  held = seen = now;
  guarding = true;
  // Decided only against a settled record, so a change another tab undoes keeps the address it found.
  const next = accountOf(record);
  const leftAccount = addressLeaves(addressFor, next);
  addressFor = next;
  // Another tab may have told the service worker otherwise since, and closed before it settled.
  told = undefined;
  // A worker the browser stopped while it closed the account that left still names it, and no later
  // page says again that no one is signed in, so a settled sign-out says so at every start.
  if (record?.signedOut) tellWorker(null);
  return { start: generation > 0 && record?.signedOut ? "signed-out" : "bootstrap", leftAccount };
}

/** Writes a settled record and ends this tab's generation, as every other tab will. */
function transition(fields: Pick<AuthEpoch, "signedOut" | "user">) {
  owned = null;
  seen = store(settled(fields));
  tellWorker(fields.signedOut ? null : fields.user ?? null);
  end();
  notify();
}
function current() { return parseEpoch(stored()); }

/**
 * Runs a read of the record and the write that depends on it as one step across tabs, with the Web
 * Locks API where the browser has it, so another tab's write cannot land between them. Without it
 * the work runs at once, as before. Every sign-in and sign-out step, which may write while another
 * tab's change is under way, goes through here. The other writers write only while no change is under
 * way, and each writes a settled record of the account the server named, so their order does not
 * matter. Chromium copies localStorage between tabs in different processes a moment after each write,
 * so the lock narrows that moment for a read, and cannot close it.
 */
function exclusive<T>(work: () => T): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    try { return Promise.resolve(work()); } catch (error) { return Promise.reject(error); }
  }
  return navigator.locks.request(authEpochKey, () => work());
}

/**
 * Marks a sign-in or sign-out as under way in every tab, before its request can change the cookie.
 * Other tabs drop their account at once and wait for `settle`. `undo` puts the record back when the
 * request failed and the cookie is unchanged. A sign-out passes `ownTree`, so a tab that has not yet
 * seen another tab's transition never signs out an account it does not show.
 */
export const beginAccountChange = ({ ownTree = false } = {}) => exclusive(() => {
  if (ownTree) {
    checkAccount();
    if (stored() !== held) throw new AccountChanged();
  }
  const before = stored(), previous = parseEpoch(before);
  // A record this code cannot read says nothing of who is signed in, so it does not count as signed out.
  const fromSignedOut = !before || !!previous?.signedOut;
  const mark = store(JSON.stringify({
    id: newId(), at: Date.now(), changing: true, ...fromSignedOut ? { fromSignedOut: true } : {}, ...previous?.user ? { user: previous.user } : {},
  } satisfies AuthEpoch));
  owned = held = seen = mark;
  era++;
  // Until it settles, the cookie may belong to either account, so no push is shown for either.
  tellWorker(null);
  return {
    settle: (fields: Pick<AuthEpoch, "signedOut" | "user">) => exclusive(() => transition(fields)),
    undo: () => exclusive(() => {
      owned = null;
      era++;
      if (stored() !== mark) return checkAccount();
      held = seen = store(before);
      tellWorker(previous && !previous.signedOut ? previous.user ?? null : null);
    }),
  };
});

/**
 * The server refused this browser's session. Every tab shows sign-in. `hadAccount` is whether this
 * tab drew an account; without one and with nothing stored to change, nothing needs telling. Returns
 * whether the generation ended, in which case the app draws again from the record.
 */
export function accountRefused(hadAccount: boolean) {
  checkAccount();
  forgetSignIn();
  const record = current();
  if (stored() !== held || changingNow(record)) return true;
  if (!hadAccount && (!record || record.signedOut)) {
    // Nothing to write, but the worker may still name the account that left, as at a signed-out start.
    tellWorker(null);
    return false;
  }
  closeShownNotifications();
  transition({ signedOut: true, user: record?.user });
  return true;
}

/**
 * A bootstrap named `user`. `drawn` is the account this generation already shows, if any. Returns
 * whether the generation may use the answer: not if another account was drawn, which ends it, nor
 * while a transition is under way or after one, when the answer may be for either cookie.
 */
export function accountNamed(user: string, drawn: string | undefined) {
  checkAccount();
  const now = stored(), record = parseEpoch(now);
  if (now !== held || changingNow(record)) return false;
  if (drawn !== undefined && drawn !== user) {
    leaving();
    forgetSignIn();
    transition({ user });
    return false;
  }
  if (record?.user !== user || record.signedOut || record.changing) {
    // Another account's push subscription still sends its notifications to this browser.
    if (record?.user && record.user !== user) leaving();
    // This generation holds nothing of another account, so it keeps the answer; other tabs start again.
    held = seen = store(settled({ user }));
  }
  tellWorker(user);
  // From here the address may name this account's chats, whatever the record named when the generation started.
  addressFor = { user };
  return true;
}

/**
 * Tells the service worker which account it may show notifications for, or none. It keeps that where
 * it can read it after the browser stops and restarts it, and drops a push, or refuses a notification's
 * action, for any other account (see scripts/service-worker.js). Each tab tells it in order, once per
 * generation for each account it names, so a bootstrap on every focus does not repeat it.
 */
let told: string | null | undefined;
let telling = Promise.resolve();
function tellWorker(user: string | null) {
  if (told === user) return;
  told = user;
  const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  if (!container) return;
  telling = telling.then(() => container.getRegistration())
    .then(registration => registration?.active?.postMessage({ type: "ACCOUNT", user }))
    .catch(() => {});
}

/** Notifications already on screen for an account that left this browser. */
export function closeShownNotifications() {
  const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  if (!container) return;
  void container.getRegistration().then(registration => registration?.getNotifications())
    .then(shownNow => { for (const notification of shownNow ?? []) notification.close(); })
    .catch(() => {});
}
/**
 * An account left this browser without signing out here. Its notifications close, and when another
 * account arrives the browser's push subscription ends too: it is the old account's on the server,
 * which keeps sending that account's notifications here and refuses the new account the same one.
 * The server drops it at its next push, when the push service answers that it is gone.
 */
function leaving() {
  closeShownNotifications();
  const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  void container?.getRegistration().then(registration => registration?.pushManager.getSubscription())
    .then(subscription => subscription?.unsubscribe()).catch(() => {});
}

// --- The sign-in hint ---

/**
 * What this browser last knew about its own sign-in: when the session cookie lapses, the account it
 * belongs to, and the chats that account could open. It holds no content, and it is gone after a
 * sign-out, a refused session, a bootstrap that names another account, or its own lapse. The session
 * cookie is unreadable to scripts, so this is how the first load can tell that reading a linked chat
 * beside bootstrap will be answered (see linked-chat.ts). The account is unknown from sign-in until
 * the first bootstrap after it names one, and a record without one starts no read.
 */
export type SignInHint = { until: number; user?: string; bots: string[] };
// A minute early, so a cookie about to lapse is never counted on.
const MARGIN_MS = 60_000;
function parseHint(value: unknown, at = Date.now()): SignInHint | null {
  if (!value || typeof value !== "object") return null;
  const hint = value as Partial<SignInHint>;
  // A list is all that is checked of the chats: an entry that is not an ID never matches one.
  if (typeof hint.until !== "number" || !Array.isArray(hint.bots)) return null;
  if (hint.user !== undefined && typeof hint.user !== "string") return null;
  return hint.until > at ? hint as SignInHint : null;
}
/** The hint while it is still good. */
export const readHint = () => parseHint(localRead(signInHintKey));
/** When the stored hint lapses, if one is stored. */
export function hintUntil() {
  const value = localRead<Partial<SignInHint>>(signInHintKey);
  return typeof value?.until === "number" ? value.until : undefined;
}

/** This browser just signed in; its session cookie lasts the server's session lifetime from now. */
export function rememberSignIn() {
  localSave(signInHintKey, { until: Date.now() + SESSION_MAX_AGE_MS - MARGIN_MS, bots: [] } satisfies SignInHint);
}

/** The account and chats a connected bootstrap found. Without a sign-in this browser saw, there is nothing to update. */
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
 * The hint lapsed: the cookie it describes is about to, so whatever this browser shows of its
 * account is the server's to confirm again. Every tab drops it and starts again from bootstrap.
 * The first tab to notice removes the hint, so the others only see that tab's transition.
 */
export function checkHintExpiry() {
  const until = hintUntil();
  if (until === undefined || until > Date.now()) return;
  forgetSignIn();
  // A sign-in on its way writes a new hint when it settles.
  if (!changingNow(current())) transition({ user: current()?.user });
}
