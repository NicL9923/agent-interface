import { useEffect } from "react";
import { request } from "../client-api";
/** The server forgets a client after 45 seconds without a beat. */
const HEARTBEAT_MS = 15_000;
/** A focused window nobody has touched for this long no longer counts as reading. */
export const IDLE_MS = 5 * 60_000;
// Each tab reports separately, so closing one never ends another's reading. Plain-HTTP previews
// lack randomUUID, and this module loads with the app shell.
const client = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const inputs = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
// One report at a time, so leaving one chat can never land after arriving in the next.
let reports = Promise.resolve();
function report(botId: string, state: "active" | "left" | "idle") {
  reports = reports.then(() => request("PUT /bots/:id/presence", { params: { id: botId }, body: { client, state } })).then(() => {}, () => {});
}

/** Closes this browser's notifications for a chat now on screen. Routine results open elsewhere. */
async function closeNotifications(botId: string) {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  for (const notification of await registration?.getNotifications() ?? []) {
    const url = new URL(String(notification.data?.url ?? "/"), location.origin);
    if (url.searchParams.get("bot") === botId && !url.searchParams.has("routine")) notification.close();
  }
}

/**
 * Tells the server which chat this tab shows while someone is using it, so notifications for it
 * stay quiet on every device and the chat counts as read. botId is empty when no chat is on screen.
 */
export function useChatPresence(botId: string | undefined, userId: string | undefined) {
  useEffect(() => {
    if (!botId || !userId) return;
    let reading = false, lastInput = Date.now();
    const attended = () => document.visibilityState === "visible" && document.hasFocus();
    const update = () => {
      const now = attended() && Date.now() - lastInput < IDLE_MS;
      if (now) {
        if (!reading) void closeNotifications(botId).catch(() => {});
        report(botId, "active");
      // Leaving after reading marks the chat read until now. Walking away from it does not.
      } else if (reading) report(botId, attended() ? "idle" : "left");
      reading = now;
    };
    const input = () => {
      lastInput = Date.now();
      if (!reading) update();
    };
    update();
    const timer = setInterval(update, HEARTBEAT_MS);
    for (const name of inputs) window.addEventListener(name, input, { passive: true });
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      for (const name of inputs) window.removeEventListener(name, input);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
      if (reading) report(botId, "left");
    };
  }, [botId, userId]);
}
