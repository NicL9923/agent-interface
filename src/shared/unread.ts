import type { Bot, Message } from "./types";

/** The latest Hermes message time this person has had on screen, per chat. */
export type ReadThrough = Record<string, string>;

const time = (value: string | undefined) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * The server's mark: the latest message arrived after this person last read a chat they have
 * opened before. A chat they never opened has no read time and is not marked.
 */
export function unreadSince(lastMessageAt: string | undefined, readAt: number | undefined) {
  const at = time(lastMessageAt);
  return readAt !== undefined && at !== undefined && at > readAt;
}

/**
 * Whether home marks a chat unread. The server compares Hermes's latest message with the
 * person's last read, but only learns about a read on the next roster refresh. A chat on
 * screen, or read through its latest message since, shows as read meanwhile. Both sides use
 * Hermes's timestamps, so a client clock running ahead cannot hide a newer message.
 */
export function isUnread(bot: Bot, shownBotId: string | undefined, readThrough: ReadThrough) {
  if (!bot.unread || bot.id === shownBotId) return false;
  const latest = time(bot.lastMessage?.at), read = time(readThrough[bot.id]);
  return latest === undefined || read === undefined || latest > read;
}

/** Roster activity that means the assistant waits on a person: an approval, a question or a secure request. */
export const decisionStates: ReadonlySet<Bot["activity"]> = new Set(["waiting", "blocked"]);

/**
 * The app badge: visible assistants marked unread, plus those waiting on a decision that are
 * not already counted. Pass the bots this person can see and the unread rule that applies.
 */
export function badgeCount(bots: Pick<Bot, "id" | "activity">[], unread: (botId: string) => boolean, pending: (botId: string) => boolean = () => false) {
  return new Set(bots.filter(bot => unread(bot.id) || decisionStates.has(bot.activity) || pending(bot.id)).map(bot => bot.id)).size;
}

/** The newest time among a chat's roster preview and its loaded messages. */
export function latestMessageAt(bot: Bot | undefined, messages: Message[] | undefined) {
  let latest = bot?.lastMessage?.at;
  for (const message of messages ?? []) {
    if (message.id.endsWith("-inflight")) continue;
    const at = time(message.createdAt);
    if (at !== undefined && (time(latest) ?? -Infinity) < at) latest = message.createdAt;
  }
  return latest;
}
