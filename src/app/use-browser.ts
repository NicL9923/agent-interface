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
export function useAppInstall() {
  const [workerUpdate, setWorkerUpdate] = useState<ServiceWorker | null>(null);
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    void navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        if (cancelled) return;
        if (registration.waiting) setWorkerUpdate(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (
              worker.state === "installed" &&
              navigator.serviceWorker.controller
            )
              setWorkerUpdate(registration.waiting);
          });
        });
      })
      .catch(() =>
        setNotice("Offline installation is unavailable in this browser."),
      );
    return () => {
      cancelled = true;
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
  return { workerUpdate, installEvent, notice, setNotice };
}
