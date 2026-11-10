import { matchRanges } from "./find-ranges";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiError, cachedResponse, changeStream, pollWhileVisible, request } from "../client-api";
import { isActivityMessage } from "../shared/message-origin";
import { HISTORY_PAGE_TURNS } from "../shared/history";
import { applyInflightDelta, compareVersions, versionBoot, withTurn } from "../shared/inflight";
import type { Inflight, Message, TurnEvent } from "../shared/types";
import type { ErrorCode } from "../shared/errors";
import { replySnippet, watchReplies } from "./reply-announcement";
import type { ReplyWatch } from "./reply-announcement";
import type { SavedConversation } from "./storage";
import { DRAFT_EVENT } from "./use-draft";
import { firstPage, firstQuery, prefetchedFirstPage, type PageQuery } from "./conversation-page";
import { ANCHOR_GAP, afterIntent, atTrueEnd, distanceToEnd, endReserve, scrollIntent } from "./scroll-follow";
import type { Intent, ScrollMode } from "./scroll-follow";
import { clearMessageParam, initialMessage } from "./view";
/** Within this distance of the end, the reader counts as at the latest message and the jump control hides. */
const LATEST_DISTANCE = 100;
/** How long a message opened from find or a link stays highlighted. */
const FOUND_MS = 2400;
/**
 * The first transcript message whose bottom is below `y`. Messages are laid out in document
 * order, so a binary search measures a handful of them instead of every one on each scroll.
 */
export function firstMessageBelow(container: HTMLElement, y: number, selector = "[data-message-id]") {
  const items = container.querySelectorAll<HTMLElement>(selector);
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
// Rows that hold the reader's place without being messages, such as routine run cards, so one
// opened at the top of the view stays put. Read positions still name only messages.
const placeRows = "[data-message-id], [data-place-id]";
const placeId = (item: HTMLElement) => item.dataset.messageId ?? `place:${item.dataset.placeId}`;
const placeElement = (container: HTMLElement, id: string) =>
  [...container.querySelectorAll<HTMLElement>(placeRows)].find(item => placeId(item) === id);
const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
/**
 * After a failed read that may be one unlucky request, how long the chat waits for a read to succeed
 * before it shows it is disconnected. A second failure in a row shows it sooner. The failure asks for no
 * read of its own: the next read comes from a change notice, a wake or the poll, as on any other read.
 */
export const DISCONNECT_GRACE_MS = 3_000;
/**
 * Why an action that needs the connection is refused. During the grace period the chat still looks
 * connected, so the refused control says it here; once the chat shows it is down, the connection
 * notice says more and the control only names what it waits for.
 */
export const CHECKING_CONNECTION = "Checking the connection. Try again in a moment.";
export const WAITING_FOR_CONNECTION = "Waiting for the connection. Your draft is kept.";
/** The composer's status line after a send it refused during the grace period. */
export const NOT_SENT_CHECKING = `Not sent. ${CHECKING_CONNECTION}`;
// What the server answers when Hermes itself is down: its connection diagnosis, a refused credential or maintenance.
const hermesDown = new Set<ErrorCode>(["not_configured", "invalid_config", "connecting", "unreachable", "unauthorized", "addon_missing",
  "incompatible", "reconnecting", "closed", "hermes_unauthorized", "hermes_maintenance"]);
/**
 * A failed read that shows the connection is down: the browser is offline, or the server answered that
 * Hermes is unavailable. Any other failure, such as a request that never reached the app, a timeout or an
 * unreadable answer, may be a blip.
 */
export const provesDisconnected = (error: unknown) => navigator.onLine === false
  || error instanceof ApiError && error.code !== undefined && hermesDown.has(error.code);
// A progress line arrives mid-task and is not something to catch up on, so it never counts.
const countsAsNew = (message: Message) =>
  !isActivityMessage(message) && message.interim !== true && (message.role === "user" || message.role === "assistant" && (!!message.text.trim() || !!message.files?.length));
/** onMissing hears that this person may no longer see the assistant, so polling stops. */
export function useConversation(botId: string, userId?: string, onMissing?: (botId: string) => void) {
  const missing = useRef(onMissing);
  missing.current = onMissing;
  const [conversation, setConversation] = useState<SavedConversation | null>(
    null,
  );
  // The chat whose latest read failed: a fact at once, so actions that need the connection are refused.
  // The chat that shows it is disconnected: see DISCONNECT_GRACE_MS. Each belongs to the chat it was
  // read for, so a failure gates nothing once its chat closes or leaves the roster, where no read
  // would ever clear it.
  const [readFailedFor, setReadFailedFor] = useState("");
  const [disconnectedFor, setDisconnectedFor] = useState("");
  const readFailed = !!botId && readFailedFor === botId;
  const disconnected = !!botId && disconnectedFor === botId;
  const [reviewed, setReviewed] = useState(false);
  useEffect(() => setReviewed(false), [conversation?.activity.state, conversation?.activity.runId]);
  const [atLatest, setAtLatest] = useState(true);
  const [atAttention, setAtAttention] = useState<string | null>(null);
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
  const sendAnchor = useRef<{ known: Set<string>; requestId?: string; messageId?: string; id?: string; guess?: string; filled?: Element; content?: number } | null>(null);
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
    setAtAttention(null);
    setUnseen(0);
    setEarlier({ loading: false, failed: false });
    setReply(null);
    // A conversation opened before shows at once while it is checked again, unless it opens at a message.
    const cached = opening ? undefined : cachedResponse<SavedConversation>(firstPage(botId));
    setConversation(cached?.botId === botId ? cached : null);
    setReadFailedFor("");
    setDisconnectedFor("");
    setReviewed(false);
    // The window starts at its oldest loaded message so new turns never push it along.
    // A reader already scrolling the cached page keeps it; otherwise the latest page refreshes it.
    let start: string | undefined = opening;
    const cachedStart = cached?.botId === botId ? cached.messages[0]?.id : undefined;
    // The live reply growth applies to, and, from a turn event, the read it leaves saved text to.
    let latestInflight: (Inflight & { version?: string }) | undefined;
    // The latest turn event, until a conversation read as new as it arrives. A read that is older, as one
    // that set out before the turn changed, gets the turn's saved messages put back on top of it.
    let heldTurn: TurnEvent | undefined;
    const patch = (value: SavedConversation, live?: Inflight & { version?: string }): SavedConversation => {
      if (!live || live.botId !== value.botId
        || !["thinking", "working", "waiting", "blocked"].includes(value.activity.state)
        || value.activity.runId !== live.activity.runId
        // A live reply leaves out exactly what its own read saved, so it shows only beside that read's messages.
        || live.version !== undefined && compareVersions(live.version, value.version) !== 0) return value;
      const messages = value.messages.filter(message => !message.id.endsWith("-inflight"));
      if (live.message.text || live.message.reasoning) messages.push(live.message);
      return {...value, messages, activity: live.activity, toolCalls: live.toolCalls};
    };
    // Which server process's state the view shows. Versions from two processes never compare, so the view shows one at a
    // time, and only a read the view asked for decides which: the newest read asked wins, whichever process answers it.
    // - A read answered after a newer one was asked, by another process than the current one, is dropped. The newer read
    //   is already asked, so dropping it asks nothing.
    // - A turn event from another process never decides it. It waits as `pending` and asks one read, which any later
    //   such turns share. The first read taken that set out after it settles it: the turn goes on top only when that read
    //   is from the turn's process and older than the turn, and is dropped otherwise. A turn already held from the read's
    //   process stays when it is as new. A read that fails leaves it waiting. A read older than the turn that cannot place
    //   it, as one joined to a prefetch that set out before, asks one more read.
    // Reads are bounded: a response never asks for a read because of the process that answered it, so two processes that
    // disagree cost one read per change. Every read answers an input, such as the opening, a change notice, a reconnect, a
    // wake or poll, the person's navigation, growth that does not continue the reply held, a turn that cannot be placed, or
    // a pending turn, and once more when the read that settles it cannot place it. Asks made while a read is on its way become one read. A response asks for another read itself only
    // when the latest page slid past the cached message a reader is on, once, since that read starts from the message.
    let boot: string | undefined, asks = 0;
    const inflightOf = (turn: TurnEvent): Inflight & { version?: string } =>
      ({ botId: turn.botId, message: turn.message, activity: turn.activity, toolCalls: turn.toolCalls, version: turn.version });
    let pending: { turn: TurnEvent; ask: number } | undefined;
    // Growth continues the turn whose live reply it extends, wherever that turn is kept, held or waiting, so a turn
    // settling or restored later brings back the grown reply, not the one its event first carried. The live reply held
    // is that turn's own message object (`inflightOf`), so identity names the turn growth extends.
    const grown = (turn: TurnEvent | undefined, before: Message, after: Inflight): TurnEvent | undefined =>
      turn?.message === before ? { ...turn, message: after.message, activity: after.activity, toolCalls: after.toolCalls } : turn;
    const compose = (value: SavedConversation): SavedConversation => {
      let shown = value;
      if (heldTurn?.botId === value.botId && (compareVersions(heldTurn.version, value.version) ?? 0) > 0) shown = withTurn(value, heldTurn) ?? value;
      else heldTurn = undefined;
      return patch(shown, latestInflight);
    };
    // Failed reads in a row, and the grace a first one that may be a blip starts.
    let failures = 0, grace: ReturnType<typeof setTimeout> | undefined;
    const stopWaiting = () => { clearTimeout(grace); grace = undefined; };
    const readOk = () => {
      failures = 0;
      stopWaiting();
      setReadFailedFor("");
      setDisconnectedFor("");
    };
    const readFailedWith = (error: unknown) => {
      failures++;
      setReadFailedFor(botId);
      if (failures > 1 || provesDisconnected(error)) {
        stopWaiting();
        setDisconnectedFor(botId);
        return;
      }
      grace = setTimeout(() => { grace = undefined; if (live) setDisconnectedFor(botId); }, DISCONNECT_GRACE_MS);
    };
    let loading = false, again = false, more = false, gone = false;
    let firstConversation = true;
    let watch: ReplyWatch = {};
    let announced = 0;
    let secureRequestIds = new Set<string>();
    const load = async () => {
      if (gone) return;
      asks++;
      if (loading) { again = true; return; }
      loading = true;
      const generation = navigation, asked = asks;
      const earlierPage = more;
      more = false;
      if (!start && mode.current !== "follow") start = cachedStart;
      const fromStart = !!start;
      const query: PageQuery = start
        ? { start, turns: earlierPage ? HISTORY_PAGE_TURNS : undefined }
        : earlierPage ? { turns: HISTORY_PAGE_TURNS * 2 } : firstQuery;
      try {
        // Every load asks, even for another window, so the first one uses up a link's startup read.
        // Only the latest page can take what it answers; if that read fails, read again.
        const prefetched = prefetchedFirstPage(botId);
        const joined = query === firstQuery ? prefetched : undefined;
        const result = await joined?.catch(() => undefined)
          ?? await request("GET /bots/:id/conversation", { params: { id: botId }, query });
        if (!live) return;
        const from = versionBoot(result.version);
        // Another process answered, and a newer read is already asked: that one decides.
        if (from && from !== boot && asked < asks) {
          if (earlierPage) more = true;
          return;
        }
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
        if (from) boot = from;
        if (pending && asked >= pending.ask) {
          const waiting = pending.turn;
          pending = undefined;
          // From another process than this read's, the waiting turn is dropped. From this read's, it is held unless a turn
          // already held from this process is as new; `compose` then puts the held turn on top only when it is newer.
          const order = compareVersions(heldTurn?.version, waiting.version);
          if (versionBoot(waiting.version) === from && (order === undefined || order < 0)) {
            heldTurn = waiting;
            // Newer than this read, which holds neither its first message nor `after`: one more read, asked after it, is as new.
            if ((compareVersions(waiting.version, result.version) ?? 0) > 0 && !withTurn(result, waiting)) again = true;
          }
          // The live reply is the last turn heard, which can be from the other process. Growth continues the held turn's.
          if (heldTurn && versionBoot(heldTurn.version) === from && versionBoot(latestInflight?.version) !== from) latestInflight = inflightOf(heldTurn);
        }
        setConversation(compose(result));
        readOk();
        if (earlierPage) setEarlier({ loading: false, failed: false });
      } catch (error) {
        if (live && error instanceof ApiError && error.code === "assistant_not_found") {
          gone = true;
          missing.current?.(botId);
        } else if (live) {
          readFailedWith(error);
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
    const showInflight = (value: Inflight) => {
      latestInflight = value;
      holdPlace();
      setConversation(previous => previous?.botId === botId ? patch(previous, value) : previous);
    };
    const showTurn = (turn: TurnEvent) => {
      const from = versionBoot(turn.version);
      // Growth on the stream continues this reply. It shows only beside a read of its own version (`patch`).
      latestInflight = inflightOf(turn);
      // From another process than the view's, or before any read: it waits for a read asked after it. See `boot`.
      if (from && from !== boot) {
        if (pending) { pending.turn = turn; return; }
        void load();
        pending = { turn, ask: asks };
        return;
      }
      const held = current.current?.botId === botId ? current.current : null;
      if (!held) { heldTurn = turn; return; }
      if (!withTurn(held, turn)) { heldTurn = undefined; void load(); return; }
      heldTurn = turn;
      holdPlace();
      setConversation(previous => {
        if (previous?.botId !== botId) return previous;
        const placed = withTurn(previous, turn);
        return placed ? patch(placed, latestInflight) : previous;
      });
    };
    // A turn stream: the server sends each whole live reply with its turn's saved messages, versioned, so a
    // change notice's read no longer gates the reply. A server that predates it sends change notices only.
    const stream = changeStream(`/bots/${encodeURIComponent(botId)}/events?inflight=3&drafts=1`, () => void load(), value => {
      if (!live || value.botId !== botId) return;
      showInflight(value);
    }, {
      // The person's own draft for this assistant has a new revision, from this or another device.
      draft: data => window.dispatchEvent(new CustomEvent(DRAFT_EVENT, { detail: { botId, revision: Number(data) } })),
      turn: data => {
        if (!live) return;
        let turn: TurnEvent;
        try { turn = JSON.parse(data) as TurnEvent; } catch { void load(); return; }
        if (turn.botId === botId) showTurn(turn);
      },
    }, delta => {
      if (!live || delta.botId !== botId) return true;
      // Growth that does not continue the held reply is dropped for a reload, never guessed at.
      const value = applyInflightDelta(latestInflight, delta);
      if (!value) return false;
      heldTurn = grown(heldTurn, latestInflight!.message, value);
      if (pending) pending.turn = grown(pending.turn, latestInflight!.message, value)!;
      showInflight(value);
      return true;
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
      stopWaiting();
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
    const target = held && element ? placeElement(element, held.id) : undefined;
    if (!element || !held || !target) return;
    const shift = target.getBoundingClientRect().top - element.getBoundingClientRect().top - held.offset;
    if (shift) element.scrollTop += shift;
  };
  const holdPlace = () => {
    const element = scroll.current;
    anchor.current = null;
    if (!element || mode.current !== "free") return;
    const top = element.getBoundingClientRect().top;
    const target = firstMessageBelow(element, top, placeRows);
    if (target) anchor.current = { id: placeId(target), offset: target.getBoundingClientRect().top - top };
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
  // what is above it, and it shrinks as the reply grows into it. Once what follows the message has
  // filled the view, the space is never reserved again for it: a request card or tool rows that
  // later fold or leave must not turn into a blank screen below the finished reply. Only content
  // growing into the space fills it. A view that shrinks, as when a phone's keyboard opens, needs
  // less space for now, and gets it back when it grows again.
  const reserveEnd = () => {
    const element = scroll.current, space = endSpace.current, sent = sentMessage(), anchor = sendAnchor.current;
    if (!element || !space) return;
    const reserve = space.offsetHeight, content = element.scrollHeight - reserve;
    const next = sent && anchor?.filled !== sent ? endReserve({
      offset: sent.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop,
      scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, reserve,
    }) : 0;
    if (sent && anchor && next === 0 && content > (anchor.content ?? Infinity)) anchor.filled = sent;
    if (anchor) anchor.content = content;
    if (next !== reserve) space.style.height = next ? `${next}px` : "";
  };
  // Brings the opened message into view, a little below the top, and marks it briefly.
  const showFound = (item: HTMLElement, mark = true, needle?: string) => {
    const element = scroll.current!;
    const range = needle ? matchRanges(item, needle)[0] : undefined;
    const top = range?.getBoundingClientRect?.().top ?? item.getBoundingClientRect().top;
    element.scrollTop += top - element.getBoundingClientRect().top - Math.min(120, element.clientHeight / 4);
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
    if (atAttention && ![...element.querySelectorAll<HTMLElement>('[data-attention-kind="clarify"], [data-attention-kind="approval"]')].some(card => card.id === atAttention)) {
      setAtAttention(null);
      mode.current = "follow";
    }
    const request = reveal.current;
    reveal.current = null;
    const card = request ? [...element.querySelectorAll<HTMLElement>(".secure-request")]
      .find(item => item.dataset.requestId === request) : !restored.current && !target.current
        ? element.querySelector<HTMLElement>('[data-attention-kind="clarify"], [data-attention-kind="approval"]') : undefined;
    // The message asked for opens once its own page arrived, not on a render of an older one.
    const opening = target.current?.botId === botId && target.current.ready ? target.current.messageId : undefined;
    const opened = opening ? messageElement(element, opening) : undefined;
    if (opening) target.current = null;
    if (opened) showFound(opened);
    else if (card) {
      element.scrollTop += card.getBoundingClientRect().top - element.getBoundingClientRect().top;
      mode.current = "free";
      holdPlace();
      setAtAttention(card.dataset.attentionKind === "approval" || card.dataset.attentionKind === "clarify" ? card.id : null);
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
    setAtAttention(null);
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
    // The view shrinks when a phone's keyboard opens or the composer grows, which moves no content,
    // so a follower would otherwise end up with the latest message under the composer.
    if (element) observer.observe(element);
    return () => { observer.disconnect(); stop?.(); };
  }, []);
  const jumpToLatest = useCallback(() => {
    setAtAttention(null);
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
    setAtAttention(null);
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
  const openMessage = useCallback((messageId: string, mark = true, needle?: string) => {
    setAtAttention(null);
    const element = scroll.current;
    const item = element ? messageElement(element, messageId) : undefined;
    if (item) {
      showFound(item, mark, needle);
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
  // One object while nothing in it changes, so the memoized transcript skips a keystroke in the composer.
  const hasEarlier = (conversation?.earlier ?? 0) > 0;
  const complete = conversation?.earlier === 0;
  const history = useMemo(() => ({
    earlier: hasEarlier,
    complete,
    ...earlier,
    atLatest,
    atAttention,
    unseen,
    loadEarlier,
    jumpToLatest,
    anchorSend,
    sentAs,
    openMessage,
    openAt,
  }), [hasEarlier, complete, earlier, atLatest, atAttention, unseen, loadEarlier, jumpToLatest, anchorSend, sentAs, openMessage, openAt]);
  return { conversation, setConversation, disconnected, readFailed, reply, reviewed, setReviewed, scroll, endSpace, content, history, persistPosition };
}
