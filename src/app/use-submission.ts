import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { SubmissionReceipt } from "../shared/types";
import { ApiError, request as apiRequest } from "../client-api";
import { clearSavedDraft, draftKey, localRead, localRemove, localSave, sentCopy, submissionKey } from "./storage";
import type { Draft, Pending } from "./storage";
import { contentHash } from "./draft-merge";
import { restoreSent } from "./sent-echo";
// A submission whose outcome is unknown stays pending (and blocks sending) until Hermes confirms it.
export function useSubmission({ botId, userId, identityEpoch, draft, setDraft, draftReady, reviewed, connectionLost, setError }: {
  botId: string;
  userId?: string;
  identityEpoch: RefObject<number>;
  draft: Draft;
  setDraft(update: (current: Draft) => Draft): void;
  draftReady: boolean;
  reviewed: boolean;
  connectionLost: boolean;
  setError(message: string): void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null);
  const [sending, setSending] = useState(false);
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
    const mark = (copy: Draft) => sent
      ? { sentHash: contentHash(request), sentBase: request.draftBaseRevision ?? 0, sentSeq: copy.seq ?? 0 }
      : { sentHash: undefined, sentBase: undefined };
    const key = draftKey(user, request.botId);
    const saved = localRead<Draft>(key);
    if (saved) localSave(key, { ...saved, ...mark(saved) });
    setDraft(current => current.botId === request.botId && current.userId === user ? { ...current, ...mark(current) } : current);
  };
  // A refused message goes back into its draft, in front of anything that replaced it meanwhile.
  const refused = (user: string, request: Pending) => {
    markSent(user, request, false);
    const key = draftKey(user, request.botId);
    const saved = localRead<Draft>(key);
    if (saved) localSave(key, restoreSent(saved, request));
    setDraft(current => current.botId === request.botId && current.userId === user ? restoreSent(current, request) : current);
  };
  useEffect(() => {
    if (!botId || !userId) return;
    setReceipt(null);
    setPending(localRead<Pending>(submissionKey(userId, botId)));
  }, [botId, userId]);
  useEffect(() => {
    if (!pending || !userId || sending) return;
    let live = true;
    let loading = false;
    const epoch = identityEpoch.current;
    const key = submissionKey(userId, pending.botId);
    const reconcile = async () => {
      if (loading || navigator.onLine === false || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const result = await apiRequest("GET /submissions/:id", { params: { id: pending.requestId } });
        if (!live || epoch !== identityEpoch.current) return;
        setReceipt(result);
        if (result.status === "accepted") {
          clearSavedDraft(userId, pending);
          setPending(null);
          localRemove(key);
          clearSent(userId, pending);
        } else if (
          result.status === "rejected" ||
          result.status === "interrupted"
        ) {
          refused(userId, pending);
          setPending(null);
          localRemove(key);
        }
      } catch {
        /* Unknown submission stays pending until a reliable reconciliation. */
      } finally { loading = false; }
    };
    void reconcile();
    const timer = setInterval(() => void reconcile(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pending, userId, sending]);
  /** `onStart` hears the request once it is on its way, such as to anchor the view to it. */
  const send = async (onStart?: (request: Pending) => void) => {
    if (
      !userId ||
      connectionLost ||
      pending ||
      sending ||
      !draftReady ||
      !botId ||
      draft.botId !== botId ||
      draft.userId !== userId
    )
      return;
    setError("");
    const epoch = identityEpoch.current;
    const request: Pending = {
      requestId: crypto.randomUUID(),
      botId,
      text: draft.text,
      attachments: draft.attachments,
      reviewedInterruption: reviewed,
      draftBaseRevision: draft.baseRevision ?? 0,
    };
    localSave(submissionKey(userId, botId), request);
    markSent(userId, request, true);
    setPending(request);
    setSending(true);
    onStart?.(request);
    try {
      const result = await apiRequest("POST /bots/:id/messages", { params: { id: botId }, body: request });
      if (epoch !== identityEpoch.current) return;
      if (activeBotRef.current === request.botId) setReceipt(result);
      if (result.status === "accepted") {
        clearSavedDraft(userId, request);
        clearSent(userId, request);
        if (activeBotRef.current === request.botId) setPending(null);
        localRemove(submissionKey(userId, request.botId));
      } else if (
        result.status === "rejected" ||
        result.status === "interrupted"
      ) {
        refused(userId, request);
        if (activeBotRef.current === request.botId) setPending(null);
        localRemove(submissionKey(userId, request.botId));
      }
    } catch (e) {
      if (epoch !== identityEpoch.current) return;
      if (e instanceof ApiError && e.status < 500) {
        refused(userId, request);
        if (activeBotRef.current === request.botId) setPending(null);
        localRemove(submissionKey(userId, request.botId));
      }
      setError((e as Error).message);
    } finally {
      if (epoch === identityEpoch.current) setSending(false);
    }
  };
  const retry = () => {
    if (!pending) return;
    const epoch = identityEpoch.current;
    const requestBot = pending.botId;
    const current = () => epoch === identityEpoch.current &&
      activeBotRef.current === requestBot;
    setSending(true);
    void apiRequest("POST /bots/:id/messages", { params: { id: pending.botId }, body: { ...pending, reviewedUncertain: true } })
      .then((result) => { if (current()) setReceipt(result); })
      .catch((e) => { if (current()) setError(e.message); })
      .finally(() => {
        if (epoch === identityEpoch.current) setSending(false);
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
    setSending(false); setPending(null); setReceipt(null);
  };
  return { pending, receipt, sending, send, retry, discard, reset };
}
