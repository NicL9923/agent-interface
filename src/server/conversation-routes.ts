import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { interruptionPendingMessage } from "../shared/errors.js";
import { filesBefore, historyWindow, MAX_HISTORY_TURNS, windowFiles } from "../shared/history.js";
import { messageOrigin } from "../shared/message-origin.js";
import type { CapabilityKey, Runtime, Submission, SubmissionReceipt } from "../shared/types.js";
import { formatBytes, MAX_ATTACHMENTS, MAX_DOWNLOAD_BYTES, MAX_UPLOAD_BYTES, UPLOAD_KINDS, UPLOAD_MIME_TYPES } from "../shared/uploads.js";
import { accountMarker } from "./apns.js";
import { apiRoute, type ApiRequest } from "./api-route.js";
import { signedIn, stillSignedIn } from "./auth.js";
import { redactAgents, visibleTo, type Roster } from "./bot-access.js";
import type { Config } from "./config.js";
import { eventStreamConnection, type EventStream } from "./event-stream.js";
import { httpError } from "./http-error.js";
import { routePattern } from "./route-path.js";
import { fileRef, id } from "./schemas.js";
import type { Store } from "./store.js";
import { nameRequesters } from "./vault.js";

// Longer than the runtime shares one history read among readers.
const sharedReadMargin = 60000;

/** Decides a pending approval for this person, as the chat and notification actions do. */
export async function decideApproval(runtime: Runtime, store: Store, botId: string, approvalId: string, decision: "approved" | "denied", userId: string) {
  const readAt = Date.now();
  const conversation = await runtime.conversation(botId, { history: false });
  store.reconcileApprovals(botId, conversation.approvals.map(approval => approval.id), readAt);
  const approval = conversation.approvals.find((a) => a.id === approvalId);
  if (
    !approval ||
    approval.status !== "pending" ||
    store.approval(approvalId) ||
    (approval.expiresAt && Date.parse(approval.expiresAt) < Date.now())
  )
    throw httpError(409, "This approval is no longer pending");
  await runtime.approve(botId, approvalId, decision, userId);
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
  apiRoute(app, "GET /bots/:id/conversation", {}, async req => {
    // Without a window, as for the native app, the whole history is returned.
    const window = z.object({
      start: z.string().min(1).max(512).optional(),
      turns: z.coerce.number().int().min(0).max(MAX_HISTORY_TURNS).optional(),
    }).parse(req.query);
    const windowed = window.start !== undefined || window.turns !== undefined;
    const readAt = Date.now();
    const { window: cut, ...result } = await runtime.conversation(req.params.id, windowed ? { window } : undefined);
    // Hermes's open requests settle approvals answered outside the app. A history read can be
    // shared for a few seconds, so only approvals notified well before it count.
    store.reconcileApprovals(req.params.id, result.approvals.map(approval => approval.id), readAt - sharedReadMargin);
    // Attribution augments the canonical Hermes history, never stores a transcript.
    const redact = await redactAgents(store, roster, signedIn(req).id);
    if (result.toolCalls) result.toolCalls = result.toolCalls.map(redact.call);
    // A runtime that already cut the window adds only the earlier messages still needed for files.
    const context = cut?.context ?? [];
    const read = [...context, ...result.messages];
    const originalFileIds = new Set(read.flatMap(message => message.files ?? []).map(file => file.id));
    const shown = read.map((message) => {
      const attribution =
        store.submissionForMessage(req.params.id, message.id) ??
        store.submission(message.id);
      const user = attribution
        ? store.getUser(attribution.input.senderId)
        : undefined;
      return user
        ? { ...message, origin: undefined, sender: { id: user.id, name: user.name } }
        : message;
    }).map(redact.message);
    result.attention = nameRequesters(result.attention, userId => store.getUser(userId)?.name);
    const visibleFileIds = new Set(shown.flatMap(message => message.files ?? []).map(file => file.id));
    result.files = result.files?.filter(file => !originalFileIds.has(file.id) || visibleFileIds.has(file.id));
    let earlier: number | undefined, earlierFiles: number | undefined;
    result.messages = shown.slice(context.length);
    if (cut) {
      earlier = cut.earlier;
      // Signed file references scale with the window too. The rest load on demand.
      ({ files: result.files, earlierFiles } = windowFiles(shown, context.length, result.files));
    } else if (windowed) {
      ({ messages: result.messages, earlier } = historyWindow(shown, window));
      ({ files: result.files, earlierFiles } = windowFiles(shown, earlier, result.files));
    }
    // Retry stays settled on every device once anyone retried this failure.
    const claims = result.activity.state === "failed" ? store.retryClaims(req.params.id, result.activity.runId ?? "") : [];
    const retried = result.messages.findLast(message => claims.some(claim => claim.retryOf === message.id));
    const retry = claims.find(claim => claim.retryOf === retried?.id);
    return {
      ...result,
      ...(retry ? { retry: { ...retry.receipt, retryOf: retry.retryOf } } : {}),
      ...(earlier !== undefined ? { earlier, earlierFiles } : {}),
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
    return filesBefore((await runtime.conversation(req.params.id)).messages.map(redact.message), before);
  });
  // Change notices for one conversation, so open chats refetch instead of polling. Sign-in
  // and assistant access are the conversation read's own hooks; each notice rechecks the session.
  const watchers = new Map<string, Set<() => void>>();
  // The app's own conversation writes notify at once, before Hermes reports their effect.
  const conversationWrites = new Set(["messages", "steer", "stop", "requests/:approvalId", "approvals/:approvalId", "secure-requests/:requestId"]
    .map(path => `POST /api/bots/:id/${path}`));
  app.addHook("onResponse", async (req, reply) => {
    if (reply.statusCode < 400 && conversationWrites.has(`${req.method} ${routePattern(req)}`))
      for (const changed of watchers.get((req.params as { id: string }).id) ?? []) changed();
  });
  app.get("/api/bots/:id/events", { exposeHeadRoute: false }, async (req, reply) => {
    // Followed before the first await, so a client that leaves during setup leaves no watcher.
    const connection = eventStreamConnection(reply);
    const botId = id.parse((req.params as { id: string }).id);
    const optedIn = (req.query as { inflight?: string }).inflight === "1";
    let redact = optedIn ? await redactAgents(store, roster, signedIn(req).id) : undefined;
    if (connection.closed) return connection.abandon();
    let hidden = JSON.stringify(store.privateBots());
    let last = 0, pending: ReturnType<typeof setTimeout> | undefined;
    let livePending: ReturnType<typeof setTimeout> | undefined, liveLast = 0;
    let stream: EventStream | undefined;
    // A streamed reply changes on every token. Notices go at most once a second.
    const changed = () => {
      pending ??= setTimeout(() => { pending = undefined; last = Date.now(); stream?.send("data: change\n\n"); },
        Math.max(0, last + 1000 - Date.now()));
    };
    const notice = (kind?: "inflight") => {
      if (!optedIn || kind !== "inflight") {
        clearTimeout(livePending); livePending = undefined;
        if (optedIn) { redact = undefined; hidden = ""; }
        changed(); return;
      }
      livePending ??= setTimeout(() => {
        livePending = undefined; liveLast = Date.now();
        void (async () => {
          // Privacy can change through another assistant's settings while this stream stays open.
          const next = JSON.stringify(store.privateBots());
          if (next !== hidden) { redact = await redactAgents(store, roster, signedIn(req).id); hidden = next; }
          if (next !== JSON.stringify(store.privateBots())) { changed(); return; }
          const value = runtime.inflight?.(botId);
          // A structural read is already pending when its snapshot was invalidated.
          if (!value || !redact) return;
          stream?.send(`event: inflight\ndata: ${JSON.stringify({ ...value, message: redact.message(value.message), toolCalls: value.toolCalls.map(redact.call) })}\n\n`);
        })().catch(() => changed());
      }, Math.max(0, liveLast + 250 - Date.now()));
    };
    const listeners = watchers.get(botId) ?? new Set();
    let unwatch: (() => void) | undefined;
    const teardown = () => {
      unwatch?.();
      listeners.delete(changed);
      if (!listeners.size && watchers.get(botId) === listeners) watchers.delete(botId);
      clearTimeout(pending);
      clearTimeout(livePending);
    };
    try {
      watchers.set(botId, listeners.add(changed));
      unwatch = runtime.watch?.(botId, notice);
      stream = connection.open(streams, {
        // Ends, sending nothing more, once the person signs out or the assistant becomes someone else's.
        allowed: () => stillSignedIn(store, config, req) && visibleTo(store, botId, req.user?.id),
        teardown,
      });
    } catch (error) {
      teardown();
      throw error;
    }
  });
  const message = z
    .object({
      requestId: z.string().uuid(),
      text: z.string().max(50000),
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
  const submit = async (req: ApiRequest<"POST /bots/:id/messages" | "POST /bots/:id/steer">, body: z.output<typeof message>, explicitSteering = false): Promise<SubmissionReceipt> => {
    const { reviewedInterruption, reviewedUncertain, ...message } = body;
    if (message.retryOf !== undefined && explicitSteering) throw httpError(400, "Retry a message by sending it, not by steering");
    const input: Submission = {
      ...message,
      botId: req.params.id,
      senderId: signedIn(req).id,
    };
    const previous = store.submission(input.requestId);
    const interruptionRejected = previous?.reason === "interruption_pending";
    const retryInterruption = interruptionRejected && reviewedInterruption;
    if (previous) {
      // Every device derives one ID for retrying a failed turn, so another person, or a client
      // that copied the text differently, follows the request already recorded.
      if (input.retryOf !== undefined && previous.input.retryOf === input.retryOf && previous.input.botId === input.botId
        && JSON.stringify(previous.input) !== JSON.stringify(input))
        return previous.receipt;
      if (JSON.stringify(previous.input) !== JSON.stringify(input))
        throw httpError(
          409,
          "This submission ID was already used for different content",
        );
      if (interruptionRejected && !reviewedInterruption)
        throw httpError(409, interruptionPendingMessage);
      if (!retryInterruption && (!reviewedUncertain || previous.receipt.status !== "uncertain"))
        return previous.receipt;
      await requireCapability("idempotency");
      const known = await runtime.lookupSubmission(input.requestId);
      if (known) {
        store.receipt(known);
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
      store.participate(conversation.activity.runId, input.senderId);
    try {
      const receipt = await (steering
        ? runtime.steer({ ...input, reviewedInterruption })
        : runtime.submit({ ...input, reviewedInterruption }));
      store.receipt(receipt);
      if (receipt.runId) store.participate(receipt.runId, input.senderId);
      return receipt;
    } catch (error) {
      if ((error as { code?: string }).code === "interruption_pending") {
        store.receipt({ requestId: input.requestId, status: "rejected", message: interruptionPendingMessage }, "interruption_pending");
        throw httpError(409, interruptionPendingMessage);
      }
      return store.submission(input.requestId)!.receipt;
    }
  };
  apiRoute(app, "POST /bots/:id/messages", { body: message }, async (req, body) => submit(req, body));
  apiRoute(app, "POST /bots/:id/steer", { body: message }, async (req, body) => submit(req, body, true));
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
    try {
      if ((await runtime.capabilities()).idempotency.supported) {
        const receipt = await runtime.lookupSubmission(requestId);
        if (receipt) {
          if (previous) store.receipt(receipt);
          return receipt;
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
      previous?.receipt ?? {
        requestId,
        status: "uncertain",
        message:
          "Admission cannot be verified while Hermes is unavailable. This message will not be automatically resent.",
      }
    );
  });
  const answers = z.object({ answers: z.record(z.string().max(200), z.string().max(10000)) });
  apiRoute(app, "POST /bots/:id/requests/:approvalId", { body: answers }, async (req, { answers }) => {
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
    await runtime.answerRequest(p.id, p.approvalId, answers);
    if (conversation.activity.runId)
      store.participate(conversation.activity.runId, signedIn(req).id);
    return { ok: true };
  });
  apiRoute(app, "POST /bots/:id/stop", {}, async req => {
    await requireCapability("stop");
    await runtime.stop(req.params.id);
    return { ok: true };
  });
  const decision = z.object({ decision: z.enum(["approved", "denied"]), account: z.string().max(64).optional() });
  apiRoute(app, "POST /bots/:id/approvals/:approvalId", { before: () => requireCapability("approvals"), body: decision },
    async (req, { decision, account }) => {
    const p = req.params;
    // An iOS notification action names the account it was sent to. Another person signed in on that phone must not decide it.
    if (account !== undefined && account !== accountMarker(signedIn(req).id))
      throw httpError(409, "This approval was sent to a different account");
    await decideApproval(runtime, store, p.id, p.approvalId, decision, signedIn(req).id);
    return { ok: true };
  });
  apiRoute(app, "GET /bots/:id/draft", {}, async req => store.draft(signedIn(req).id, req.params.id));
  const draft = z.object({ text: z.string().max(50000), attachments: z.array(fileRef).max(MAX_ATTACHMENTS).default([]), baseRevision: z.number().int().min(0).optional() });
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
}
