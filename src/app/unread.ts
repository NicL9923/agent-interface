import { useEffect, useState } from "react";
import type { Bot, Message } from "../shared/types";

/** The latest Hermes message time this person has had on screen, per chat. */
export type ReadThrough = Record<string, string>;

const time = (value: string | undefined) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
};

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

/** Records how far the chat on screen has been read, so home stops marking it once the person leaves. */
export function useReadThrough(userId: string | undefined, shownBotId: string | undefined, latest: string | undefined) {
  const [readThrough, setReadThrough] = useState<ReadThrough>({});
  // Another account's reads never apply.
  useEffect(() => setReadThrough({}), [userId]);
  useEffect(() => {
    if (!shownBotId || !latest) return;
    setReadThrough(previous => (time(previous[shownBotId]) ?? -Infinity) >= (time(latest) ?? -Infinity)
      ? previous : { ...previous, [shownBotId]: latest });
  }, [shownBotId, latest]);
  return readThrough;
}
