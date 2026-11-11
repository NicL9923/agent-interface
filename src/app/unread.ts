import { useEffect, useMemo, useState } from "react";
import type { Bot, Message } from "../shared/types";
import { latestMessageAt, type ReadThrough } from "../shared/unread";
import { useSavedMessages } from "./use-saved-messages";

// The unread rule is shared with the server, which counts the app badge with it.
export { badgeCount, decisionStates, isUnread, latestMessageAt, type ReadThrough } from "../shared/unread";

const time = (value: string | undefined) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
};

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

/**
 * The newest message time of a chat on screen: its roster preview and its saved messages. It is worked out when a
 * saved message arrives or the roster changes, not on every keystroke in the composer or delta of a streaming reply.
 */
export function useLatestMessageAt(bot: Bot | undefined, messages: Message[] | undefined) {
  const saved = useSavedMessages(messages);
  return useMemo(() => bot ? latestMessageAt(bot, saved) : undefined, [bot, saved]);
}
