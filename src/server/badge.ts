import { badgeCount, unreadSince } from "../shared/unread.js";
import type { Bot, Runtime } from "../shared/types.js";
import { visible } from "./bot-access.js";
import type { Store } from "./store.js";

/** A notification about to reach this person, which the roster may not reflect yet. */
export type Arriving = { botId?: string; kind?: string };

/**
 * The app badge for one person, as their home would show it: assistants they see with the
 * unread mark, plus those waiting on a decision, by the roster or by an approval this person
 * was notified about that is not resolved yet. Notifications being delivered count too: an
 * approval waits on a decision, and other news is unread in a chat they opened before. Alerts
 * and clears count the same way. Undefined without a connected roster, so a push leaves the
 * badge as it was.
 */
export function badgeFor(bots: Bot[] | undefined, store: Store, userId: string, arriving: Arriving[] = []) {
  if (!bots || bots.some(bot => bot.activity === "disconnected")) return undefined;
  const reads = store.chatReads(userId);
  const seen = bots.filter(bot => visible({ ...bot, ...store.presentation(bot.id) }, userId));
  const lastAt = new Map(seen.map(bot => [bot.id, bot.lastMessage?.at]));
  const news = new Set(arriving.filter(item => item.kind !== "approval" && item.kind !== "security").map(item => item.botId));
  const decisions = store.pendingDecisions(userId);
  for (const item of arriving) if (item.kind === "approval" && item.botId) decisions.add(item.botId);
  return badgeCount(seen,
    botId => unreadSince(lastAt.get(botId), reads.get(botId)) || news.has(botId) && reads.has(botId),
    botId => decisions.has(botId));
}

/** Reads Hermes's roster at most once for a pass over many people. A failed read counts no badge. */
export function rosterOnce(runtime: Pick<Runtime, "listBots">) {
  let read: Promise<Bot[] | undefined> | undefined;
  return () => read ??= Promise.resolve().then(() => runtime.listBots()).catch(() => undefined);
}
