import { useEffect } from "react";

/** What a notification tap can ask an open window to show. */
export type Destination = { view: "today" } | { botId: string; routineId?: string; messageId?: string };

/**
 * The view or chat an app address names, read the way the first load reads its address. Only this
 * origin's `/` opens anything; an address that names neither Today nor a chat is null.
 */
export function destinationOf(value: unknown): Destination | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try { url = new URL(value, location.origin); } catch { return null; }
  if (url.origin !== location.origin || url.pathname !== "/") return null;
  if (url.searchParams.get("view") === "today") return { view: "today" };
  const botId = url.searchParams.get("bot");
  if (!botId) return null;
  return { botId, routineId: url.searchParams.get("routine") || undefined, messageId: url.searchParams.get("message") || undefined };
}

/**
 * Opens what this page's worker asks for when a notification is tapped while the app is open, and
 * answers on the port the worker sent, so the worker does not reload the app over it. See openChat
 * in scripts/service-worker.js. A message from anything but the worker controlling this page, or
 * one that names nothing to open, is ignored and left unanswered.
 */
export function useWorkerOpens(open: (destination: Destination) => void) {
  useEffect(() => {
    const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
    if (!container) return;
    const heard = (event: MessageEvent) => {
      if (!container.controller || event.source !== container.controller || event.data?.type !== "OPEN_CHAT") return;
      const destination = destinationOf(event.data.url);
      if (!destination) return;
      open(destination);
      event.ports[0]?.postMessage({ opened: true });
    };
    container.addEventListener("message", heard);
    return () => container.removeEventListener("message", heard);
  }, [open]);
}
