import { useCallback, useEffect, useRef, useState } from "react";
import type { Bootstrap, Preferences } from "../shared/types";
import { api, ApiError, changeStream, clearResponseCache, setCsrf, write } from "../client-api";
import { preferenceQueue } from "./preference-queue";
type SessionEvents = {
  onIdentityChange(): void;
  onFirstBootstrap(next: Bootstrap): void;
  onError(message: string): void;
  /** The open assistant left this person's roster, as when another member made it personal. */
  onBotGone(botId: string): void;
};
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
  // Responses cached for one account must never answer for the next.
  const nextIdentity = () => {
    identityEpoch.current++;
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
    const request = (async () => {
      try {
        const next = await api<Bootstrap>("/bootstrap?roster=lean");
        if (epoch !== identityEpoch.current) return null;
        if (bootRef.current && bootRef.current.user.id !== next.user.id) {
          nextIdentity();
          handlers.current.onIdentityChange();
        }
        if (!initialDestination.current) {
          initialDestination.current = true;
          handlers.current.onFirstBootstrap(next);
        }
        setCsrf(next.csrfToken ?? "");
        // An unchanged poll returns the cached object; keeping the derived state lets React skip the app render.
        const unchanged = lastBootstrap.current === next;
        lastBootstrap.current = next;
        setBoot((previous) => unchanged && previous ? previous : { ...next,
          bots: !next.connection.connected && !next.bots.length && previous?.user.id === next.user.id
            ? previous.bots : next.bots,
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
      await write("/connection/retry", {});
      await refresh();
      window.dispatchEvent(new Event("agent-interface:reconnect"));
    } catch {
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
    const wake = () => {
      setOffline(navigator.onLine === false);
      if (navigator.onLine !== false && document.visibilityState !== "hidden") void refresh();
    };
    const lost = () => { setOffline(true); };
    window.addEventListener("online", wake);
    window.addEventListener("offline", lost);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", lost);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
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
    send: value => write<Preferences>("/preferences", value, "PATCH"),
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
