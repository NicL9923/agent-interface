import { useCallback, useEffect, useRef, useState } from "react";
import type { Bootstrap, Preferences } from "../shared/types";
import {
  AccountChanged,
  ApiError,
  changeStream,
  request as apiRequest,
  setCsrf,
} from "../client-api";
import { preferenceQueue } from "./preference-queue";
import { prefetchLinkedChat, settleLinkedChat } from "./linked-chat";
import {
  accountEpoch,
  accountNamed,
  accountRefused,
  pendingSignOut,
  rememberChats,
} from "./account-epoch";
import { finishSignOut } from "./account-change";
import { reportStream, streamUp } from "./stream-health";
type SessionEvents = {
  onFirstBootstrap(next: Bootstrap): void;
  onError(message: string): void;
  /** The open assistant left this person's roster, as when another member made it personal. */
  onBotGone(botId: string): void;
};
/**
 * Dispatched on window when this person's group catalog may have changed: the household stream's
 * `groups` notice, a roster notice, or the stream (re)connecting, since notices sent while it was
 * down are lost.
 */
export const GROUPS_EVENT = "agent-interface:groups";
/** Group chat reads that only cover a notice the stream missed. */
export const GROUP_FALLBACK_POLL_MS = 5 * 60_000;
/** Until the server has sent a `groups` notice, it may be one that never does, so poll as before. */
export const GROUP_UNNOTIFIED_POLL_MS = 30_000;
const groupsChanged = () => window.dispatchEvent(new Event(GROUPS_EVENT));
/**
 * How long after the first stale roster in a row the page keeps showing what each assistant was doing.
 * Longer than a bootstrap's retries take, so a roster read that failed once never shows; short enough
 * that an assistant is not shown working long after nobody can tell. It is judged as each bootstrap
 * answers, and those come at least every 45 seconds while the roster is stale, so the latest an
 * activity is dropped is about 75 seconds after the roster went stale.
 */
export const ROSTER_CARRY_MS = 30_000;
/**
 * Whether the server could list only its last roster, not a fresh one. It says so by marking rows
 * `disconnected`, which it does while Hermes is down and after a roster read that failed with Hermes
 * connected.
 */
const staleRoster = (next: Bootstrap) => next.bots.some((bot) => bot.activity === "disconnected");
/**
 * The roster a bootstrap brings, for the member the page already shows. Who is on it is always the
 * server's word: it filters even its last roster for each member, so an assistant made private goes at
 * once. What each assistant is doing is the server's word only when it knows. A stale row says nothing
 * changed, so while `carry` holds the row keeps the activity it had here; whether the app shows a loss,
 * and when, is `useOutage`'s business. A bootstrap that missed Hermes and lists no roster at all keeps
 * the rows as they were.
 */
function rosterFrom(next: Bootstrap, previous: Bootstrap | null, carry: boolean) {
  if (previous?.user.id !== next.user.id) return next.bots;
  if (!next.connection.connected && !next.bots.length) return previous.bots;
  if (!carry) return next.bots;
  const before = new Map(previous.bots.map((bot) => [bot.id, bot.activity]));
  return next.bots.map((bot) =>
    bot.activity === "disconnected" && before.has(bot.id)
      ? { ...bot, activity: before.get(bot.id)! }
      : bot,
  );
}
/** A bootstrap this recent already answers a focus or visibility change, such as alt-tabbing back. */
const FRESH_MS = 5_000;
/** How often bootstrap is read while the household stream is live, for changes it does not announce. */
export const BOOTSTRAP_FALLBACK_MS = 5 * 60_000;
/**
 * How long after each bootstrap in a row that failed, found Hermes down or brought a stale roster the
 * next one is read, so a loss that is already over clears in a second or two, whether or not the stream
 * says so. After the
 * last wait the 45-second poll takes over. A hidden page, an offline device and sign-in skip a retry;
 * being shown, back online or signed in reads anyway.
 */
export const BOOTSTRAP_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
/**
 * One account generation's session (see account-epoch.ts): the app mounts it again for every
 * transition, so it holds only one account. `start` is "signed-out" after a sign-out this browser
 * saw, which shows sign-in without asking the server.
 */
export function useSession(events: SessionEvents, start: "bootstrap" | "signed-out" = "bootstrap") {
  const handlers = useRef(events);
  handlers.current = events;
  const initialDestination = useRef(false);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [auth, setAuth] = useState(start === "signed-out");
  /** The account whose household stream has sent a `groups` notice: that server pushes catalog changes. */
  const [groupsNotifiedFor, setGroupsNotifiedFor] = useState<string | null>(null);
  const [botId, setBotId] = useState(() => new URLSearchParams(location.search).get("bot") || "");
  const [disconnected, setDisconnected] = useState(false);
  /** Whether a bootstrap on this page has found Hermes connected: a loss after that may be a blip, one before it is just the state. */
  const [everConnected, setEverConnected] = useState(false);
  const [appUnavailable, setAppUnavailable] = useState(false);
  const [offline, setOffline] = useState(() => navigator.onLine === false);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const bootstrapRequest = useRef<Promise<Bootstrap | null> | null>(null);
  const lastBootstrap = useRef<Bootstrap | null>(null);
  /** The account this generation drew, set as an answer is applied, before it renders. */
  const drawn = useRef<string | undefined>(undefined);
  const lastSuccess = useRef(0);
  /** When the roster first came back stale since the last fresh one, and whether the last one applied carried activity; see ROSTER_CARRY_MS. */
  const staleSince = useRef<number | undefined>(undefined);
  const carried = useRef(true);
  const bootRef = useRef(boot);
  bootRef.current = boot;
  const botIdRef = useRef(botId);
  botIdRef.current = botId;
  const authRef = useRef(auth);
  authRef.current = auth;
  // Bootstraps in a row that did not find Hermes connected, and the read the latest one set for later.
  const misses = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const retryLater = useRef(() => {});
  // Whether this session is on the page. A read can be answered after it is gone, and sets nothing then.
  const mounted = useRef(true);
  const refresh = useCallback((): Promise<Bootstrap | null> => {
    if (bootstrapRequest.current) return bootstrapRequest.current;
    // A sign-out made without the server reads nothing as that account; the server's session ends first.
    if (pendingSignOut() !== null) {
      void finishSignOut();
      return Promise.resolve(null);
    }
    const epoch = accountEpoch.current;
    const marked = preferences.current?.mark() ?? -1;
    const request = (async () => {
      try {
        const next = await apiRequest("GET /bootstrap", { query: { roster: "lean" } });
        if (epoch !== accountEpoch.current) return null;
        // Another account than this generation drew ends it, and the app starts again for the new one.
        if (!accountNamed(next.user.id, drawn.current)) return null;
        drawn.current = next.user.id;
        // A chat read beside this bootstrap counts only if it was made for the account signed in now.
        settleLinkedChat(next.user.id);
        // A bootstrap that found Hermes down or its roster stale, like a failed one, is no reason to hold
        // back the next look, and is read again soon (see BOOTSTRAP_RETRY_MS).
        const answered = Date.now();
        const well = next.connection.connected && !staleRoster(next);
        staleSince.current = staleRoster(next) ? (staleSince.current ?? answered) : undefined;
        const carry = answered - (staleSince.current ?? answered) < ROSTER_CARRY_MS;
        lastSuccess.current = well ? answered : 0;
        if (!initialDestination.current) {
          initialDestination.current = true;
          handlers.current.onFirstBootstrap(next);
        }
        setCsrf(next.csrfToken ?? "");
        if (next.connection.connected)
          rememberChats(
            next.user.id,
            next.bots.map((bot) => bot.id),
          );
        // A save that overlapped this read may be newer than its preferences; keep the saved copy.
        const stalePreferences = !preferences.current?.fresh(marked);
        // An unchanged poll returns the cached object; keeping the derived state lets React skip the app render.
        // A read whose preferences were held back is not remembered, so the next one reconciles them.
        // The same stale roster reads differently once it is no longer carried.
        const unchanged = lastBootstrap.current === next && carried.current === carry;
        lastBootstrap.current = stalePreferences ? null : next;
        carried.current = carry;
        setBoot((previous) =>
          unchanged && previous
            ? previous
            : {
                ...next,
                bots: rosterFrom(next, previous, carry),
                preferences:
                  stalePreferences && previous?.user.id === next.user.id
                    ? previous.preferences
                    : next.preferences,
              },
        );
        setAuth(false);
        setAppUnavailable(false);
        setDisconnected(!next.connection.connected);
        if (next.connection.connected) setEverConnected(true);
        if (well) {
          misses.current = 0;
          clearTimeout(retryTimer.current);
        } else retryLater.current();
        const open = botIdRef.current;
        if (next.connection.connected && open && !next.bots.some((bot) => bot.id === open))
          handlers.current.onBotGone(open);
        setBotId((previous) => {
          if (!next.connection.connected) return previous;
          if (next.bots.some((bot) => bot.id === previous)) return previous;
          return (
            next.bots.find((bot) => bot.id === next.preferences.defaultBotId)?.id ||
            next.bots[0]?.id ||
            ""
          );
        });
        return next;
      } catch (e) {
        if (epoch !== accountEpoch.current || e instanceof AccountChanged) return null;
        if (e instanceof ApiError && e.status === 401) {
          // A generation that drew an account ends, in every tab; one that drew none shows sign-in here.
          if (accountRefused(drawn.current !== undefined)) return null;
          setAuth(true);
          setBoot(null);
          setCsrf("");
        } else {
          lastSuccess.current = 0;
          setDisconnected(true);
          setAppUnavailable(true);
          retryLater.current();
        }
        return null;
      }
    })();
    bootstrapRequest.current = request;
    void request.finally(() => {
      if (bootstrapRequest.current === request) bootstrapRequest.current = null;
    });
    return request;
  }, []);
  retryLater.current = () => {
    clearTimeout(retryTimer.current);
    if (!mounted.current) return;
    const wait = BOOTSTRAP_RETRY_MS[misses.current++];
    if (wait === undefined) return;
    retryTimer.current = setTimeout(() => {
      if (authRef.current || document.visibilityState === "hidden" || navigator.onLine === false)
        return;
      void refresh();
    }, wait);
  };
  const reconnect = useCallback(async () => {
    if (checkingConnection) return;
    setCheckingConnection(true);
    try {
      await apiRequest("POST /connection/retry");
      await refresh();
      window.dispatchEvent(new Event("agent-interface:reconnect"));
    } catch {
      lastSuccess.current = 0;
      setDisconnected(true);
      setAppUnavailable(true);
    } finally {
      setCheckingConnection(false);
    }
  }, [checkingConnection, refresh]);
  useEffect(() => {
    mounted.current = true;
    // A link that names a chat reads it while bootstrap runs, not after.
    if (start === "bootstrap") {
      prefetchLinkedChat();
      void refresh();
    } else void finishSignOut();
    // Every 45 seconds while the household stream is down. While it is live it announces roster changes,
    // Hermes outages included, so only changes it never announces, such as preferences saved on another
    // device, wait for this, at most about 5 minutes. Focus and showing the page still read at once.
    const id = setInterval(() => {
      if (authRef.current || document.visibilityState === "hidden" || navigator.onLine === false)
        return;
      if (streamUp("household") && Date.now() - lastSuccess.current < BOOTSTRAP_FALLBACK_MS) return;
      void refresh();
    }, 45_000);
    // Coming back online always reads; focus and visibility changes skip a read the last few seconds already made.
    const wake = (skipIfFresh: boolean) => () => {
      setOffline(navigator.onLine === false);
      if (navigator.onLine === false || document.visibilityState === "hidden") return;
      if (skipIfFresh && Date.now() - lastSuccess.current < FRESH_MS) return;
      void refresh();
    };
    const online = wake(false),
      returned = wake(true);
    const lost = () => {
      setOffline(true);
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", lost);
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", returned);
    return () => {
      mounted.current = false;
      clearInterval(id);
      clearTimeout(retryTimer.current);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", lost);
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", returned);
    };
  }, [refresh, start]);
  useEffect(() => {
    if (!boot?.user.id || auth) return;
    const userId = boot.user.id;
    // The server sends `groups` once on every connect and on each catalog change, so connecting or a
    // roster notice does not read the group catalog itself.
    const stream = changeStream(
      "/events",
      () => {
        void refresh();
      },
      undefined,
      {
        groups: () => {
          setGroupsNotifiedFor(userId);
          groupsChanged();
        },
      },
      undefined,
      { onHealth: (up) => reportStream("household", up) },
    );
    // A hidden page or an offline device pauses the stream, keeping its retry budget for when it wakes.
    const wake = () => {
      if (document.visibilityState !== "hidden" && navigator.onLine !== false) stream.open();
      else stream.suspend();
    };
    // The network returning, or a manual retry that reached the server, makes earlier failures stale. The
    // stream holds a signal that arrives while the page is hidden until it is shown.
    const revive = () => stream.reconnect();
    wake();
    const retry = setInterval(wake, 45_000);
    window.addEventListener("online", revive);
    window.addEventListener("focus", wake);
    window.addEventListener("agent-interface:reconnect", revive);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(retry);
      stream.close();
      window.removeEventListener("online", revive);
      window.removeEventListener("focus", wake);
      window.removeEventListener("agent-interface:reconnect", revive);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [boot?.user.id, auth, refresh]);
  const preferences = useRef<ReturnType<typeof preferenceQueue> | null>(null);
  preferences.current ??= preferenceQueue({
    // Model stars have their own endpoint; leaving them out keeps the server's current list.
    send: ({ modelFavorites: _, ...value }) => apiRequest("PATCH /preferences", { body: value }),
    apply: (saved) =>
      setBoot((previous) => (previous ? { ...previous, preferences: saved } : previous)),
    failed: (error) => handlers.current.onError(error.message),
    account: () => accountEpoch.current,
  });
  const savePreferences = (value: Preferences) => preferences.current!.save(value);
  /** Puts preferences a server route answered with on screen, such as a new main assistant. */
  const applyPreferences = (value: Preferences) =>
    setBoot((previous) => (previous ? { ...previous, preferences: value } : previous));
  /** Applies an edit to the newest preferences, including a save still on its way. */
  const editPreferences = (edit: (value: Preferences) => Preferences) =>
    preferences.current!.edit(edit, bootRef.current?.preferences);
  return {
    boot,
    auth,
    botId,
    setBotId,
    disconnected,
    everConnected,
    appUnavailable,
    offline,
    checkingConnection,
    identityEpoch: accountEpoch,
    refresh,
    reconnect,
    savePreferences,
    editPreferences,
    applyPreferences,
    /** This server sends `groups` notices, so a slow fallback poll is enough. */
    // Per account, so another account starts unproven in the same render that switches to it.
    groupsNotified: !!boot?.user.id && groupsNotifiedFor === boot.user.id,
  };
}
