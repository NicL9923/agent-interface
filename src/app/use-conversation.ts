import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, cachedResponse, changeStream, pollWhileVisible, request } from "../client-api";
import { routeUrl, type ApiQuery } from "../shared/api";
import { isActivityMessage } from "../shared/message-origin";
import { HISTORY_PAGE_TURNS } from "../shared/history";
import type { Inflight, Message } from "../shared/types";
import { replySnippet, watchReplies } from "./reply-announcement";
import type { ReplyWatch } from "./reply-announcement";
import type { SavedConversation } from "./storage";
/** Within this distance of the end, the reader is following the latest message. */
const LATEST_DISTANCE = 100;
type PageQuery = ApiQuery<"GET /bots/:id/conversation">;
const firstQuery: PageQuery = { turns: HISTORY_PAGE_TURNS };
// The cache key of the page an opened conversation reads first.
const firstPage = (botId: string) => routeUrl("GET /bots/:id/conversation", { id: botId }, firstQuery);
const countsAsNew = (message: Message) =>
  !isActivityMessage(message) && (message.role === "user" || message.role === "assistant" && (!!message.text.trim() || !!message.files?.length));
/** onMissing hears that this person may no longer see the assistant, so polling stops. */
export function useConversation(botId: string, userId?: string, onMissing?: (botId: string) => void) {
  const missing = useRef(onMissing);
  missing.current = onMissing;
  const [conversation, setConversation] = useState<SavedConversation | null>(
    null,
  );
  const [disconnected, setDisconnected] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  useEffect(() => setReviewed(false), [conversation?.activity.state, conversation?.activity.runId]);
  const [atLatest, setAtLatest] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [earlier, setEarlier] = useState({ loading: false, failed: false });
  // The latest settled reply, worded for a screen reader's live region.
  const [reply, setReply] = useState<{ botId: string; id: string; text: string } | null>(null);
  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (positionTimer.current) clearTimeout(positionTimer.current);
  }, [userId]);
  const scroll = useRef<HTMLDivElement>(null);
  // Following keeps the latest message in view as replies, images and cards grow.
  const following = useRef(true);
  // A smooth jump reports positions short of the end until it lands.
  const jumping = useRef(0);
  // Scroll events count only after the opened conversation is first placed.
  const restored = useRef(false);
  // The message at the top of the view, held in place while history above it changes.
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const reveal = useRef<string | null>(null);
  const seen = useRef(new Set<string>());
  const current = useRef(conversation);
  current.current = conversation;
  const requestEarlier = useRef<() => void>(() => {});
  useEffect(() => {
    if (!botId || !userId) return;
    let live = true;
    restored.current = false;
    following.current = true;
    anchor.current = null;
    reveal.current = null;
    seen.current = new Set();
    setAtLatest(true);
    setUnseen(0);
    setEarlier({ loading: false, failed: false });
    setReply(null);
    // A conversation opened before shows at once while it is checked again.
    const cached = cachedResponse<SavedConversation>(firstPage(botId));
    setConversation(cached?.botId === botId ? cached : null);
    setDisconnected(false);
    setReviewed(false);
    // The window starts at its oldest loaded message so new turns never push it along.
    // A reader already scrolling the cached page keeps it; otherwise the latest page refreshes it.
    let start: string | undefined;
    const cachedStart = cached?.botId === botId ? cached.messages[0]?.id : undefined;
    let latestInflight: Inflight | undefined;
    const patch = (value: SavedConversation, live?: Inflight): SavedConversation => {
      if (!live || live.botId !== value.botId
        || !["thinking", "working", "waiting", "blocked"].includes(value.activity.state)
        || value.activity.runId !== live.activity.runId) return value;
      const messages = value.messages.filter(message => !message.id.endsWith("-inflight"));
      if (live.message.text || live.message.reasoning) messages.push(live.message);
      return {...value, messages, activity: live.activity, toolCalls: live.toolCalls};
    };
    let loading = false, again = false, more = false, gone = false;
    let firstConversation = true;
    let watch: ReplyWatch = {};
    let announced = 0;
    let secureRequestIds = new Set<string>();
    const load = async () => {
      if (gone) return;
      if (loading) { again = true; return; }
      loading = true;
      const earlierPage = more;
      more = false;
      if (!start && !following.current) start = cachedStart;
      const fromStart = !!start;
      const query: PageQuery = start
        ? { start, turns: earlierPage ? HISTORY_PAGE_TURNS : undefined }
        : earlierPage ? { turns: HISTORY_PAGE_TURNS * 2 } : firstQuery;
      try {
        const result = await request("GET /bots/:id/conversation", { params: { id: botId }, query });
        if (!live) return;
        // The latest page can slide past the cached message a reader scrolled to meanwhile.
        if (!fromStart && !following.current && cachedStart
          && !result.messages.some(message => message.id === cachedStart)) {
          start = cachedStart;
          again = true;
          return;
        }
        start = result.messages[0]?.id;
        const secureRequests = (result.attention ?? []).filter(request => request.kind === "secure");
        const newSecureRequest = secureRequests.find(request => !secureRequestIds.has(request.id));
        secureRequestIds = new Set(secureRequests.map(request => request.id));
        if (newSecureRequest && (firstConversation || following.current)) reveal.current = newSecureRequest.id;
        const heard = watchReplies(watch, result, firstConversation);
        watch = heard.watch;
        // An unsaved reply keeps one ID across turns, so each announcement is numbered instead.
        if (heard.reply) setReply({ botId, id: String(++announced), text: replySnippet(heard.reply.text) });
        firstConversation = false;
        if (result !== current.current) holdPlace();
        setConversation(patch(result, latestInflight));
        setDisconnected(false);
        if (earlierPage) setEarlier({ loading: false, failed: false });
      } catch (error) {
        if (live && error instanceof ApiError && error.code === "assistant_not_found") {
          gone = true;
          missing.current?.(botId);
        } else if (live) {
          setDisconnected(true);
          if (earlierPage) setEarlier({ loading: false, failed: true });
        }
      } finally {
        loading = false;
        if (again && live) {
          again = false;
          void load();
        }
      }
    };
    requestEarlier.current = () => {
      if (!live || more) return;
      more = true;
      setEarlier({ loading: true, failed: false });
      void load();
    };
    void load();
    const stream = changeStream(`/bots/${encodeURIComponent(botId)}/events?inflight=1`, () => {
      latestInflight = undefined;
      void load();
    }, value => {
      if (!live || value.botId !== botId) return;
      latestInflight = value;
      holdPlace();
      setConversation(previous => previous?.botId === botId ? patch(previous, value) : previous);
    });
    if (document.visibilityState !== "hidden") stream.open();
    const wake = () => {
      if (navigator.onLine === false || document.visibilityState === "hidden") return;
      stream.open();
      void load();
    };
    // Change notices drive updates. This slow poll covers a stream that fails unnoticed.
    const stopPolling = pollWhileVisible(wake, 30_000);
    // A hidden page holds no stream; showing it again reloads and reopens one.
    const hide = () => { if (document.visibilityState === "hidden") stream.close(); };
    window.addEventListener("online", wake);
    window.addEventListener("agent-interface:reconnect", wake);
    document.addEventListener("visibilitychange", hide);
    return () => {
      live = false;
      requestEarlier.current = () => {};
      stopPolling();
      stream.close();
      window.removeEventListener("online", wake);
      window.removeEventListener("agent-interface:reconnect", wake);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [botId, userId]);
  // Only messages with something to read count as seen, so a reply that was still
  // reasoning when the reader looked away is new once its text arrives.
  const markSeen = (messages: Message[]) => {
    seen.current = new Set(messages.filter(countsAsNew).map(message => message.id));
  };
  const returnToPlace = () => {
    const element = scroll.current, held = anchor.current;
    const target = held && element ? [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find(item => item.dataset.messageId === held.id) : undefined;
    if (!element || !held || !target) return;
    const shift = target.getBoundingClientRect().top - element.getBoundingClientRect().top - held.offset;
    if (shift) element.scrollTop += shift;
  };
  const holdPlace = () => {
    const element = scroll.current;
    anchor.current = null;
    if (!element || following.current) return;
    const top = element.getBoundingClientRect().top;
    const target = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find(item => item.getBoundingClientRect().bottom > top);
    if (target) anchor.current = { id: target.dataset.messageId!, offset: target.getBoundingClientRect().top - top };
  };
  // Placement runs before paint, so an opened, grown or extended transcript never flickers.
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element || !conversation || conversation.botId !== botId) return;
    const request = reveal.current;
    reveal.current = null;
    const card = request ? [...element.querySelectorAll<HTMLElement>(".secure-request")]
      .find(item => item.dataset.requestId === request) : undefined;
    if (card) {
      element.scrollTop += card.getBoundingClientRect().top - element.getBoundingClientRect().top;
      following.current = false;
      holdPlace();
    } else if (following.current) element.scrollTop = element.scrollHeight;
    else returnToPlace();
    restored.current = true;
    setAtLatest(following.current);
    if (following.current) {
      markSeen(conversation.messages);
      setUnseen(0);
    } else {
      const last = conversation.messages.findLastIndex(message => seen.current.has(message.id));
      setUnseen(last < 0 ? 0 : conversation.messages.slice(last + 1).filter(countsAsNew).length);
    }
  }, [conversation, botId]);
  // The transcript body, observed so late images and cards keep a follower at the end.
  // A freshly shown transcript, such as on return from Today, opens at the latest message.
  const content = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    following.current = true;
    setAtLatest(true);
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    if (typeof ResizeObserver === "undefined") return;
    // Browser scroll anchoring is off, so late images above the reader are offset here too.
    const observer = new ResizeObserver(() => {
      if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
      else returnToPlace();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const jumpToLatest = useCallback(() => {
    const element = scroll.current;
    following.current = true;
    setAtLatest(true);
    setUnseen(0);
    if (current.current) markSeen(current.current.messages);
    if (!element) return;
    // A short trip glides; a long one jumps rather than scrolling through pages of history.
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance < element.clientHeight * 3 && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      jumping.current = Date.now() + 1000;
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    } else element.scrollTop = element.scrollHeight;
  }, []);
  const loadEarlier = useCallback(() => requestEarlier.current(), []);
  const persistPosition = () => {
    // Switching assistants empties the shared transcript, and the browser reports that
    // clamp to the top as a scroll. Only the loaded conversation's own scrolling counts.
    if (!userId || !botId || !scroll.current || !restored.current || conversation?.botId !== botId) return;
    const top = scroll.current.scrollTop;
    const latest = scroll.current.scrollHeight - top - scroll.current.clientHeight < LATEST_DISTANCE;
    if (latest) jumping.current = 0;
    if (latest || jumping.current < Date.now()) following.current = latest;
    setAtLatest(following.current);
    if (latest) {
      markSeen(conversation.messages);
      setUnseen(0);
    } else holdPlace();
    if (positionTimer.current) clearTimeout(positionTimer.current);
    const positionBot = botId;
    const viewportTop = scroll.current.getBoundingClientRect().top;
    const visibleMessage = [...scroll.current.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find(element => element.getBoundingClientRect().bottom > viewportTop + 8);
    const messageId = latest ? conversation.messages.at(-1)?.id : visibleMessage?.dataset.messageId;
    positionTimer.current = setTimeout(
      () =>
        void request("PUT /bots/:id/read-position", { params: { id: positionBot }, body: { scrollTop: top, messageId } }).catch(() => {}),
      300,
    );
  };
  const history = {
    earlier: (conversation?.earlier ?? 0) > 0,
    complete: conversation?.earlier === 0,
    ...earlier,
    atLatest,
    unseen,
    loadEarlier,
    jumpToLatest,
  };
  return { conversation, setConversation, disconnected, reply, reviewed, setReviewed, scroll, content, history, persistPosition };
}
