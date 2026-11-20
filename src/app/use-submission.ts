import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { SubmissionReceipt } from "../shared/types";
import { ApiError, request as apiRequest } from "../client-api";
import {
  clearSavedDraft,
  draftKey,
  localRead,
  localRemove,
  localSave,
  sentCopy,
  submissionKey,
} from "./storage";
import type { Draft, Pending } from "./storage";
import { answerStaleMessage } from "../shared/errors";
import { contentHash } from "./draft-merge";
import { restoreSent } from "./sent-echo";
/**
 * Whether Hermes refused the message, or settled it without the assistant ever getting it: a typed stop phrase
 * that ended Hermes's voice chat is accepted with `turn: "none"`. Either way its words go back into the draft.
 */
const notTaken = (receipt: SubmissionReceipt) =>
  receipt.status === "rejected" ||
  receipt.status === "interrupted" ||
  (receipt.status === "accepted" && receipt.turn === "none");
// A submission whose outcome is unknown stays pending (and blocks sending) until Hermes confirms it.
export function useSubmission({
  botId,
  userId,
  identityEpoch,
  draft,
  setDraft,
  draftReady,
  reviewed,
  connectionLost,
  setError,
  onAnswerStale,
}: {
  botId: string;
  userId?: string;
  identityEpoch: RefObject<number>;
  draft: Draft;
  setDraft: (update: (current: Draft) => Draft) => void;
  draftReady: boolean;
  reviewed: boolean;
  connectionLost: boolean;
  setError: (message: string) => void;
  /** The server refused a reaction because the chat moved on; the conversation should be read again. */
  onAnswerStale?: () => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null);
  const [inFlight, setInFlight] = useState<Record<string, string>>({});
  const sending = !!inFlight[botId];
  const start = (request: Pending) =>
    setInFlight((current) => ({ ...current, [request.botId]: request.requestId }));
  const finish = (request: Pending) =>
    setInFlight((current) => {
      if (current[request.botId] !== request.requestId) return current;
      const next = { ...current };
      delete next[request.botId];
      return next;
    });
  const activeBotRef = useRef(botId);
  activeBotRef.current = botId;
  const clearSent = (user: string, request: Pending) =>
    setDraft((current) =>
      current.botId === request.botId && current.userId === user
        ? sentCopy(current, request)
        : current,
    );
  // Until the server shows the send, a save of the sent text from this copy is not new work.
  const markSent = (user: string, request: Pending, sent: boolean) => {
    // The copy's edit sequence identifies it as the sent copy until someone types in it again.
    const mark = (copy: Draft) =>
      sent
        ? {
            sentHash: contentHash(request),
            sentBase: request.draftBaseRevision ?? 0,
            sentSeq: copy.seq ?? 0,
          }
        : { sentHash: undefined, sentBase: undefined };
    const key = draftKey(user, request.botId);
    const saved = localRead<Draft>(key);
    if (saved) localSave(key, { ...saved, ...mark(saved) });
    setDraft((current) =>
      current.botId === request.botId && current.userId === user
        ? { ...current, ...mark(current) }
        : current,
    );
  };
  // A refused message goes back into its draft, in front of anything that replaced it meanwhile. A
  // reaction never came from the draft, so it never goes into it.
  const refused = (user: string, request: Pending) => {
    if (request.answering !== undefined) return;
    markSent(user, request, false);
    const key = draftKey(user, request.botId);
    const saved = localRead<Draft>(key);
    if (saved) localSave(key, restoreSent(saved, request));
    setDraft((current) =>
      current.botId === request.botId && current.userId === user
        ? restoreSent(current, request)
        : current,
    );
  };
  useEffect(() => {
    setReceipt(null);
    if (!botId || !userId) {
      setPending(null);
      return;
    }
    setPending(localRead<Pending>(submissionKey(userId, botId)));
  }, [botId, userId]);
  useEffect(() => {
    if (!pending || pending.botId !== botId || !userId || sending) return;
    let live = true;
    let loading = false;
    const epoch = identityEpoch.current;
    const key = submissionKey(userId, pending.botId);
    const reconcile = async () => {
      if (loading || navigator.onLine === false || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const result = await apiRequest("GET /submissions/:id", {
          params: { id: pending.requestId },
        });
        if (!live || epoch !== identityEpoch.current) return;
        setReceipt(result);
        if (notTaken(result)) {
          refused(userId, pending);
          setPending(null);
          localRemove(key);
        } else if (result.status === "accepted") {
          if (pending.answering === undefined) {
            clearSavedDraft(userId, pending);
            clearSent(userId, pending);
          }
          setPending(null);
          localRemove(key);
        }
      } catch {
        /* Unknown submission stays pending until a reliable reconciliation. */
      } finally {
        loading = false;
      }
    };
    void reconcile();
    const timer = setInterval(() => void reconcile(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pending, userId, botId, sending]);
  // The server refused a reaction because its reply no longer ends the chat: nothing was sent, so the
  // send is forgotten, the draft is left alone, and the chat is read again to show where it went.
  const stale = (request: Pending, cause: unknown) => {
    if (!(cause instanceof ApiError) || cause.code !== "answer_stale" || !userId) return false;
    if (activeBotRef.current === request.botId) {
      setPending(null);
      setReceipt(null);
      setError(answerStaleMessage);
    }
    localRemove(submissionKey(userId, request.botId));
    onAnswerStale?.();
    return true;
  };
  /**
   * Sends the draft. `onStart` hears the request once it is on its way, such as to anchor the view to it.
   * With `answer`, sends that reaction to the reply `answering` names instead. Like a retry, it never
   * reads, merges, clears or restores the draft, whether it is accepted, refused, retried or discarded.
   */
  const send = async (
    onStart?: (request: Pending) => void,
    answer?: { text: string; answering: string },
  ) => {
    const fromDraft = answer === undefined;
    if (
      !userId ||
      connectionLost ||
      pending ||
      sending ||
      !botId ||
      (fromDraft && (!draftReady || draft.botId !== botId || draft.userId !== userId))
    )
      return;
    setError("");
    const epoch = identityEpoch.current;
    const request: Pending = fromDraft
      ? {
          requestId: crypto.randomUUID(),
          botId,
          text: draft.text,
          attachments: draft.attachments,
          reviewedInterruption: reviewed,
          draftBaseRevision: draft.baseRevision ?? 0,
        }
      : {
          requestId: crypto.randomUUID(),
          botId,
          text: answer.text,
          attachments: [],
          reviewedInterruption: reviewed,
          answering: answer.answering,
        };
    localSave(submissionKey(userId, botId), request);
    // The draft is the sent copy only when it is what was sent.
    if (fromDraft) markSent(userId, request, true);
    setPending(request);
    start(request);
    onStart?.(request);
    try {
      const result = await apiRequest("POST /bots/:id/messages", {
        params: { id: botId },
        body: request,
      });
      if (epoch !== identityEpoch.current) return;
      if (activeBotRef.current === request.botId) setReceipt(result);
      if (notTaken(result)) {
        refused(userId, request);
        if (activeBotRef.current === request.botId) setPending(null);
        localRemove(submissionKey(userId, request.botId));
      } else if (result.status === "accepted") {
        if (fromDraft) {
          clearSavedDraft(userId, request);
          clearSent(userId, request);
        }
        if (activeBotRef.current === request.botId) setPending(null);
        localRemove(submissionKey(userId, request.botId));
      }
    } catch (e) {
      if (epoch !== identityEpoch.current) return;
      if (stale(request, e)) return;
      if (e instanceof ApiError && e.status < 500) {
        refused(userId, request);
        if (activeBotRef.current === request.botId) setPending(null);
        localRemove(submissionKey(userId, request.botId));
      }
      if (activeBotRef.current === request.botId) setError((e as Error).message);
    } finally {
      if (epoch === identityEpoch.current) finish(request);
    }
  };
  const retry = () => {
    if (!pending || sending) return;
    const request = pending;
    const epoch = identityEpoch.current;
    const requestBot = pending.botId;
    const current = () => epoch === identityEpoch.current && activeBotRef.current === requestBot;
    start(request);
    void apiRequest("POST /bots/:id/messages", {
      params: { id: pending.botId },
      body: { ...pending, reviewedUncertain: true },
    })
      .then((result) => {
        if (current()) setReceipt(result);
      })
      .catch((e) => {
        if (epoch !== identityEpoch.current || stale(request, e)) return;
        if (current()) setError(e.message);
      })
      .finally(() => {
        if (epoch === identityEpoch.current) finish(request);
      });
  };
  // Gives up on checking an unconfirmed send, as the native client can: its text and files go back
  // into the draft, no longer marked as sent. The message may still arrive.
  const discard = () => {
    if (!pending || sending || !userId) return;
    refused(userId, pending);
    setPending(null);
    setReceipt(null);
    localRemove(submissionKey(userId, pending.botId));
  };
  const reset = () => {
    setInFlight({});
    setPending(null);
    setReceipt(null);
  };
  return { pending, receipt, sending, send, retry, discard, reset };
}
