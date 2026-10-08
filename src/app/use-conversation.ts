import { useEffect, useRef, useState } from "react";
import { api, write } from "../client-api";
import { localRead, localSave, scrollKey } from "./storage";
/** Saved in place of a pixel offset when the reader was at the latest message. */
const AT_LATEST = -1;
import type { SavedConversation } from "./storage";
export function useConversation(botId: string, userId?: string) {
  const [conversation, setConversation] = useState<SavedConversation | null>(
    null,
  );
  const [disconnected, setDisconnected] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  useEffect(() => setReviewed(false), [conversation?.activity.state, conversation?.activity.runId]);
  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (positionTimer.current) clearTimeout(positionTimer.current);
  }, [userId]);
  const scroll = useRef<HTMLDivElement>(null);
  const bottom = useRef(true);
  // Scroll events count only after the opened conversation's position is restored.
  const restored = useRef(false);
  useEffect(() => {
    if (!botId || !userId) return;
    let live = true;
    restored.current = false;
    setConversation(null);
    setDisconnected(false);
    setReviewed(false);
    let loadingConversation = false;
    let firstConversation = true;
    let secureRequestIds = new Set<string>();
    const load = async () => {
      if (loadingConversation) return;
      loadingConversation = true;
      try {
        const result = await api<SavedConversation>(
          `/bots/${encodeURIComponent(botId)}/conversation`,
        );
        if (!live) return;
        setConversation(result);
        setDisconnected(false);
        const secureRequests = (result.attention ?? []).filter(request => request.kind === "secure");
        const newSecureRequest = secureRequests.find(request => !secureRequestIds.has(request.id));
        secureRequestIds = new Set(secureRequests.map(request => request.id));
        if (newSecureRequest && (firstConversation || bottom.current)) {
          firstConversation = false;
          requestAnimationFrame(() => {
            if (!live || !scroll.current) return;
            const card = [...scroll.current.querySelectorAll<HTMLElement>('.secure-request')]
              .find(element => element.dataset.requestId === newSecureRequest.id);
            if (card) scroll.current.scrollTop += card.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top;
            bottom.current = false;
            restored.current = true;
          });
        } else if (firstConversation) {
          firstConversation = false;
          requestAnimationFrame(() => {
            if (!live || !scroll.current) return;
            const saved = localRead<number>(scrollKey(userId, botId));
            const messages = [...scroll.current.querySelectorAll<HTMLElement>('[data-message-id]')];
            const anchorIndex = result.messages.findIndex(message => message.id === result.readPosition?.messageId);
            const anchor = messages.find(element => element.dataset.messageId === result.readPosition?.messageId)
              ?? (anchorIndex >= 0 ? messages.find(element => result.messages.findIndex(message => message.id === element.dataset.messageId) >= anchorIndex) : undefined);
            // Someone who was reading the latest message returns to the latest, including anything new.
            // A saved position without a message is only a pixel offset from another screen, so it is ignored.
            const latest = saved === AT_LATEST || saved == null && !result.readPosition?.messageId;
            scroll.current.scrollTop = latest ? scroll.current.scrollHeight : saved ?? (anchor
              ? scroll.current.scrollTop + anchor.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top
              : result.readPosition?.scrollTop ?? scroll.current.scrollHeight);
            bottom.current = scroll.current.scrollHeight - scroll.current.scrollTop
              - scroll.current.clientHeight < 100;
            restored.current = true;
          });
        } else if (bottom.current) {
          requestAnimationFrame(() => {
            if (live && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
          });
        }
      } catch {
        if (live) {
          setDisconnected(true);
        }
      } finally {
        loadingConversation = false;
      }
    };
    void load();
    const wake = () => {
      if (navigator.onLine !== false && document.visibilityState !== "hidden") void load();
    };
    const timer = setInterval(wake, 1500);
    window.addEventListener("online", wake);
    window.addEventListener("agent-interface:reconnect", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("online", wake);
      window.removeEventListener("agent-interface:reconnect", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [botId, userId]);
  const persistPosition = () => {
    // Switching assistants empties the shared transcript, and the browser reports that
    // clamp to the top as a scroll. Only the loaded conversation's own scrolling counts.
    if (!userId || !botId || !scroll.current || !restored.current || conversation?.botId !== botId) return;
    const top = scroll.current.scrollTop;
    bottom.current =
      scroll.current.scrollHeight - top - scroll.current.clientHeight < 100;
    localSave(scrollKey(userId, botId), bottom.current ? AT_LATEST : top);
    if (positionTimer.current) clearTimeout(positionTimer.current);
    const positionBot = botId;
    const viewportTop = scroll.current.getBoundingClientRect().top;
    const visibleMessage = [...scroll.current.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find(element => element.getBoundingClientRect().bottom > viewportTop + 8);
    const messageId = bottom.current ? conversation?.messages.at(-1)?.id : visibleMessage?.dataset.messageId;
    positionTimer.current = setTimeout(
      () =>
        void write(
          `/bots/${encodeURIComponent(positionBot)}/read-position`,
          { scrollTop: top, messageId },
          "PUT",
        ).catch(() => {}),
      300,
    );
  };
  return { conversation, setConversation, disconnected, reviewed, setReviewed, scroll, persistPosition };
}
