import { useEffect, useState } from "react";
export type InstallEvent = Event & { prompt: () => Promise<void> };
/** Whether a media query matches now, following changes such as a resize or a mouse plugged in. */
export function useMediaQuery(media: string) {
  const [matches, setMatches] = useState(() => matchMedia(media).matches);
  useEffect(() => {
    const query = matchMedia(media);
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [media]);
  return matches;
}
export const useMobile = () => useMediaQuery("(max-width: 620px)");
/**
 * Whether a mouse or trackpad is attached, the closest a page can come to knowing a keyboard is.
 * Touch-only phones and tablets have neither, so keyboard hints stay off there.
 */
export const useFinePointer = () => useMediaQuery("(any-pointer: fine)");
/** How often a long-open tab or installed app asks for a newer build. Browsers only check on navigation. */
export const UPDATE_CHECK_MS = 30 * 60_000;
export interface AppUpdate {
  applying: boolean;
  apply(): void;
}
/**
 * Once the page is idle, asks the active worker to cache the lazy screens for offline use. The
 * message keeps the worker alive while it downloads, and every page load finishes what an earlier
 * run missed. Returns a cancel function.
 */
function warmOfflineWhenIdle(container: ServiceWorkerContainer) {
  const run = async () => {
    try { (await container.ready).active?.postMessage({ type: "WARM" }); } catch { /* Best effort. */ }
  };
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(() => void run(), { timeout: 5000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(() => void run(), 2000);
  return () => clearTimeout(id);
}

export function useAppInstall() {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let cancelled = false, cancelWarm = () => {}, registration: ServiceWorkerRegistration | undefined, checkedAt = Date.now();
    // A page loaded without a worker gets its first one by claim, which is not an update.
    let controlled = !!navigator.serviceWorker.controller;
    const reload = () => location.reload();
    const ready = (apply: () => void) => {
      if (cancelled) return;
      setUpdate({ applying: false, apply: () => { setUpdate(current => current && { ...current, applying: true }); apply(); } });
    };
    const waiting = () => ready(() => {
      const worker = registration?.waiting;
      // Nothing left waiting means another tab already switched; this page only needs the new files.
      if (!worker) return reload();
      navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
      worker.postMessage({ type: "SKIP_WAITING" });
    });
    // Another tab applied the update, so this page still runs the previous build.
    const switched = () => {
      if (controlled) ready(reload);
      controlled = true;
    };
    const check = () => {
      if (!registration || Date.now() - checkedAt < 5 * 60_000) return;
      checkedAt = Date.now();
      void registration.update().catch(() => { /* Offline or a server restart; the next check retries. */ });
    };
    const visible = () => { if (document.visibilityState === "visible") check(); };
    navigator.serviceWorker.addEventListener("controllerchange", switched);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", check);
    const timer = setInterval(() => { checkedAt = 0; check(); }, UPDATE_CHECK_MS);
    void navigator.serviceWorker
      .register("/sw.js")
      .then((value) => {
        if (cancelled) return;
        registration = value;
        cancelWarm = warmOfflineWhenIdle(navigator.serviceWorker);
        if (value.waiting) waiting();
        value.addEventListener("updatefound", () => {
          const worker = value.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) waiting();
          });
        });
      })
      .catch(() =>
        setNotice("Offline installation is unavailable in this browser."),
      );
    return () => {
      cancelled = true;
      cancelWarm();
      clearInterval(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", switched);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", check);
    };
  }, []);
  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);
  return { update, installEvent, notice, setNotice };
}
