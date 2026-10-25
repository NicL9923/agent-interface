import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, cachedResponse, changeStream, pollWhileVisible, request } from "../client-api";
import { routeUrl, type ApiQuery } from "../shared/api";
import { isActivityMessage } from "../shared/message-origin";
import { HISTORY_PAGE_TURNS } from "../shared/history";
import type { Inflight, Message } from "../shared/types";
import { replySnippet, watchReplies } from "./reply-announcement";
import type { ReplyWatch } from "./reply-announcement";
import type { SavedConversation } from "./storage";
import { ANCHOR_GAP, afterIntent, atTrueEnd, distanceToEnd, endReserve, scrollIntent } from "./scroll-follow";
import type { Intent, ScrollMode } from "./scroll-follow";
import { clearMessageParam, initialMessage } from "./view";
/** Within this distance of the end, the reader counts as at the latest message and the jump control hides. */
const LATEST_DISTANCE = 100;
/** How long a message opened from find or a link stays highlighted. */
const FOUND_MS = 2400;
type PageQuery = ApiQuery<"GET /bots/:id/conversation">;
const firstQuery: PageQuery = { turns: HISTORY_PAGE_TURNS };
// The cache key of the page an opened conversation reads first.
const firstPage = (botId: string) => routeUrl("GET /bots/:id/conversation", { id: botId }, firstQuery);
/**
 * The first transcript message whose bottom is below `y`. Messages are laid out in document
 * order, so a binary search measures a handful of them instead of every one on each scroll.
 */
export function firstMessageBelow(container: HTMLElement, y: number) {
  const items = container.querySelectorAll<HTMLElement>("[data-message-id]");
  let low = 0, high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (items[middle].getBoundingClientRect().bottom > y) high = middle;
    else low = middle + 1;
  }
  return items[low];
}
const messageElement = (container: HTMLElement, id: string) =>
  [...container.querySelectorAll<HTMLElement>("[data-message-id]")].find(item => item.dataset.messageId === id);
const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
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
  // Empty space after the transcript, so a message sent last can sit near the top of the view.
  const endSpace = useRef<HTMLDivElement>(null);
  // Following keeps the latest message in view as replies, images and cards grow. See scroll-follow.ts.
  const mode = useRef<ScrollMode>("follow");
  /**
   * The message a send anchored, null when none is. It is followed from its echo, named by the
   * request ID, to Hermes's copy: by that ID or the ID its receipt names, which `id` then holds, so
   * later rows, such as another member's guidance, never take its place. Until a receipt names one,
   * this person's first message after those `known` when they sent stands in as `guess`, which a
   * named copy replaces. Once a receipt names the copy, nothing else stands in for it.
   */
  const sendAnchor = useRef<{ known: Set<string>; requestId?: string; messageId?: string; id?: string; guess?: string } | null>(null);
  // Where a scroll event last left the transcript, so reading upward can be told from growth.
  const lastTop = useRef(0);
  // A smooth jump reports positions short of the end until it lands.
  const jumping = useRef(0);
  // Scroll events count only after the opened conversation is first placed.
  const restored = useRef(false);
  // The message at the top of the view, held in place while history above it changes.
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const reveal = useRef<string | null>(null);
  // A message to open, from a link or find, and the assistant it belongs to. `generation` names the
  // load that opens it; only once that load's page arrives is it `ready` to scroll to.
  const [linked] = useState(initialMessage);
  const target = useRef<{ botId: string; messageId: string; generation?: number; ready?: boolean } | null>(linked);
  const found = useRef<{ element: HTMLElement; timer: ReturnType<typeof setTimeout> } | null>(null);
  const seen = useRef(new Set<string>());
  const current = useRef(conversation);
  current.current = conversation;
  const requestEarlier = useRef<() => void>(() => {});
  const requestStart = useRef<(messageId: string) => void>(() => {});
  const botIdRef = useRef(botId);
  botIdRef.current = botId;
  useEffect(() => {
    if (!botId || !userId) return;
    let live = true;
    // Each request to open a message starts a new navigation. A load begun before it cannot place
    // the window or consume the target.
    let navigation = 0;
    const opening = target.current?.botId === botId ? target.current.messageId : undefined;
    target.current = opening ? { botId, messageId: opening, generation: ++navigation } : null;
    clearMessageParam();
    restored.current = false;
    mode.current = opening ? "free" : "follow";
    sendAnchor.current = null;
    if (endSpace.current) endSpace.current.style.height = "";
    anchor.current = null;
    reveal.current = null;
    seen.current = new Set();
    setAtLatest(!opening);
    setUnseen(0);
    setEarlier({ loading: false, failed: false });
    setReply(null);
    // A conversation opened before shows at once while it is checked again, unless it opens at a message.
    const cached = opening ? undefined : cachedResponse<SavedConversation>(firstPage(botId));
    setConversation(cached?.botId === botId ? cached : null);
    setDisconnected(false);
    setReviewed(false);
    // The window starts at its oldest loaded message so new turns never push it along.
    // A reader already scrolling the cached page keeps it; otherwise the latest page refreshes it.
    let start: string | undefined = opening;
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
      const generation = navigation;
      const earlierPage = more;
      more = false;
      if (!start && mode.current !== "follow") start = cachedStart;
      const fromStart = !!start;
      const query: PageQuery = start
        ? { start, turns: earlierPage ? HISTORY_PAGE_TURNS : undefined }
        : earlierPage ? { turns: HISTORY_PAGE_TURNS * 2 } : firstQuery;
      try {
        const result = await request("GET /bots/:id/conversation", { params: { id: botId }, query });
        if (!live) return;
        // A message was asked for meanwhile: this page is from before, and the load for it follows.
        if (generation !== navigation) {
          again = true;
          if (earlierPage) more = true;
          return;
        }
        // The latest page can slide past the cached message a reader scrolled to meanwhile.
        if (!fromStart && mode.current !== "follow" && cachedStart
          && !result.messages.some(message => message.id === cachedStart)) {
          start = cachedStart;
          again = true;
          return;
        }
        start = result.messages[0]?.id;
        const secureRequests = (result.attention ?? []).filter(request => request.kind === "secure");
        const newSecureRequest = secureRequests.find(request => !secureRequestIds.has(request.id));
        secureRequestIds = new Set(secureRequests.map(request => request.id));
        if (newSecureRequest && (firstConversation || mode.current === "follow")) reveal.current = newSecureRequest.id;
        const heard = watchReplies(watch, result, firstConversation);
        watch = heard.watch;
        // An unsaved reply keeps one ID across turns, so each announcement is numbered instead.
        if (heard.reply) setReply({ botId, id: String(++announced), text: replySnippet(heard.reply.text) });
        firstConversation = false;
        if (result !== current.current) holdPlace();
        if (target.current?.botId === botId && target.current.generation === generation) target.current.ready = true;
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
    // Opens the window at a message that is not loaded, such as an older find match.
    requestStart.current = messageId => {
      if (!live) return;
      target.current = { botId, messageId, generation: ++navigation };
      mode.current = "free";
      start = messageId;
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
      requestStart.current = () => {};
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
    const target = held && element ? messageElement(element, held.id) : undefined;
    if (!element || !held || !target) return;
    const shift = target.getBoundingClientRect().top - element.getBoundingClientRect().top - held.offset;
    if (shift) element.scrollTop += shift;
  };
  const holdPlace = () => {
    const element = scroll.current;
    anchor.current = null;
    if (!element || mode.current !== "free") return;
    const top = element.getBoundingClientRect().top;
    const target = firstMessageBelow(element, top);
    if (target) anchor.current = { id: target.dataset.messageId!, offset: target.getBoundingClientRect().top - top };
  };
  // The person's message a send anchored. See sendAnchor for how it is followed.
  const sentMessage = () => {
    const element = scroll.current, sent = sendAnchor.current;
    if (!element || !sent) return undefined;
    if (sent.id) return messageElement(element, sent.id);
    const lock = (id: string) => { sent.id = id; return messageElement(element, id); };
    const named = [sent.requestId, sent.messageId].filter((id): id is string => !!id);
    const own = current.current?.botId === botId ? current.current.messages : [];
    const canonical = own.find(message => named.includes(message.id));
    if (canonical) return lock(canonical.id);
    // The echo stands in, named by the request ID, until Hermes's copy replaces it.
    const echo = sent.requestId ? messageElement(element, sent.requestId) : undefined;
    if (echo) return echo;
    // A named copy that has not arrived yet is waited for, even when another of this person's
    // messages, such as one from another device, arrives first.
    if (sent.messageId) return undefined;
    if (sent.guess && own.some(message => message.id === sent.guess)) return messageElement(element, sent.guess);
    // Only after the newest message known at the send, so an earlier page loaded since never counts.
    const mine = own.slice(own.findLastIndex(message => sent.known.has(message.id)) + 1).find(message => message.role === "user" && !isActivityMessage(message)
      && !message.id.endsWith("-inflight") && (message.sender ? message.sender.id === userId : true));
    sent.guess = mine?.id;
    return mine ? messageElement(element, mine.id) : undefined;
  };
  // Keeps enough space at the end for the sent message to reach the top of the view. It never moves
  // what is above it, and it shrinks as the reply grows into it.
  const reserveEnd = () => {
    const element = scroll.current, space = endSpace.current, sent = sentMessage();
    if (!element || !space) return;
    const reserve = space.offsetHeight;
    const next = sent ? endReserve({
      offset: sent.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop,
      scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, reserve,
    }) : 0;
    if (next !== reserve) space.style.height = next ? `${next}px` : "";
  };
  // Brings the opened message into view, a little below the top, and marks it briefly.
  const showFound = (item: HTMLElement, mark = true) => {
    const element = scroll.current!;
    element.scrollTop += item.getBoundingClientRect().top - element.getBoundingClientRect().top - Math.min(120, element.clientHeight / 4);
    mode.current = "free";
    holdPlace();
    if (!mark) return;
    if (found.current) { clearTimeout(found.current.timer); delete found.current.element.dataset.found; }
    item.dataset.found = "";
    found.current = { element: item, timer: setTimeout(() => { delete item.dataset.found; found.current = null; }, FOUND_MS) };
  };
  useEffect(() => () => { if (found.current) clearTimeout(found.current.timer); }, []);
  // Every layout pass places the transcript by its mode: pinned to the end, the sent message near the
  // top, or the reader's message where it was.
  const place = () => {
    const element = scroll.current;
    if (!element) return;
    reserveEnd();
    if (mode.current === "follow") element.scrollTop = element.scrollHeight;
    else if (mode.current === "anchored") {
      const sent = sentMessage();
      if (sent) element.scrollTop += sent.getBoundingClientRect().top - element.getBoundingClientRect().top - ANCHOR_GAP;
      else element.scrollTop = element.scrollHeight;
    } else returnToPlace();
  };
  // Placement runs before paint, so an opened, grown or extended transcript never flickers.
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element || !conversation || conversation.botId !== botId) return;
    const request = reveal.current;
    reveal.current = null;
    const card = request ? [...element.querySelectorAll<HTMLElement>(".secure-request")]
      .find(item => item.dataset.requestId === request) : undefined;
    // The message asked for opens once its own page arrived, not on a render of an older one.
    const opening = target.current?.botId === botId && target.current.ready ? target.current.messageId : undefined;
    const opened = opening ? messageElement(element, opening) : undefined;
    if (opening) target.current = null;
    if (opened) showFound(opened);
    else if (card) {
      element.scrollTop += card.getBoundingClientRect().top - element.getBoundingClientRect().top;
      mode.current = "free";
      holdPlace();
    } else {
      // A message that could not be found leaves the reader at the latest one.
      if (opening) mode.current = "follow";
      place();
    }
    restored.current = true;
    lastTop.current = element.scrollTop;
    setAtLatest(mode.current === "follow" || distanceToEnd(element) < LATEST_DISTANCE);
    if (mode.current !== "free") {
      markSeen(conversation.messages);
      setUnseen(0);
    } else {
      const last = conversation.messages.findLastIndex(message => seen.current.has(message.id));
      setUnseen(last < 0 ? 0 : conversation.messages.slice(last + 1).filter(countsAsNew).length);
    }
  }, [conversation, botId]);
  // A reader's own input ends following or an anchor at once. Scroll events alone cannot tell the
  // reader from growth, so wheel, touch, keys and the scroll bar are heard directly.
  const intend = (intent: Intent) => {
    const next = afterIntent(mode.current, intent);
    if (next === mode.current) return;
    mode.current = next;
    jumping.current = 0;
    holdPlace();
  };
  const listen = (element: HTMLElement) => {
    const input = (event: Event) => {
      if (event.type === "keydown" && editable(event.target)) return;
      const intent = scrollIntent(event as WheelEvent & KeyboardEvent);
      if (intent) intend(intent);
    };
    // A press on the scroll bar lands on the container itself, beyond its content box.
    const press = (event: PointerEvent) => {
      if (event.target === element && (event.offsetX > element.clientWidth || event.offsetY > element.clientHeight)) intend("drag");
    };
    const options = { passive: true };
    for (const type of ["wheel", "touchmove", "keydown"]) element.addEventListener(type, input, options);
    element.addEventListener("pointerdown", press, options);
    return () => {
      for (const type of ["wheel", "touchmove", "keydown"]) element.removeEventListener(type, input);
      element.removeEventListener("pointerdown", press);
    };
  };
  const placeLatest = useRef(place);
  placeLatest.current = place;
  const listenLatest = useRef(listen);
  listenLatest.current = listen;
  // The transcript body, observed so late images and cards keep a follower at the end.
  // A freshly shown transcript, such as on return from Today, opens at the latest message.
  const content = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const element = node.parentElement;
    if (!target.current) {
      mode.current = "follow";
      setAtLatest(true);
    }
    if (element && mode.current === "follow") element.scrollTop = element.scrollHeight;
    const stop = element ? listenLatest.current(element) : undefined;
    if (typeof ResizeObserver === "undefined") return stop;
    // Browser scroll anchoring is off, so late images above the reader are offset here too.
    const observer = new ResizeObserver(() => placeLatest.current());
    observer.observe(node);
    return () => { observer.disconnect(); stop?.(); };
  }, []);
  const jumpToLatest = useCallback(() => {
    const element = scroll.current;
    mode.current = "follow";
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
  /**
   * Called as the person sends, with the request's ID: their new message moves near the top of
   * the view and the reply grows below it, instead of the view chasing the end.
   */
  const anchorSend = useCallback((requestId?: string) => {
    jumping.current = 0;
    sendAnchor.current = { requestId, known: new Set(current.current?.messages.map(message => message.id)) };
    mode.current = "anchored";
    setAtLatest(true);
    setUnseen(0);
    if (current.current) markSeen(current.current.messages);
    placeLatest.current();
  }, []);
  /** The ID Hermes gave an anchored send, from its receipt, so the anchor follows its echo there. */
  const sentAs = useCallback((requestId: string, messageId: string) => {
    if (sendAnchor.current?.requestId === requestId && !sendAnchor.current.id) sendAnchor.current.messageId = messageId;
  }, []);
  /** Shows a message of this conversation, loading the history window from it when it is not loaded. */
  const openMessage = useCallback((messageId: string, mark = true) => {
    const element = scroll.current;
    const item = element ? messageElement(element, messageId) : undefined;
    if (item) {
      showFound(item, mark);
      setAtLatest(distanceToEnd(element!) < LATEST_DISTANCE);
    } else requestStart.current(messageId);
  }, []);
  /**
   * Opens an assistant's live conversation at a message, as a search result does. Call it with
   * the selection change; a different assistant opens there once it loads.
   */
  const openAt = useCallback((id: string, messageId: string) => {
    if (id === botIdRef.current) openMessage(messageId);
    else target.current = { botId: id, messageId };
  }, [openMessage]);
  const loadEarlier = useCallback(() => requestEarlier.current(), []);
  const measurePosition = () => {
    // Switching assistants empties the shared transcript, and the browser reports that
    // clamp to the top as a scroll. Only the loaded conversation's own scrolling counts.
    if (!userId || !botId || !scroll.current || !restored.current || conversation?.botId !== botId) return;
    const element = scroll.current;
    const top = element.scrollTop;
    const end = atTrueEnd(element);
    const latest = distanceToEnd(element) < LATEST_DISTANCE;
    if (end) jumping.current = 0;
    // Following comes back only at the true end. Moving up away from it while following,
    // as with a scroll bar the app could not hear, ends following too.
    if (mode.current !== "anchored") {
      if (end) mode.current = "follow";
      else if (mode.current === "follow" && top < lastTop.current - 1 && jumping.current < Date.now()) mode.current = "free";
    }
    lastTop.current = top;
    setAtLatest(mode.current === "follow" || latest);
    if (mode.current !== "free" || latest) {
      markSeen(conversation.messages);
      setUnseen(0);
    }
    holdPlace();
    if (positionTimer.current) clearTimeout(positionTimer.current);
    const positionBot = botId;
    const visibleMessage = latest ? undefined : firstMessageBelow(element, element.getBoundingClientRect().top + 8);
    const messageId = latest ? conversation.messages.at(-1)?.id : visibleMessage?.dataset.messageId;
    positionTimer.current = setTimeout(
      () =>
        void request("PUT /bots/:id/read-position", { params: { id: positionBot }, body: { scrollTop: top, messageId } }).catch(() => {}),
      300,
    );
  };
  // Scrolling reports many events per frame. Placement is measured once per frame, with the
  // latest render's state, and at once before switching assistants.
  const measure = useRef(measurePosition);
  measure.current = measurePosition;
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const persistPosition = useCallback((immediately = false) => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    if (immediately) measure.current();
    else frame.current = requestAnimationFrame(() => { frame.current = 0; measure.current(); });
  }, []);
  const history = {
    earlier: (conversation?.earlier ?? 0) > 0,
    complete: conversation?.earlier === 0,
    ...earlier,
    atLatest,
    unseen,
    loadEarlier,
    jumpToLatest,
    anchorSend,
    sentAs,
    openMessage,
    openAt,
  };
  return { conversation, setConversation, disconnected, reply, reviewed, setReviewed, scroll, endSpace, content, history, persistPosition };
}
