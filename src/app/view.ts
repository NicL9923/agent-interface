import { useEffect } from "react";
import type { Bot, Preferences } from "../shared/types";
export type View = "conversation" | "today" | "groups" | "find";
// Modal overlays. Only one can be interactive at a time.
export type Panel =
  | { kind: "preferences" | "integrations" | "upgrade" | "computer" }
  | { kind: "settings"; bot: Bot | "new" }
  | { kind: "routine"; botId: string; routineId: string; resultId?: string };
const views: View[] = ["today", "groups", "find"];
export function initialView(): View {
  const view = new URLSearchParams(location.search).get("view");
  return views.find(item => item === view) ?? "conversation";
}
export function initialPanel(): Panel | null {
  const query = new URLSearchParams(location.search);
  if (query.get("computer") === "1") return { kind: "computer" };
  return query.get("routine") && query.get("bot")
    ? { kind: "routine", botId: query.get("bot")!, routineId: query.get("routine")! }
    : null;
}
// An explicit destination in the first URL wins over the start page preference.
export function startsOnToday({ startPage, defaultBotId }: Preferences) {
  const query = new URLSearchParams(location.search);
  return !["bot", "view", "routine", "computer"].some(key => query.has(key)) &&
    (startPage === "today" || startPage !== "assistant" && !defaultBotId);
}
export function useUrlSync(view: View, panel: Panel | null, botId: string, userId?: string) {
  const routineId = panel?.kind === "routine" ? panel.routineId : null;
  useEffect(() => {
    const url = new URL(location.href);
    if (view === "conversation") url.searchParams.delete("view"); else url.searchParams.set("view", view);
    if (routineId !== null) url.searchParams.set("routine", routineId); else url.searchParams.delete("routine");
    if (botId && userId) url.searchParams.set("bot", botId);
    history.replaceState(null, "", url);
  }, [view, routineId, botId, userId]);
}
