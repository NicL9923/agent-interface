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
// The raw text is compared, so even a record this code cannot parse is a change when it changes.
function stored() {
  try { return localStorage.getItem(authEpochKey) ?? ""; } catch { return ""; }
}
/** Writes and returns what storage now holds, which is the old text when storage refuses the write. */
function store(text: string) {
  try {
    if (text) localStorage.setItem(authEpochKey, text); else localStorage.removeItem(authEpochKey);
  } catch { /* Storage that refuses writes leaves every tab on its own; each still sees its own transitions. */ }
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
/** Whether the generation drew an account from a bootstrap, so its address may name that account's chats. */
let shown = false;
let endedShown = false;
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
  endedShown = shown;
  shown = false;
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
    window.addEventListener("pageshow", woke);
    window.addEventListener("focus", woke);
    document.addEventListener("visibilitychange", woke);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    // No app draws any more, as after a test unmounts it, so none shows an account.
    guarding = false;
    shown = false;
    window.removeEventListener("storage", heard);
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
}

export type AccountStart = { wait: number } | { start: "bootstrap" | "signed-out"; leftAccount: boolean };
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
    return { wait: record!.at + CHANGE_STALE_MS };
  }
  held = seen = now;
  guarding = true;
  return { start: generation > 0 && record?.signedOut ? "signed-out" : "bootstrap", leftAccount: endedShown };
}

/** Writes a settled record and ends this tab's generation, as every other tab will. */
function transition(fields: Pick<AuthEpoch, "signedOut" | "user">) {
  owned = null;
  seen = store(settled(fields));
  end();
  notify();
}
const current = () => parseEpoch(stored());

/**
 * Marks a sign-in or sign-out as under way in every tab, before its request can change the cookie.
 * Other tabs drop their account at once and wait for `settle`. `undo` puts the record back when the
 * request failed and the cookie is unchanged. A sign-out passes `ownTree`, so a tab that has not yet
 * seen another tab's transition never signs out an account it does not show.
 */
export function beginAccountChange({ ownTree = false } = {}) {
  if (ownTree) {
    checkAccount();
    if (stored() !== held) throw new AccountChanged();
  }
  const before = stored(), previous = parseEpoch(before);
  const mark = store(JSON.stringify({ id: newId(), at: Date.now(), changing: true, ...previous?.user ? { user: previous.user } : {} } satisfies AuthEpoch));
  owned = held = seen = mark;
  era++;
  return {
    settle(fields: Pick<AuthEpoch, "signedOut" | "user">) {
      transition(fields);
    },
    undo() {
      owned = null;
      era++;
      if (stored() !== mark) return checkAccount();
      held = seen = store(before);
    },
  };
}

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
  if (!hadAccount && (!record || record.signedOut)) return false;
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
  shown = true;
  return true;
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
