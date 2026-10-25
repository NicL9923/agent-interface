import { useEffect, useRef, useState } from "react";
import type { FileRef, Message, SubmissionReceipt } from "../shared/types";
import type { MessageRequest } from "../shared/api";
import { ApiError, request as apiRequest } from "../client-api";
import { localRead, localRemove, localSave, retryKey } from "./storage";
import type { SavedConversation } from "./storage";
import { retryTarget } from "./transcript-logic";

/**
 * A retry of a failed turn, saved before it is sent and kept under its request ID until Hermes's
 * receipt settles it. It lives apart from the composer's draft and submission, which it never
 * reads or changes.
 */
export type RetrySubmission = {
  requestId: string;
  botId: string;
  text: string;
  attachments: FileRef[];
  /** The user message it retries. */
  retryOf: string;
  /** The failed run it retried, so Retry stays hidden for that run once Hermes accepts. */
  runId?: string;
};

/**
 * Retry for a failed turn: resends the person's latest message as a new request naming it. A
 * request whose outcome is unknown, such as after a lost response, stays saved through navigation
 * and reloads and is checked by its ID until a receipt settles it. Retrying it again sends the same
 * request, so a delayed original and the retry can never run the turn twice.
 */
export function useTurnRetry({ botId, userId, canonical, blocked, resendable, report }: {
  botId: string;
  userId?: string;
  canonical: SavedConversation | null;
  blocked: boolean;
  /** Hermes can look up a request by its ID, which sending the same request again relies on. */
  resendable: boolean;
  report(message: string): void;
}) {
  const key = userId && botId ? retryKey(userId, botId) : undefined;
  const [saved, setSaved] = useState<RetrySubmission | null>(null);
  const [sending, setSending] = useState(false);
  const [retried, setRetried] = useState<{ messageId: string; runId?: string } | null>(null);
  // State belongs to the person and assistant on screen; work for another one only updates storage.
  const keyRef = useRef(key);
  keyRef.current = key;
  const reportRef = useRef(report);
  reportRef.current = report;
  useEffect(() => {
    setSaved(key ? localRead<RetrySubmission>(key) : null);
    setSending(false);
    setRetried(null);
  }, [key]);
  // Forgets a retry only while storage still holds this one, never a newer retry saved since.
  const forget = (storageKey: string, request: RetrySubmission) => {
    if (localRead<RetrySubmission>(storageKey)?.requestId === request.requestId) localRemove(storageKey);
    if (keyRef.current === storageKey) setSaved(current => current?.requestId === request.requestId ? null : current);
  };
  const settle = (storageKey: string, request: RetrySubmission, result: SubmissionReceipt | null) => {
    if (result?.status === "accepted") {
      forget(storageKey, request);
      if (keyRef.current === storageKey) setRetried({ messageId: request.retryOf, runId: request.runId });
    } else if (result?.status === "rejected" || result?.status === "interrupted") {
      forget(storageKey, request);
      if (keyRef.current === storageKey) reportRef.current(result.message || "Hermes didn't take the retry. Try again in a moment.");
    }
  };
  // An unsettled retry is checked by its ID, never sent as a new one, until a receipt settles it.
  useEffect(() => {
    if (!saved || sending || !key) return;
    let live = true, loading = false;
    const check = async () => {
      if (loading || navigator.onLine === false || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const result = await apiRequest("GET /submissions/:id", { params: { id: saved.requestId } });
        if (live) settle(key, saved, result);
      } catch {
        /* It stays saved until a reliable receipt. */
      } finally { loading = false; }
    };
    void check();
    const timer = setInterval(() => void check(), 2000);
    return () => { live = false; clearInterval(timer); };
  }, [saved, sending, key]);
  const target = canonical?.botId === botId && !blocked ? retryTarget(canonical.messages, canonical.activity.state) : undefined;
  const runId = canonical?.activity.runId;
  const message = target && !(retried?.messageId === target.id && retried.runId === runId) ? target : undefined;
  // The saved retry of this message, still waiting for its receipt.
  const unsettled = message && saved?.retryOf === message.id ? saved : null;
  const run = async (original: Message) => {
    if (!key || sending) return;
    const previous = saved?.retryOf === original.id ? saved : null;
    if (previous && !resendable) return;
    const storageKey = key;
    const request: RetrySubmission = previous ?? {
      requestId: crypto.randomUUID(), botId, text: original.text, attachments: original.files ?? [], retryOf: original.id, runId,
    };
    // Saved before it is sent, so a lost response or a reload still knows its ID.
    if (!previous) localSave(storageKey, request);
    setSaved(request);
    setSending(true);
    // `retryOf` names the message, and a retry never carries a draft revision.
    const body: MessageRequest = { requestId: request.requestId, text: request.text, attachments: request.attachments, retryOf: request.retryOf,
      ...(previous ? { reviewedUncertain: true } : {}) };
    try {
      settle(storageKey, request, await apiRequest("POST /bots/:id/messages", { params: { id: request.botId }, body }));
    } catch (cause) {
      // Only a first attempt the server refused outright never reached Hermes. Anything else may
      // have, so its ID stays saved and is checked.
      if (!previous && cause instanceof ApiError && cause.status < 500) {
        forget(storageKey, request);
        if (keyRef.current === storageKey) reportRef.current(cause.message);
      } else if (keyRef.current === storageKey) {
        reportRef.current("Hermes hasn't confirmed the retry yet. It's being checked; Retry sends the same request again.");
      }
    } finally {
      if (keyRef.current === storageKey) setSending(false);
    }
  };
  return { message, busy: sending, checking: !!unsettled && !sending, resendable, run };
}
