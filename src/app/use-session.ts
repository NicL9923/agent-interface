import { useCallback, useEffect, useRef, useState } from "react";
import type { Bootstrap, Preferences } from "../shared/types";
import { AccountChanged, ApiError, changeStream, request as apiRequest, setCsrf } from "../client-api";
import { preferenceQueue } from "./preference-queue";
import { prefetchLinkedChat, settleLinkedChat } from "./linked-chat";
import { accountEpoch, accountNamed, accountRefused, rememberChats } from "./account-epoch";
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
/** A bootstrap this recent already answers a focus or visibility change, such as alt-tabbing back. */
const FRESH_MS = 5_000;
/** How often bootstrap is read while the household stream is live, for changes it does not announce. */
export const BOOTSTRAP_FALLBACK_MS = 5 * 60_000;
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
  const [botId, setBotId] = useState(
    () => new URLSearchParams(location.search).get("bot") || "",
  );
  const [disconnected, setDisconnected] = useState(false);
  const [appUnavailable, setAppUnavailable] = useState(false);
  const [offline, setOffline] = useState(() => navigator.onLine === false);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const bootstrapRequest = useRef<Promise<Bootstrap | null> | null>(null);
  const lastBootstrap = useRef<Bootstrap | null>(null);
  /** The account this generation drew, set as an answer is applied, before it renders. */
  const drawn = useRef<string | undefined>(undefined);
  const lastSuccess = useRef(0);
  const bootRef = useRef(boot);
  bootRef.current = boot;
  const botIdRef = useRef(botId);
  botIdRef.current = botId;
  const authRef = useRef(auth);
  authRef.current = auth;
  const refresh = useCallback((): Promise<Bootstrap | null> => {
    if (bootstrapRequest.current) return bootstrapRequest.current;
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
        // A bootstrap that found Hermes down, like a failed one, is no reason to hold back the next look.
        lastSuccess.current = next.connection.connected ? Date.now() : 0;
        if (!initialDestination.current) {
          initialDestination.current = true;
          handlers.current.onFirstBootstrap(next);
        }
        setCsrf(next.csrfToken ?? "");
        if (next.connection.connected) rememberChats(next.user.id, next.bots.map(bot => bot.id));
        // A save that overlapped this read may be newer than its preferences; keep the saved copy.
        const stalePreferences = !preferences.current?.fresh(marked);
        // An unchanged poll returns the cached object; keeping the derived state lets React skip the app render.
        // A read whose preferences were held back is not remembered, so the next one reconciles them.
        const unchanged = lastBootstrap.current === next;
        lastBootstrap.current = stalePreferences ? null : next;
        setBoot((previous) => unchanged && previous ? previous : { ...next,
          bots: !next.connection.connected && !next.bots.length && previous?.user.id === next.user.id
            ? previous.bots : next.bots,
          preferences: stalePreferences && previous?.user.id === next.user.id ? previous.preferences : next.preferences,
        });
        setAuth(false);
        setAppUnavailable(false);
        setDisconnected(!next.connection.connected);
        const open = botIdRef.current;
        if (next.connection.connected && open && !next.bots.some(bot => bot.id === open)) handlers.current.onBotGone(open);
        setBotId((previous) => {
          if (!next.connection.connected) return previous;
          if (next.bots.some(bot => bot.id === previous)) return previous;
          return next.bots.find(bot => bot.id === next.preferences.defaultBotId)?.id || next.bots[0]?.id || "";
        });
        return next;
      } catch (e) {
        if (epoch !== accountEpoch.current || e instanceof AccountChanged) return null;
        if (e instanceof ApiError && e.status === 401) {
          // A generation that drew an account ends, in every tab; one that drew none shows sign-in here.
          if (accountRefused(drawn.current !== undefined)) return null;
          setAuth(true); setBoot(null); setCsrf("");
        } else {
          lastSuccess.current = 0;
          setDisconnected(true); setAppUnavailable(true);
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
  const reconnect = useCallback(async () => {
    if (checkingConnection) return;
    setCheckingConnection(true);
    try {
      await apiRequest("POST /connection/retry");
      await refresh();
      window.dispatchEvent(new Event("agent-interface:reconnect"));
    } catch {
      lastSuccess.current = 0;
      setDisconnected(true); setAppUnavailable(true);
    } finally {
      setCheckingConnection(false);
    }
  }, [checkingConnection, refresh]);
  useEffect(() => {
    // A link that names a chat reads it while bootstrap runs, not after.
    if (start === "bootstrap") {
      prefetchLinkedChat();
      void refresh();
    }
    // Every 45 seconds while the household stream is down. While it is live it announces roster changes,
    // Hermes outages included, so only changes it never announces, such as preferences saved on another
    // device, wait for this, at most about 5 minutes. Focus and showing the page still read at once.
    const id = setInterval(() => {
      if (authRef.current || document.visibilityState === "hidden" || navigator.onLine === false) return;
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
    const online = wake(false), returned = wake(true);
    const lost = () => { setOffline(true); };
    window.addEventListener("online", online);
    window.addEventListener("offline", lost);
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", returned);
    return () => {
      clearInterval(id);
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
    const stream = changeStream("/events", () => { void refresh(); }, undefined, { groups: () => { setGroupsNotifiedFor(userId); groupsChanged(); } },
      undefined, { onHealth: up => reportStream("household", up) });
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
    apply: saved => setBoot(previous => previous ? { ...previous, preferences: saved } : previous),
    failed: error => handlers.current.onError(error.message),
    account: () => accountEpoch.current,
  });
  const savePreferences = (value: Preferences) => preferences.current!.save(value);
  /** Puts preferences a server route answered with on screen, such as a new main assistant. */
  const applyPreferences = (value: Preferences) => setBoot(previous => previous ? { ...previous, preferences: value } : previous);
  /** Applies an edit to the newest preferences, including a save still on its way. */
  const editPreferences = (edit: (value: Preferences) => Preferences) =>
    preferences.current!.edit(edit, bootRef.current?.preferences);
  return {
    boot, auth, botId, setBotId, disconnected, appUnavailable, offline, checkingConnection,
    identityEpoch: accountEpoch, refresh, reconnect, savePreferences, editPreferences, applyPreferences,
    /** This server sends `groups` notices, so a slow fallback poll is enough. */
    // Per account, so another account starts unproven in the same render that switches to it.
    groupsNotified: !!boot?.user.id && groupsNotifiedFor === boot.user.id,
  };
}
