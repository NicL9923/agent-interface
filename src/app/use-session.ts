import { useCallback, useEffect, useRef, useState } from "react";
import type { Bootstrap, Preferences } from "../shared/types";
import { ApiError, changeStream, clearResponseCache, request as apiRequest, setCsrf } from "../client-api";
import { preferenceQueue } from "./preference-queue";
type SessionEvents = {
  onIdentityChange(): void;
  onFirstBootstrap(next: Bootstrap): void;
  onError(message: string): void;
  /** The open assistant left this person's roster, as when another member made it personal. */
  onBotGone(botId: string): void;
};
/** A bootstrap this recent already answers a focus or visibility change, such as alt-tabbing back. */
const FRESH_MS = 5_000;
export function useSession(events: SessionEvents) {
  const handlers = useRef(events);
  handlers.current = events;
  const initialDestination = useRef(false);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [auth, setAuth] = useState(false);
  const [botId, setBotId] = useState(
    () => new URLSearchParams(location.search).get("bot") || "",
  );
  const [disconnected, setDisconnected] = useState(false);
  const [appUnavailable, setAppUnavailable] = useState(false);
  const [offline, setOffline] = useState(() => navigator.onLine === false);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const bootstrapRequest = useRef<Promise<Bootstrap | null> | null>(null);
  const lastBootstrap = useRef<Bootstrap | null>(null);
  const identityEpoch = useRef(0);
  const lastSuccess = useRef(0);
  // Responses cached for one account must never answer for the next.
  const nextIdentity = () => {
    identityEpoch.current++;
    lastSuccess.current = 0;
    clearResponseCache();
  };
  const bootRef = useRef(boot);
  bootRef.current = boot;
  const botIdRef = useRef(botId);
  botIdRef.current = botId;
  const authRef = useRef(auth);
  authRef.current = auth;
  const refresh = useCallback((): Promise<Bootstrap | null> => {
    if (bootstrapRequest.current) return bootstrapRequest.current;
    const epoch = identityEpoch.current;
    const marked = preferences.current?.mark() ?? -1;
    const request = (async () => {
      try {
        const next = await apiRequest("GET /bootstrap", { query: { roster: "lean" } });
        if (epoch !== identityEpoch.current) return null;
        // A bootstrap that found Hermes down, like a failed one, is no reason to hold back the next look.
        lastSuccess.current = next.connection.connected ? Date.now() : 0;
        if (bootRef.current && bootRef.current.user.id !== next.user.id) {
          nextIdentity();
          handlers.current.onIdentityChange();
        }
        if (!initialDestination.current) {
          initialDestination.current = true;
          handlers.current.onFirstBootstrap(next);
        }
        setCsrf(next.csrfToken ?? "");
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
        if (epoch !== identityEpoch.current) return null;
        if (e instanceof ApiError && e.status === 401) {
          nextIdentity();
          handlers.current.onIdentityChange();
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
    void refresh();
    const id = setInterval(() => {
      if (!authRef.current && document.visibilityState !== "hidden" && navigator.onLine !== false) void refresh();
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
  }, [refresh]);
  useEffect(() => {
    if (!boot?.user.id || auth) return;
    const stream = changeStream("/events", () => void refresh());
    const wake = () => {
      if (document.visibilityState !== "hidden" && navigator.onLine !== false) stream.open();
      else stream.close();
    };
    wake();
    const retry = setInterval(wake, 45_000);
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("agent-interface:reconnect", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(retry);
      stream.close();
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("agent-interface:reconnect", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [boot?.user.id, auth, refresh]);
  const preferences = useRef<ReturnType<typeof preferenceQueue> | null>(null);
  preferences.current ??= preferenceQueue({
    // Model stars have their own endpoint; leaving them out keeps the server's current list.
    send: ({ modelFavorites: _, ...value }) => apiRequest("PATCH /preferences", { body: value }),
    apply: saved => setBoot(previous => previous ? { ...previous, preferences: saved } : previous),
    failed: error => handlers.current.onError(error.message),
    account: () => identityEpoch.current,
  });
  const savePreferences = (value: Preferences) => preferences.current!.save(value);
  /** Applies an edit to the newest preferences, including a save still on its way. */
  const editPreferences = (edit: (value: Preferences) => Preferences) =>
    preferences.current!.edit(edit, bootRef.current?.preferences);
  const signedIn = () => {
    nextIdentity();
    bootstrapRequest.current = null;
    void refresh();
  };
  const signedOut = () => {
    nextIdentity();
    bootstrapRequest.current = null;
    setCsrf("");
    setBoot(null);
    setAuth(true);
  };
  return {
    boot, auth, botId, setBotId, disconnected, appUnavailable, offline, checkingConnection,
    identityEpoch, refresh, reconnect, savePreferences, editPreferences, signedIn, signedOut,
  };
}
