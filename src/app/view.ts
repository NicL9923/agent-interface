import { useEffect } from "react";
import type { Bot, Preferences } from "../shared/types";
export type View = "conversation" | "today" | "group" | "find";
/** An assistant's terminal card opened the shell; each opening is a new number. The command is pasted once, never run. */
export type TerminalOpening = { at: number; command?: string };
// Modal overlays. Only one can be interactive at a time.
export type Panel =
  | { kind: "preferences"; destination?: { kind: "following" } | { kind: "section"; id: string } | { kind: "signout" } }
  | { kind: "integrations" | "upgrade" | "usage" }
  /** take asks the desktop to take control once it connects; each request is a new number. */
  | { kind: "computer"; tab?: "desktop" | "terminal"; take?: number; terminal?: TerminalOpening }
  | { kind: "settings"; bot: Bot | "new" }
  | { kind: "details"; botId: string; newSection?: boolean }
  | { kind: "routine"; botId: string; routineId: string; resultId?: string };
const views: View[] = ["today", "find"];
/**
 * A group chat opens by `?view=group&room=<id>`. A link to the old Group chats page,
 * `?view=groups`, opens home, where the rooms now live.
 */
export function initialRoom() {
  const query = new URLSearchParams(location.search);
  return query.get("view") === "group" ? query.get("room") ?? "" : "";
}
export function initialView(): View {
  const view = new URLSearchParams(location.search).get("view");
  if (view === "group") return initialRoom() ? "group" : "conversation";
  return views.find(item => item === view) ?? "conversation";
}
export function initialPanel(): Panel | null {
  const query = new URLSearchParams(location.search);
  if (query.get("computer") === "1") return query.get("computerTab") === "terminal" ? { kind: "computer", tab: "terminal" } : { kind: "computer" };
  return query.get("routine") && query.get("bot")
    ? { kind: "routine", botId: query.get("bot")!, routineId: query.get("routine")! }
    : null;
}
/** Whether the first URL names a destination, such as a notification link. */
export function hasDestination() {
  const query = new URLSearchParams(location.search);
  // The old Group chats page is home now, which is where a phone starts anyway.
  return ["bot", "view", "routine", "computer"].some(key => query.has(key) && !(key === "view" && query.get(key) === "groups"));
}
// An explicit destination in the first URL wins over the start page preference.
export function startsOnToday({ startPage, defaultBotId }: Preferences) {
  return !hasDestination() && (startPage === "today" || startPage !== "assistant" && !defaultBotId);
}
export function useUrlSync(view: View, panel: Panel | null, botId: string, userId?: string, roomId = "") {
  const routineId = panel?.kind === "routine" ? panel.routineId : null;
  useEffect(() => {
    const url = new URL(location.href);
    if (view === "conversation") url.searchParams.delete("view"); else url.searchParams.set("view", view);
    if (view === "group" && roomId) url.searchParams.set("room", roomId); else url.searchParams.delete("room");
    if (routineId !== null) url.searchParams.set("routine", routineId); else url.searchParams.delete("routine");
    if (botId && userId) url.searchParams.set("bot", botId);
    history.replaceState(null, "", url);
  }, [view, routineId, botId, userId, roomId]);
}
/** A message a link opens the live conversation at: `?bot=<id>&message=<messageId>`. */
export function initialMessage() {
  const query = new URLSearchParams(location.search);
  const botId = query.get("bot"), messageId = query.get("message");
  return botId && messageId ? { botId, messageId } : null;
}
/** Once the conversation has opened, the message stays out of the address, so a reload opens at the latest. */
export function clearMessageParam() {
  const url = new URL(location.href);
  if (!url.searchParams.has("message")) return;
  url.searchParams.delete("message");
  history.replaceState(history.state, "", url);
}
