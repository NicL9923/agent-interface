import { useCallback, useEffect, useRef, useState } from "react";
import { write } from "../client-api";

const promptKey = "agent-interface:notifications-prompt:v1";
let promptedInPage = false;
function alreadyPrompted() {
  try { return localStorage.getItem(promptKey) === "shown"; }
  catch { return promptedInPage; }
}
function rememberPrompt() {
  promptedInPage = true;
  try { localStorage.setItem(promptKey, "shown"); } catch { /* Keep this page's decision when storage is unavailable. */ }
}
function environmentMessage(vapid?: string) {
  if (!vapid) return "Notifications are not configured on this installation.";
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone;
  if (ios && !standalone) return "On iPhone or iPad, choose Share > Add to Home Screen, then open the installed app to enable notifications.";
  if (!window.isSecureContext || !("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator))
    return "Notifications are unavailable in this browser. Open the app in a browser that supports Web Push over HTTPS.";
  if (Notification.permission === "denied") return "Notifications are blocked for this app. Allow them in your browser or device settings, then return here.";
  return "";
}
const initialState = { enabled: false, checking: true, busy: false, canEnable: false, message: "Checking notifications on this device…", error: "" };

export function useDeviceNotifications(userId?: string, vapid?: string) {
  const [state, setState] = useState(initialState);
  const [prompt, setPrompt] = useState(false);
  const user = useRef(userId);
  user.current = userId;
  const registration = useRef<ServiceWorkerRegistration | undefined>(undefined);
  const busy = useRef(false);
  const readEpoch = useRef(0);
  const latestRefresh = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(async () => {
    if (!userId || busy.current) return;
    const epoch = ++readEpoch.current;
    const current = () => epoch === readEpoch.current && user.current === userId;
    const message = environmentMessage(vapid);
    if (message) {
      registration.current = undefined;
      if (current()) setState({ ...initialState, checking: false, message });
      return;
    }
    setState((previous) => ({ ...previous, checking: true, error: "" }));
    try {
      const worker = await navigator.serviceWorker.getRegistration();
      if (!current()) return;
      registration.current = worker;
      if (!worker?.active) {
        setState({ ...initialState, checking: false, message: "Notifications are not ready in this browser yet. Reload the app after installation finishes." });
        return;
      }
      const subscription = await worker.pushManager.getSubscription();
      if (!current()) return;
      const result = subscription ? await write<{ registered: boolean }>("/push/subscriptions/status", { endpoint: subscription.endpoint }) : { registered: false };
      if (!current()) return;
      const enabled = Notification.permission === "granted" && !!subscription && result.registered === true;
      setState({ enabled, checking: false, busy: false, canEnable: true, error: "",
        message: enabled ? "Notifications are enabled for your account on this device." : "Enable notifications for completed work and requests that need your attention." });
    } catch (error) {
      if (current()) setState({ ...initialState, checking: false, error: (error as Error).message,
        message: "Couldn't check notifications on this device. Retry before changing them." });
    }
  }, [userId, vapid]);
  latestRefresh.current = refresh;
  useEffect(() => {
    setPrompt(false);
    registration.current = undefined;
    setState(initialState);
    void refresh();
    const visible = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    navigator.serviceWorker?.addEventListener("controllerchange", visible);
    return () => {
      ++readEpoch.current;
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
      navigator.serviceWorker?.removeEventListener("controllerchange", visible);
    };
  }, [refresh]);
  useEffect(() => {
    if (!userId || !vapid || state.checking || state.enabled || state.error || alreadyPrompted()) return;
    if ("Notification" in window && Notification.permission !== "default") return;
    rememberPrompt();
    setPrompt(true);
  }, [userId, vapid, state.checking, state.enabled, state.error]);

  const enable = async () => {
    if (!userId || busy.current || !state.canEnable) return;
    const account = userId;
    const worker = registration.current;
    if (!worker) return;
    busy.current = true;
    ++readEpoch.current;
    setState((previous) => ({ ...previous, busy: true, error: "" }));
    let created: PushSubscription | undefined;
    try {
      // Run before any await so browsers receive the explicit Enable gesture.
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (user.current !== account) return;
      if (permission !== "granted") {
        setState({ ...initialState, checking: false, message: permission === "denied"
          ? "Notifications are blocked for this app. Allow them in your browser or device settings, then return here."
          : "Notifications stay disabled. You can enable them later in Settings > Notifications.", canEnable: permission !== "denied" });
        return;
      }
      const existing = await worker.pushManager.getSubscription();
      if (user.current !== account) return;
      const bytes = Uint8Array.from(atob(vapid!.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
      const subscription = existing || await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      if (!existing) created = subscription;
      if (user.current !== account) { await created?.unsubscribe(); return; }
      await write("/push/subscriptions", subscription.toJSON());
      if (user.current === account) {
        setState({ ...initialState, checking: false, enabled: true, canEnable: true,
          message: "Notifications are enabled for your account on this device." });
        setPrompt(false);
      }
    } catch (error) {
      if (created) await created.unsubscribe().catch(() => {});
      if (user.current === account) setState((previous) => ({ ...previous, enabled: false, busy: false, error: (error as Error).message }));
    } finally {
      busy.current = false;
      if (user.current === account) setState((previous) => ({ ...previous, busy: false }));
      else void latestRefresh.current();
    }
  };
  const disable = async () => {
    if (!userId) return;
    if (busy.current) throw new Error("Wait for the notification change to finish before signing out.");
    const account = userId;
    busy.current = true;
    ++readEpoch.current;
    setState((previous) => ({ ...previous, busy: true, error: "" }));
    let removed = false;
    let subscription: PushSubscription | null = null;
    try {
      const worker = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
      subscription = worker?.pushManager ? await worker.pushManager.getSubscription() : null;
      if (user.current !== account) return;
      if (subscription) {
        await write("/push/subscriptions", { endpoint: subscription.endpoint }, "DELETE");
        removed = true;
        if (user.current === account) setState((previous) => ({ ...previous, enabled: false }));
        const unsubscribed = await subscription.unsubscribe();
        if (!unsubscribed) throw new Error("Notifications are disabled for your account, but this browser couldn't remove its subscription. Try turning them off again or use browser settings.");
      }
      if (user.current === account) setState((previous) => ({ ...previous, enabled: false, busy: false,
        message: "Notifications are disabled on this device. You can enable them here later." }));
    } catch (error) {
      // A failed DELETE response can still have removed the server registration.
      // Recheck its owner before reporting this device as enabled.
      const confirmed = !removed && subscription && user.current === account
        ? await write<{ registered: boolean }>("/push/subscriptions/status", { endpoint: subscription.endpoint }).catch(() => null)
        : null;
      if (user.current === account) setState((previous) => ({ ...previous,
        enabled: !removed && "Notification" in window && Notification.permission === "granted" && confirmed?.registered === true,
        canEnable: removed || !!confirmed, busy: false, error: (error as Error).message }));
      throw error;
    } finally {
      busy.current = false;
      if (user.current === account) setState((previous) => ({ ...previous, busy: false }));
      else void latestRefresh.current();
    }
  };
  return { ...state, prompt, enable, disable, refresh, dismissPrompt: () => setPrompt(false) };
}
