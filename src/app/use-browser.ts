import { useEffect, useState } from "react";
export type InstallEvent = Event & { prompt: () => Promise<void> };
export function useMobile() {
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 620px)").matches);
  useEffect(() => {
    const query = matchMedia("(max-width: 620px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
}
/** How often a long-open tab or installed app asks for a newer build. Browsers only check on navigation. */
export const UPDATE_CHECK_MS = 30 * 60_000;
export interface AppUpdate {
  applying: boolean;
  apply(): void;
}
export function useAppInstall() {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let cancelled = false, registration: ServiceWorkerRegistration | undefined, checkedAt = Date.now();
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
