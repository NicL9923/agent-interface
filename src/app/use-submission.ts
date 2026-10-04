import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { SubmissionReceipt } from "../shared/types";
import { api, ApiError, write } from "../client-api";
import { clearSavedDraft, localRead, localRemove, localSave, sameDraft, submissionKey } from "./storage";
import type { Draft, Pending } from "./storage";
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
      current.botId === request.botId &&
      current.userId === user &&
      sameDraft(current, request)
        ? {
            text: "",
            attachments: [],
            botId: current.botId,
            userId: current.userId,
          }
        : current,
    );
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
        const result = await api<SubmissionReceipt>(
          `/submissions/${pending.requestId}`,
        );
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
  const send = async () => {
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
    };
    localSave(submissionKey(userId, botId), request);
    setPending(request);
    setSending(true);
    try {
      const result = await write<SubmissionReceipt>(
        `/bots/${encodeURIComponent(botId)}/messages`,
        request,
      );
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
        if (activeBotRef.current === request.botId) setPending(null);
        localRemove(submissionKey(userId, request.botId));
      }
    } catch (e) {
      if (epoch !== identityEpoch.current) return;
      if (e instanceof ApiError && e.status < 500) {
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
    void write<SubmissionReceipt>(
      `/bots/${encodeURIComponent(pending.botId)}/messages`,
      { ...pending, reviewedUncertain: true },
    )
      .then((result) => { if (current()) setReceipt(result); })
      .catch((e) => { if (current()) setError(e.message); })
      .finally(() => {
        if (epoch === identityEpoch.current) setSending(false);
      });
  };
  const reset = () => {
    setSending(false); setPending(null); setReceipt(null);
  };
  return { pending, receipt, sending, send, retry, reset };
}
