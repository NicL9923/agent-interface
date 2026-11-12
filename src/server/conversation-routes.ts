import type { FastifyInstance, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { interruptionPendingMessage, submissionConflictMessage } from "../shared/errors.js";
import { filesBefore, HISTORY_PAGE_TURNS, historyWindow, MAX_HISTORY_TURNS, windowFiles } from "../shared/history.js";
import { messageOrigin } from "../shared/message-origin.js";
import { isRetryRequestId, retryRequestId } from "../shared/retry-id.js";
import type { Approval, ApprovalChoice, ApprovalScope, CapabilityKey, InflightDelta, ReadTiming, Runtime, Submission, SubmissionReceipt, TurnEvent } from "../shared/types.js";
import { MAX_MESSAGE_TEXT } from "../shared/api.js";
import { formatBytes, MAX_ATTACHMENTS, MAX_DOWNLOAD_BYTES, MAX_UPLOAD_BYTES, UPLOAD_KINDS, UPLOAD_MIME_TYPES } from "../shared/uploads.js";
import { accountMarker } from "./apns.js";
import { apiRoute, type ApiRequest } from "./api-route.js";
import { signedIn, stillSignedIn } from "./auth.js";
import { redactAgents, visibleTo, type Roster } from "./bot-access.js";
import type { Config } from "./config.js";
import { compareVersions } from "../shared/inflight.js";
import { eventStreamConnection, type EventStream } from "./event-stream.js";
import { httpError } from "./http-error.js";
import { routePattern } from "./route-path.js";
import { SendTimings, sendTimingHeader, type SendPhases } from "./send-timing.js";
import { fileRef, id } from "./schemas.js";
import type { Store } from "./store.js";
import { withAdmission } from "./store-submissions.js";
import { nameRequesters } from "./vault.js";
import { shownMessages } from "./conversation-view.js";

// Longer than the runtime shares one history read among readers.
const sharedReadMargin = 60000;

/**
 * The least time between two live updates on a `?inflight=1` or `?inflight=2` stream. `?inflight=1` sends the
 * whole reply each time: at 100 ms a 20,000-character reply cost 207 KB a second per stream instead of 83 KB,
 * 1.24 MB a second for a household's six streams. `?inflight=2` is the iOS app's, which shows each update as it
 * lands and re-renders the conversation for it; that cost was not measured on a phone, so it stays as it was.
 * Measured November 10, 2026: docs/ledger/20261110T210126Z-live-tick.md.
 */
export const LIVE_TICK_MS = 250;
/**
 * The least time between two live updates on a `?inflight=3` turn stream, the web client's. Its paced reveal
 * spreads each update over CATCH_UP_MS (src/components/streaming-reveal.ts), so at 100 ms instead of 250 a word
 * showed 230 to 264 ms after Hermes produced it instead of 300 to 305 (medians at 150 characters a second; p95
 * 292 to 315 against 338 to 349), with paints still 33 ms apart. Six streams of growth cost the server 7.7 ms
 * of CPU and 12 KB a second, against 3.4 ms and 5.5 KB at 250. Measured as for LIVE_TICK_MS.
 */
export const TURN_TICK_MS = 100;
/**
 * How long a `?inflight=3` stream holds its change notice for a change its turn event will carry, such as a tool
 * finishing, before sending it anyway. The server's turn read after the change takes tens of milliseconds, so
 * this only bounds a read that fails or a Hermes that is slow, and the client then rereads as it always did.
 */
export const TURN_HOLD_MS = 1500;

/** Server-Timing for a conversation read. Headers stay out of the body, so its ETag still matches. */
export function readTimingHeader(timing: ReadTiming, runtime: number, total: number): string {
  const metric = (name: string, ms: number) => `${name};dur=${Math.round(ms * 10) / 10}`;
  return [
    ...(timing.shared !== undefined ? [`cache;desc=${timing.shared ? "shared" : "miss"}`] : []),
    ...(timing.hermes !== undefined ? [metric("hermes", timing.hermes)] : []),
    ...Object.entries(timing.addon ?? {}).map(([phase, ms]) => metric(`addon-${phase}`, ms)),
    // Outside the add-on's handler: native pool queueing, serialization and the socket.
    ...(timing.hermes !== undefined && timing.addon?.total !== undefined ? [metric("transit", Math.max(0, timing.hermes - timing.addon.total))] : []),
    metric("runtime", runtime),
    metric("node", total - runtime),
    metric("total", total),
  ].join(", ");
}

/**
 * A client's answers as Hermes's clarify tool reads them. A multi-select answer is one JSON array of
 * strings. A client that says so sends exactly that, and anything else, including an empty answer, is
 * refused. An older client sends its picks joined with ", " in option order and any written answer last.
 * Hermes would read that as one typed answer, so an answer made only of offered options becomes their
 * array. Anything else passes unchanged as Hermes's typed text: "Water, only if the trough is empty" is
 * written text that starts with an option, and nothing in the payload tells it apart from a pick plus
 * writing. That is how these clients behaved before, so no answer becomes a pick the person didn't make.
 * When an option itself contains ", " the split could be wrong, so that answer also passes unchanged.
 */
export function multiSelectAnswers(questions: { id: string; options?: string[]; multiple?: boolean }[],
  answers: Record<string, string>, format?: "json"): Record<string, string> {
  const result = { ...answers };
  for (const question of questions) {
    const answer = answers[question.id], options = question.options ?? [];
    if (!question.multiple || answer === undefined) continue;
    if (format === "json") {
      let picks: unknown;
      try { picks = JSON.parse(answer); } catch { picks = undefined; }
      if (!Array.isArray(picks) || !picks.length || picks.some(pick => typeof pick !== "string" || !pick.trim()))
        throw httpError(400, `Send the answer to "${question.id}" as a JSON array of strings.`);
      continue;
    }
    if (!answer || options.some(option => option.includes(", "))) continue;
    const pieces = answer.split(", ");
    if (pieces.every(piece => options.includes(piece))) result[question.id] = JSON.stringify(pieces);
  }
  return result;
}

/** Why an approval choice cannot be sent, or undefined when Hermes offered it. An older Hermes offers once and deny. */
export function unofferedChoice(approval: Approval, decision: "approved" | "denied", scope?: ApprovalScope): string | undefined {
  if (decision === "denied" && scope !== undefined) return "Decline has no scope.";
  const choice: ApprovalChoice = decision === "denied" ? "deny" : scope ?? "once";
  const offered = approval.choices ?? ["once", "deny"];
  if (offered.includes(choice)) return undefined;
  return choice === "always" ? "Hermes didn't offer Always allow for this request."
    : choice === "session" ? "Hermes didn't offer Allow for this conversation for this request."
    : "Hermes didn't offer that choice for this request.";
}

/** Decides a pending approval for this person, as the chat and notification actions do. */
export async function decideApproval(runtime: Runtime, store: Store, botId: string, approvalId: string, decision: "approved" | "denied", userId: string, scope?: ApprovalScope) {
  const readAt = Date.now();
  const conversation = await runtime.conversation(botId, { history: false });
  store.reconcileApprovals(botId, conversation.requestSessionId, conversation.approvals.map(approval => approval.id), readAt);
  const approval = conversation.approvals.find((a) => a.id === approvalId);
  if (
    !approval ||
    approval.status !== "pending" ||
    store.approval(approvalId) ||
    (approval.expiresAt && Date.parse(approval.expiresAt) < Date.now())
  )
    throw httpError(409, "This approval is no longer pending");
  // Hermes runs an unoffered "always" as a one-time approval, so the person would believe in a grant that never existed.
  const refusal = unofferedChoice(approval, decision, scope);
  if (refusal) throw httpError(409, refusal, { code: "approval_choice_unavailable" });
  await runtime.approve(botId, approvalId, decision, userId, ...(scope && scope !== "once" ? [scope] : []));
  store.attributeApproval(approvalId, botId, userId, decision);
  if (conversation.activity.runId)
    store.participate(conversation.activity.runId, userId);
}

/**
 * One conversation: its history and files, change notices, sending and steering messages,
 * answering requests and approvals, and each person's draft, read position and presence.
 */
export function installConversationRoutes(app: FastifyInstance, collaborators: {
  config: Config;
  runtime: Runtime;
  store: Store;
  roster: Roster;
  /** Open event streams, which the app ends on shutdown. */
  streams: Set<() => void>;
  requireCapability: (key: CapabilityKey) => Promise<void>;
}) {
  const { config, runtime, store, roster, streams, requireCapability } = collaborators;
  // Each admitted send is timed to its own run's first streamed text and first live event on a stream.
  const timings = new SendTimings(app.log);
  const unwatchTurns = runtime.watchTurns?.(timings);
  app.addHook("onClose", async () => { unwatchTurns?.(); timings.close(); });
  apiRoute(app, "GET /bots/:id/conversation", {}, async (req, _body, reply) => {
    const started = performance.now(), timing: ReadTiming = {};
    // Without a window, as for the native app, the whole history is returned. `before` asks for an earlier page only.
    const window = z.object({
      start: z.string().min(1).max(512).optional(),
      turns: z.coerce.number().int().min(0).max(MAX_HISTORY_TURNS).optional(),
      before: z.string().min(1).max(512).optional(),
    }).refine(value => value.start === undefined || value.before === undefined, { message: "Ask for a window from a start or before a message, not both." })
      // An earlier page without a size is a page, not an empty window.
      .transform(value => value.before !== undefined && value.turns === undefined ? { ...value, turns: HISTORY_PAGE_TURNS } : value)
      .parse(req.query);
    const windowed = window.start !== undefined || window.turns !== undefined || window.before !== undefined;
    const readAt = Date.now();
    const { window: cut, requestSessionId, ...result } = await runtime.conversation(req.params.id, windowed ? { window, timing } : { timing });
    const read = performance.now() - started;
    // Hermes's open requests settle approvals answered outside the app. A history read can be
    // shared for a few seconds, so only approvals notified well before it count.
    store.reconcileApprovals(req.params.id, requestSessionId, result.approvals.map(approval => approval.id), readAt - sharedReadMargin);
    const redact = await redactAgents(store, roster, signedIn(req).id);
    if (result.toolCalls) result.toolCalls = result.toolCalls.map(redact.call);
    // A runtime that already cut the window adds only the earlier messages still needed for files.
    const context = cut?.context ?? [];
    const rows = [...context, ...result.messages];
    const originalFileIds = new Set(rows.flatMap(message => message.files ?? []).map(file => file.id));
    const shown = shownMessages(store, req.params.id, redact, rows);
    result.attention = nameRequesters(result.attention, userId => store.getUser(userId)?.name);
    const visibleFileIds = new Set(shown.flatMap(message => message.files ?? []).map(file => file.id));
    result.files = result.files?.filter(file => !originalFileIds.has(file.id) || visibleFileIds.has(file.id));
    let earlier: number | undefined, earlierFiles: number | undefined, before: string | undefined;
    // Where the window starts among the shown messages, and the messages its files are counted over.
    let from = context.length, counted = shown;
    result.messages = shown.slice(context.length);
    if (cut) earlier = cut.earlier;
    else if (windowed) {
      ({ messages: result.messages, earlier } = historyWindow(shown, { start: window.before ?? window.start, turns: window.turns }));
      from = earlier;
    }
    // An earlier page ends just before the message the client holds: where it is, or where the runtime already ended it.
    // A message the history no longer has leaves the latest page, as for an unknown start.
    if (window.before !== undefined) {
      const end = result.messages.findIndex(message => message.id === window.before);
      if (end >= 0 || cut?.before === window.before) {
        before = window.before;
        if (end >= 0) { result.messages = result.messages.slice(0, end); counted = shown.slice(0, from + end); }
      }
    }
    // Signed file references scale with the window too. The rest load on demand.
    if (cut || windowed) ({ files: result.files, earlierFiles } = windowFiles(counted, from, result.files));
    // A page's own files, each once: the client holds those of everything after it.
    if (before !== undefined) {
      const own = new Set(result.messages.flatMap(message => message.files ?? []).map(file => file.id));
      result.files = result.files?.filter(file => own.delete(file.id));
    }
    // Retry stays settled on every device once anyone retried this failure.
    const claims = result.activity.state === "failed" ? store.retryClaims(req.params.id, result.activity.runId ?? "") : [];
    const retried = result.messages.findLast(message => claims.some(claim => claim.retryOf === message.id));
    const retry = claims.find(claim => claim.retryOf === retried?.id);
    reply.header("Server-Timing", readTimingHeader(timing, read, performance.now() - started));
    return {
      ...result,
      ...(retry ? { retry: { ...retry.receipt, retryOf: retry.retryOf } } : {}),
      ...(earlier !== undefined ? { earlier, earlierFiles } : {}),
      ...(before !== undefined ? { before } : {}),
      draft: store.draft(signedIn(req).id, req.params.id),
      readPosition: store.personal(
        "read_positions",
        signedIn(req).id,
        req.params.id,
      ),
    };
  });
  // Files of the history before a window, for the artifacts list.
  apiRoute(app, "GET /bots/:id/files", {}, async req => {
    const { before } = z.object({ before: z.string().min(1).max(512).optional() }).parse(req.query);
    const redact = await redactAgents(store, roster, signedIn(req).id);
    // A window that starts at `before` holds, as its context, every earlier message with files; without `before`, the
    // latest page's context and messages hold all of them. A runtime that does not cut answers the whole history.
    const read = await runtime.conversation(req.params.id, { window: before ? { start: before } : { turns: HISTORY_PAGE_TURNS } });
    return filesBefore([...read.window?.context ?? [], ...read.messages].map(redact.message), before);
  });
  // Change notices for one conversation, so open chats refetch instead of polling. Sign-in
  // and assistant access are the conversation read's own hooks; each notice rechecks the session.
  const watchers = new Map<string, Set<() => void>>();
  // The app's own conversation writes notify at once, before Hermes reports their effect.
  const conversationWrites = new Set(["messages", "steer", "talk/ask", "stop", "requests/:approvalId", "approvals/:approvalId", "secure-requests/:requestId", "computer-handoffs/:requestId", "terminal-requests/:requestId", "connection-requests/:requestId"]
    .map(path => `POST /api/bots/:id/${path}`));
  app.addHook("onResponse", async (req, reply) => {
    if (reply.statusCode < 400 && conversationWrites.has(`${req.method} ${routePattern(req)}`))
      for (const changed of watchers.get((req.params as { id: string }).id) ?? []) changed();
  });
  // Each person's open streams per assistant hear their own draft's new revisions, so a chat open
  // on another device reloads the draft at once instead of polling for it. Only the revision is
  // sent: the stream carries no draft text, and a client that already holds it skips the read.
  const draftStreams = new Map<string, Set<(revision: number) => void>>();
  const draftKey = (userId: string, botId: string) => `${userId}\0${botId}`;
  const unwatchDrafts = store.watchDrafts((userId, botId, revision) => {
    const listeners = draftStreams.get(draftKey(userId, botId));
    // After the writing transaction commits, so a client that reloads at once reads the new draft.
    if (listeners) queueMicrotask(() => { for (const listener of listeners) listener(revision); });
  });
  app.addHook("onClose", async () => unwatchDrafts());
  app.get("/api/bots/:id/events", { exposeHeadRoute: false }, async (req, reply) => {
    // Followed before the first await, so a client that leaves during setup leaves no watcher.
    const connection = eventStreamConnection(reply);
    const botId = id.parse((req.params as { id: string }).id);
    // ?inflight=1 sends each live reply whole, as older installed iOS builds and cached web bundles read it.
    // ?inflight=2 sends only what a reply grew by since the last event this stream sent. The iOS app
    // and web bundles from before turn events read this one.
    // ?inflight=3 sends growth too, and the running turn's saved messages with each whole reply, as one
    // `turn` event, whenever the read the reply is built on changes. The server then reads the turn
    // itself after each change to its structure, so live text never waits for a client's refetch. The
    // web app reads this one.
    const mode = (req.query as { inflight?: string }).inflight;
    const optedIn = mode === "1" || mode === "2" || mode === "3", deltas = mode === "2" || mode === "3", turns = mode === "3";
    const tick = turns ? TURN_TICK_MS : LIVE_TICK_MS;
    // ?drafts=1 adds `event: draft` notices. Without it none are sent: the iOS app reads any
    // unnamed or unknown data line as a conversation change and would refetch on every draft save.
    const draftNotices = (req.query as { drafts?: string }).drafts === "1";
    // The privacy version the redaction below was built for. Every change to who owns or shares an
    // assistant advances it, so comparing versions replaces re-reading and comparing the private list.
    let seen = store.privacyVersion;
    let redact = optedIn ? await redactAgents(store, roster, signedIn(req).id) : undefined;
    if (connection.closed) return connection.abandon();
    let last = 0, pending: ReturnType<typeof setTimeout> | undefined;
    let livePending: ReturnType<typeof setTimeout> | undefined, liveLast = 0;
    let stream: EventStream | undefined;
    // What this stream last sent of the live reply, after redaction, so growth is measured on what
    // the viewer may see and never on the raw reply.
    // A turn stream's growth is based on the version its last whole event carried.
    let sent: { id: string; text: string; reasoning: string; rest: string; tools: string; activity: string; version?: string } | undefined;
    // A streamed reply changes on every token. Notices go at most once a second.
    const changed = () => {
      pending ??= setTimeout(() => {
        pending = undefined; last = Date.now();
        // A client drops the live reply it holds on this notice, so the next one goes whole. A turn
        // stream's client keeps it: versions, not this notice, say which read it belongs with.
        if (!turns) sent = undefined;
        stream?.send("data: change\n\n");
      }, Math.max(0, last + 1000 - Date.now()));
    };
    // A turn stream's notice for a change its turn event carries whole waits here for that event: the newest such change,
    // and the notice sent after TURN_HOLD_MS if no turn event has reached it. The event makes a reread for the
    // same messages, tools and activity needless; approvals and requests come in frames that are never held.
    let held: { version: string; timer: ReturnType<typeof setTimeout> } | undefined;
    const sendHeld = () => { clearTimeout(held?.timer); held = undefined; changed(); };
    const hold = (version: string) => {
      if (!held) held = { version, timer: setTimeout(sendHeld, TURN_HOLD_MS) };
      else if ((compareVersions(version, held.version) ?? 0) > 0) held.version = version;
    };
    /** A turn event at `version` went out: it covers the held change when it reaches it. */
    const covered = (version: string) => { if (held && (compareVersions(version, held.version) ?? -1) >= 0) { clearTimeout(held.timer); held = undefined; } };
    const holds = turns && !!runtime.turn && !!runtime.followTurns;
    // The server's own turn read has landed, and the next tick answers it.
    let restoredRead = false;
    const notice = (kind?: "inflight", turnVersion?: string) => {
      if (!optedIn || kind !== "inflight") {
        clearTimeout(livePending); livePending = undefined;
        if (optedIn) { redact = undefined; seen = -1; }
        if (holds && turnVersion) hold(turnVersion);
        else changed();
        return;
      }
      livePending ??= setTimeout(() => {
        livePending = undefined;
        // A client that has not read what this stream already wrote gets nothing more until it has, so a slow
        // one never has the server hold more than one update past the socket's buffer. `sent` stays what the
        // client last got, so the update after the drain carries all the growth it missed.
        if (stream && !stream.writable(() => notice("inflight"))) return;
        // On a turn stream, a tick that finds no reply to send leaves the window open, so the reply restored next goes at once.
        const previous = liveLast;
        liveLast = Date.now();
        const afterRead = restoredRead;
        restoredRead = false;
        let delivered = false;
        void (async () => {
          // Privacy can change through another assistant's settings while this stream stays open.
          if (store.privacyVersion !== seen) {
            const version = store.privacyVersion;
            redact = await redactAgents(store, roster, signedIn(req).id);
            // Changed again while rebuilding: leave it stale for the next tick and have the client refetch.
            if (store.privacyVersion !== version) { sendHeld(); return; }
            seen = version;
          }
          // A turn stream's reply carries the read it is built on, so a runtime without turns sends it nothing live.
          const turn = turns ? runtime.turn?.(botId) : undefined;
          const value = turns ? turn : runtime.inflight?.(botId);
          // A structural read is already pending when its snapshot was invalidated. On a turn stream that read is
          // the server's own, and the reply it restores goes at once.
          if (!value || !redact) { if (turns) liveLast = previous; return; }
          const message = redact.message(value.message), toolCalls = value.toolCalls.map(redact.call);
          if (deltas) {
            const reasoning = message.reasoning ?? "";
            const next = { id: message.id, text: message.text, reasoning, tools: JSON.stringify(toolCalls),
              // Everything else about the message, which a growth notice cannot carry.
              rest: JSON.stringify({ ...message, text: "", reasoning: undefined }), activity: JSON.stringify(value.activity),
              ...(turn ? { version: turn.version } : {}) };
            const base = sent;
            sent = next;
            if (base && base.id === next.id && base.rest === next.rest && base.version === next.version
              && next.text.startsWith(base.text) && reasoning.startsWith(base.reasoning)) {
              const appendText = next.text.slice(base.text.length), appendReasoning = reasoning.slice(base.reasoning.length);
              const toolsChanged = base.tools !== next.tools;
              if (!appendText && !appendReasoning && !toolsChanged && base.activity === next.activity) return;
              const delta: InflightDelta = { botId: value.botId, messageId: message.id,
                baseTextLength: base.text.length, baseReasoningLength: base.reasoning.length,
                ...(appendText ? { appendText } : {}), ...(appendReasoning ? { appendReasoning } : {}),
                activity: value.activity, ...(toolsChanged ? { toolCalls } : {}) };
              if (stream?.send(`event: inflight-delta\ndata: ${JSON.stringify(delta)}\n\n`)) timings.written(botId, value.activity.runId);
              return;
            }
          }
          if (turn) {
            const event: TurnEvent = { botId: turn.botId, version: turn.version, messages: shownMessages(store, botId, redact, turn.turn.messages),
              ...(turn.turn.after !== undefined ? { after: turn.turn.after } : {}), message, activity: turn.activity, toolCalls };
            if (stream?.send(`event: turn\ndata: ${JSON.stringify(event)}\n\n`)) { timings.written(botId, turn.activity.runId); delivered = true; covered(turn.version); }
            return;
          }
          if (stream?.send(`event: inflight\ndata: ${JSON.stringify({ ...value, message, toolCalls })}\n\n`)) timings.written(botId, value.activity.runId);
        })().catch(() => changed()).finally(() => {
          // The read landed and no turn event went out for it, as when the turn just ended: nothing carries the change, so
          // the client's own read does.
          if (afterRead && !delivered && held) sendHeld();
        });
      }, Math.max(0, liveLast + tick - Date.now()));
    };
    const listeners = watchers.get(botId) ?? new Set();
    const ownDraft = draftKey(signedIn(req).id, botId);
    const drafts = draftStreams.get(ownDraft) ?? new Set();
    const draftChanged = (revision: number) => stream?.send(`event: draft\ndata: ${revision}\n\n`);
    let unwatch: (() => void) | undefined, unfollow: (() => void) | undefined;
    const teardown = () => {
      unwatch?.();
      unfollow?.();
      listeners.delete(changed);
      if (!listeners.size && watchers.get(botId) === listeners) watchers.delete(botId);
      drafts.delete(draftChanged);
      if (!drafts.size && draftStreams.get(ownDraft) === drafts) draftStreams.delete(ownDraft);
      clearTimeout(pending);
      clearTimeout(livePending);
      clearTimeout(held?.timer);
    };
    stream = connection.open(streams, {
      reserve: () => {
        watchers.set(botId, listeners.add(changed));
        if (draftNotices) draftStreams.set(ownDraft, drafts.add(draftChanged));
        unwatch = runtime.watch?.(botId, notice);
        // Only turn streams hear the server's own turn reads; ?inflight=1 and ?inflight=2 wait for a client's read.
        // A restored turn goes at once, without waiting out the tick: it carries a new structure, such as the
        // saved reply of a turn that just ended, and comes at most once per server read.
        if (turns) unfollow = runtime.followTurns?.(botId, () => {
          clearTimeout(livePending); livePending = undefined; liveLast = 0;
          restoredRead = true;
          notice("inflight");
        });
      },
      // Ends, sending nothing more, once the person signs out or the assistant becomes someone else's.
      allowed: () => stillSignedIn(store, config, req) && visibleTo(store, botId, req.user?.id),
      teardown,
    });
  });
  const message = z
    .object({
      requestId: z.string().uuid(),
      text: z.string().max(MAX_MESSAGE_TEXT),
      attachments: z.array(fileRef).max(MAX_ATTACHMENTS).default([]),
      reviewedInterruption: z.boolean().default(false),
      reviewedUncertain: z.boolean().default(false),
      draftBaseRevision: z.number().int().min(0).optional(),
      retryOf: z.string().min(1).max(512).optional(),
    })
    .refine((v) => !!v.text.trim() || !!v.attachments.length, {
      message: "Message cannot be empty",
    })
    // A retry resends an earlier message and must never be matched to, or clear, a draft.
    .refine((v) => v.retryOf === undefined || v.draftBaseRevision === undefined, {
      message: "A retry is not written on a draft",
    });
  // Shared with live Talk, whose spoken requests are ordinary messages from the person speaking.
  // phases records when the request reached Hermes and was admitted, for Server-Timing and the send's timing log.
  const submit = async (target: { botId: string; requesterId: string }, body: z.output<typeof message>, explicitSteering = false, voice = false,
    phases: SendPhases = { arrival: performance.now() }): Promise<SubmissionReceipt> => {
    const { reviewedInterruption, reviewedUncertain, ...message } = body;
    if (message.retryOf !== undefined && explicitSteering) throw httpError(400, "Retry a message by sending it, not by steering");
    const { requesterId } = target;
    let input: Submission = {
      ...message,
      botId: target.botId,
      senderId: requesterId,
    };
    // Retry IDs are derived from their failed turn, so nobody can take one with another message.
    if (input.retryOf === undefined && isRetryRequestId(input.requestId))
      throw httpError(400, "This request ID is kept for retrying a failed turn. Send the message with a new ID.");
    const previous = store.submission(input.requestId);
    const interruptionRejected = previous?.reason === "interruption_pending";
    const retryInterruption = interruptionRejected && reviewedInterruption;
    if (previous) {
      // Every device derives one ID for retrying a failed turn, so another person, or a client
      // that copied the text differently, follows the request already recorded. Reviewing an
      // uncertain one sends the recorded request again, as its original sender: Hermes's
      // idempotency check covers the sender, so anyone else's copy would be a second message.
      if (input.retryOf !== undefined && previous.input.retryOf === input.retryOf && previous.input.botId === input.botId
        && JSON.stringify(previous.input) !== JSON.stringify(input)) {
        if (!reviewedUncertain || previous.receipt.status !== "uncertain") return previous.receipt;
        input = previous.input;
      }
      if (JSON.stringify(previous.input) !== JSON.stringify(input))
        throw httpError(409, submissionConflictMessage, { code: "submission_conflict" });
      if (interruptionRejected && !reviewedInterruption)
        throw httpError(409, interruptionPendingMessage);
      if (!retryInterruption && (!reviewedUncertain || previous.receipt.status !== "uncertain"))
        return previous.receipt;
      await requireCapability("idempotency");
      const known = await runtime.lookupSubmission(input.requestId);
      if (known) {
        store.receipt(known, undefined, retryInterruption);
        return known;
      }
    } else if (reviewedUncertain) {
      await requireCapability("idempotency");
    }
    await requireCapability("chat");
    const fast = await runtime.canonicalSubmit?.() === true;
    // A retry reads the window that starts at its message, which also proves the message is still there.
    const conversation = input.retryOf !== undefined
      ? await runtime.conversation(input.botId, { window: { start: input.retryOf } })
      : fast ? undefined : await runtime.conversation(input.botId, { history: false });
    if (conversation?.activity.state === "interrupted" && !reviewedInterruption)
      throw httpError(409, interruptionPendingMessage);
    if (input.retryOf !== undefined) {
      const redact = await redactAgents(store, roster, input.senderId);
      const target = conversation!.messages.find(message => message.id === input.retryOf);
      // Only a person's own words are retried, never a scheduled delivery or another assistant's message.
      const origin = target && messageOrigin(redact.message(target));
      if (!target || target.role !== "user" || origin && origin.kind !== "human")
        throw httpError(400, "That message is no longer in this conversation");
      // Steering the retried text into a running turn would answer a different question.
      if (["thinking", "working", "waiting", "blocked"].includes(conversation!.activity.state))
        throw httpError(409, "Wait for the current reply to finish before retrying");
      // A retry carries exactly its failed turn's ID, so one turn has one request everywhere.
      if (input.requestId !== await retryRequestId(input.botId, input.retryOf, conversation!.activity.runId ?? ""))
        throw httpError(400, "This retry doesn't match the failed turn. Reload the conversation and retry again.");
    }
    const steering =
      explicitSteering ||
      ["thinking", "working", "waiting", "blocked"].includes(
        conversation?.activity.state ?? "idle",
      );
    if (steering || fast) await requireCapability("steering");
    // The first retry of a failed turn claims it; any later one, from anyone, follows that request.
    const intent = input.retryOf !== undefined
      ? store.claimRetry(conversation!.activity.runId ?? "", input as Submission & { retryOf: string })
      : store.intent(input);
    if ("claimed" in intent) return intent.claimed;
    if (!intent.created && !reviewedUncertain && !retryInterruption) return intent.receipt;
    if (conversation?.activity.runId)
      for (const userId of new Set([input.senderId, requesterId])) store.participate(conversation.activity.runId, userId);
    // Measuring starts before Hermes is asked, because Hermes starts the turn and may stream before it answers.
    const timing = timings.begin(input.botId, input.requestId, phases.arrival);
    try {
      // The voice mark goes only to Hermes. It is not part of the recorded request, so asking again
      // with the same ID never conflicts with a request recorded before Talk carried it.
      phases.hermesStart = performance.now();
      let receipt: SubmissionReceipt;
      try {
        receipt = await (steering
          ? runtime.steer({ ...input, reviewedInterruption })
          : runtime.submit({ ...input, reviewedInterruption, ...(voice ? { voice: true } : {}) }));
      } catch (error) { timings.discard(timing); throw error; }
      phases.admitted = performance.now();
      if (receipt.status === "accepted")
        timings.admitted(timing, voice ? "talk" : explicitSteering ? "steer" : "messages",
          receipt.steered ?? steering, { arrival: phases.arrival, hermesStart: phases.hermesStart, admitted: phases.admitted }, receipt.runId, receipt.turn);
      else timings.discard(timing);
      store.receipt(receipt, undefined, retryInterruption);
      if (receipt.runId) for (const userId of new Set([input.senderId, requesterId])) store.participate(receipt.runId, userId);
      return receipt;
    } catch (error) {
      if ((error as { code?: string }).code === "interruption_pending") {
        store.receipt({ requestId: input.requestId, status: "rejected", message: interruptionPendingMessage }, "interruption_pending");
        throw httpError(409, interruptionPendingMessage);
      }
      return store.submission(input.requestId)!.receipt;
    }
  };
  const sender = (req: ApiRequest<"POST /bots/:id/messages" | "POST /bots/:id/steer">) => ({ botId: req.params.id, requesterId: signedIn(req).id });
  // Fastify's elapsed time starts when the request arrived, before sign-in and body parsing.
  const timedSend = (steer: boolean) => async (req: ApiRequest<"POST /bots/:id/messages" | "POST /bots/:id/steer">, body: z.output<typeof message>, reply: FastifyReply) => {
    const phases: SendPhases = { arrival: performance.now() - reply.elapsedTime };
    const receipt = await submit(sender(req), body, steer, false, phases);
    reply.header("Server-Timing", sendTimingHeader(phases, performance.now()));
    return receipt;
  };
  apiRoute(app, "POST /bots/:id/messages", { body: message }, timedSend(false));
  apiRoute(app, "POST /bots/:id/steer", { body: message }, timedSend(true));
  apiRoute(app, "GET /submissions/:id", {}, async req => {
    const requestId = z.string().uuid().parse(req.params.id);
    const recorded = store.submission(requestId);
    // Only its sender, while they can still see the assistant, learns anything about a recorded
    // submission. An unrecorded ID is a client's own unguessable pending ID, kept checkable,
    // which lets a former sender check their own message after its assistant is deleted.
    // A retry's receipt belongs to its failed turn, which anyone who sees the assistant can retry and follow.
    const previous = recorded && (recorded.input.senderId === signedIn(req).id || recorded.input.retryOf !== undefined)
      && visibleTo(store, recorded.input.botId, signedIn(req).id) ? recorded : undefined;
    if (recorded && !previous) return { requestId, status: "uncertain", message: "No admission receipt was found yet. A delayed original request may still arrive. Preserve this request ID and review before retrying the same message." };
    // The sender also learns what text the request carried; anyone else following a retry does not.
    const own = previous && previous.input.senderId === signedIn(req).id ? previous.input.text : undefined;
    const told = (receipt: SubmissionReceipt): SubmissionReceipt => own === undefined ? receipt : { ...receipt, text: own };
    try {
      if ((await runtime.capabilities()).idempotency.supported) {
        const receipt = await runtime.lookupSubmission(requestId);
        if (receipt) {
          if (previous) store.receipt(receipt);
          // A client whose answer was lost learns the turn here.
          return told(withAdmission(receipt, previous?.receipt));
        }
        if (!previous)
          return {
            requestId,
            status: "uncertain",
            message:
              "No admission receipt was found yet. A delayed original request may still arrive. Preserve this request ID and review before retrying the same message.",
          };
      }
    } catch {
      /* Missing transport evidence stays uncertain, never replay. */
    }
    return (
      (previous && told(previous.receipt)) ?? {
        requestId,
        status: "uncertain",
        message:
          "Admission cannot be verified while Hermes is unavailable. This message will not be automatically resent.",
      }
    );
  });
  const answers = z.object({ answers: z.record(z.string().max(200), z.string().max(10000)), answerFormat: z.literal("json").optional() });
  apiRoute(app, "POST /bots/:id/requests/:approvalId", { body: answers }, async (req, { answers, answerFormat }) => {
    const p = req.params;
    const conversation = await runtime.conversation(p.id, { history: false });
    const attention = conversation.attention?.find(
      (x) => x.id === p.approvalId,
    );
    if (!attention || attention.kind !== "clarify")
      throw httpError(
        409,
        "This request must be handled in the official Hermes interface or is no longer pending",
      );
    await runtime.answerRequest(p.id, p.approvalId, multiSelectAnswers(attention.questions ?? [], answers, answerFormat));
    if (conversation.activity.runId)
      store.participate(conversation.activity.runId, signedIn(req).id);
    return { ok: true };
  });
  // The web names the run it showed, so a Stop never interrupts another run or an idle session. The iOS Live Activity's
  // Stop names the account it was started for, as a notification's Decline does. The iOS chat's Stop, and a web client
  // from before runId, send an empty or no body: they stop whatever runs now, and are refused when nothing does.
  const stopBody = z.object({ runId: z.string().min(1).max(200).optional(), account: z.string().max(64).optional() }).strict().optional();
  apiRoute(app, "POST /bots/:id/stop", { body: stopBody }, async (req, body) => {
    if (body?.account !== undefined && body.account !== accountMarker(signedIn(req).id))
      throw httpError(409, "This activity belongs to a different account");
    await requireCapability("stop");
    await runtime.stop(req.params.id, body?.runId);
    return { ok: true };
  });
  const decision = z.object({ decision: z.enum(["approved", "denied"]), scope: z.enum(["once", "session", "always"]).optional(), account: z.string().max(64).optional() });
  apiRoute(app, "POST /bots/:id/approvals/:approvalId", { before: () => requireCapability("approvals"), body: decision },
    async (req, { decision, scope, account }) => {
    const p = req.params;
    // An iOS notification action names the account it was sent to. Another person signed in on that phone must not decide it.
    if (account !== undefined && account !== accountMarker(signedIn(req).id))
      throw httpError(409, "This approval was sent to a different account");
    await decideApproval(runtime, store, p.id, p.approvalId, decision, signedIn(req).id, scope);
    return { ok: true };
  });
  apiRoute(app, "GET /bots/:id/draft", {}, async req => store.draft(signedIn(req).id, req.params.id));
  const draft = z.object({ text: z.string().max(MAX_MESSAGE_TEXT), attachments: z.array(fileRef).max(MAX_ATTACHMENTS).default([]), baseRevision: z.number().int().min(0).optional() });
  apiRoute(app, "PUT /bots/:id/draft", { body: draft }, async (req, { baseRevision, ...value }, reply) => {
    const result = store.saveDraft(signedIn(req).id, req.params.id, value, baseRevision);
    if (!result.saved)
      return reply.code(409).send({ error: "This draft changed on another device.", code: "draft_conflict", draft: result.draft });
    return result.draft;
  });
  apiRoute(app, "GET /bots/:id/read-position", {}, async req =>
    store.personal("read_positions", signedIn(req).id, req.params.id),
  );
  const readPosition = z.object({
    messageId: z.string().max(200).optional(),
    scrollTop: z.number().min(0).optional(),
  });
  apiRoute(app, "PUT /bots/:id/read-position", { body: readPosition }, async (req, value) => {
    store.savePersonal("read_positions", signedIn(req).id, req.params.id, value);
    return value;
  });
  // Heartbeats from the chat on screen. Notifications skip chats the person is reading or has read.
  const presence = z.object({ client: z.string().min(1).max(100), state: z.enum(["active", "left", "idle"]) });
  apiRoute(app, "PUT /bots/:id/presence", { body: presence }, async (req, { client, state }) => {
    store.chatPresence(signedIn(req).id, req.params.id, client, state);
    return { ok: true };
  });
  apiRoute(app, "POST /bots/:id/uploads", {}, async req => {
    await requireCapability("uploads");
    const file = await req.file();
    if (!file) throw httpError(400, "No file provided");
    if (!(UPLOAD_MIME_TYPES as readonly string[]).includes(file.mimetype))
      throw httpError(415, `Use ${UPLOAD_KINDS}.`);
    const data = await file.toBuffer();
    if (file.file.truncated) throw httpError(413, `${file.filename || "This file"} is larger than ${formatBytes(MAX_UPLOAD_BYTES)}.`);
    return runtime.upload(req.params.id, {
      name: file.filename,
      mime: file.mimetype,
      data,
    });
  });
  // Stays no-store like every API response. An id is signed over a path, not a version, so an
  // overwritten artifact keeps its URL, and a browser cache is shared by whoever signs in next.
  app.get("/api/files/:id", async (req, reply) => {
    await requireCapability("generatedFiles");
    const file = await runtime.download((req.params as { id: string }).id, MAX_DOWNLOAD_BYTES);
    if (file.size !== undefined) reply.header("Content-Length", file.size);
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      )
      .type(
        [
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
          "application/pdf",
          "text/plain",
        ].includes(file.mime)
          ? file.mime
          : "application/octet-stream",
      );
    // Fastify drains a HEAD response's stream, so a stalled Hermes read would outlive it.
    if (req.method === "HEAD") {
      await file.body.cancel();
      // An empty stream keeps the file's length; an empty payload would report zero.
      return reply.send(Readable.from([]));
    }
    // Stream so one large artifact never sits in this process's memory.
    // Fastify destroys this when the person disconnects, which cancels the Hermes read.
    return reply.send(Readable.fromWeb(file.body as import("node:stream/web").ReadableStream<Uint8Array>));
  });
  return {
    /**
     * Sends a spoken Talk request as this person, with the same idempotency, admission and steering as
     * the chat. A new turn runs on Hermes's voice route.
     */
    send: (botId: string, requesterId: string, requestId: string, text: string) =>
      submit({ botId, requesterId }, message.parse({ requestId, text }), false, true),
  };
}
