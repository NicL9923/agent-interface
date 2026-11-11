import { useEffect, useMemo, useRef } from "react";
import type { Message } from "../shared/types";

const isSaved = (message: Message) => !message.id.endsWith("-inflight");
const sameRows = (first: readonly Message[], second: readonly Message[]) =>
  first.length === second.length && first.every((message, index) => message === second[index]);

/**
 * The messages Hermes has saved, without the live row of a reply still streaming. A streamed delta replaces the
 * list and that one row; every saved row keeps its object, so the list that comes back keeps its own identity
 * until a saved row is added, removed or changed. What is derived from it, such as the newest message time or the
 * routine runs a delivery already shows, is then worked out once per saved message and not once per delta.
 */
export function useSavedMessages(messages: Message[] | undefined): Message[] | undefined {
  const previous = useRef<Message[] | undefined>(undefined);
  const saved = useMemo(() => {
    const next = messages?.filter(isSaved);
    return previous.current && next && sameRows(previous.current, next) ? previous.current : next;
  }, [messages]);
  useEffect(() => { previous.current = saved; }, [saved]);
  return saved;
}
