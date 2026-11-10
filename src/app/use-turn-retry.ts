import { useRef, useState } from "react";
import type { Message, SubmissionReceipt } from "../shared/types";
import type { MessageRequest } from "../shared/api";
import { retryRequestId } from "../shared/retry-id";
import { ApiError } from "../client-api";
import type { SavedConversation } from "./storage";
import { retryTarget } from "./transcript-logic";
import { sendMessage } from "./conversation-page";
import { useReceiptCheck } from "./use-receipt-check";

/** What this view knows about the retry of one failed turn. */
type Attempt = {
  state: "sending" | "checking" | "settled";
  /** The request followed: this turn's own ID, or the one that claimed the turn first. */
  requestId?: string;
  /** The receipt that settled it. */
  receipt?: SubmissionReceipt;
};
const refused = "Hermes didn't take the retry.";

/**
 * Retry for a failed turn: resends the person's latest message as a request naming it. Every
 * device, tab and reload derives the same request ID for the same failed turn, and the server
 * admits one retry per failed turn, so a lost response, a second tab or another person can never
 * run it twice. The server's record of a retry, from the conversation or a receipt, settles
 * Retry; one whose outcome is unknown is checked by its ID until a receipt settles it or the
 * conversation moves on. A refused retry stays refused, so `refusal` explains it from the
 * server's record on every device and reload. The composer's draft and submission are never
 * read or changed here.
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
  const target = canonical?.botId === botId && !blocked ? retryTarget(canonical.messages, canonical.activity.state) : undefined;
  const runId = canonical?.activity.runId ?? "";
  const turn = target ? [userId ?? "", botId, target.id, runId].join("\u0000") : undefined;
  // Each failed turn, by person, assistant, message and run, keeps its own attempt, so a slow
  // retry of one assistant's turn never blocks or settles another's.
  const [attempts, setAttempts] = useState<ReadonlyMap<string, Attempt>>(() => new Map());
  const record = (forTurn: string, attempt: Attempt | null) => setAttempts(previous => {
    const next = new Map(previous);
    if (attempt) next.set(forTurn, attempt); else next.delete(forTurn);
    return next;
  });
  // Messages about a turn no longer on screen, such as another assistant's, aren't shown.
  const turnRef = useRef(turn);
  turnRef.current = turn;
  const reportRef = useRef(report);
  reportRef.current = report;
  const sending = useRef(new Set<string>());
  const local = turn ? attempts.get(turn) : undefined;
  // Anyone's retry of this failure, as the server recorded it.
  const claim = target && canonical?.retry?.retryOf === target.id ? canonical.retry : undefined;
  const settled = local?.state === "settled" || !!claim && claim.status !== "uncertain";
  const checking = !settled && local?.state !== "sending" && (local?.state === "checking" || claim?.status === "uncertain");
  const followed = local?.requestId ?? claim?.requestId;
  // A refused retry keeps its ID, which Hermes refuses again, so the message box sends it anew.
  const outcome = local?.state === "settled" ? local.receipt : claim;
  const refusal = target && outcome && (outcome.status === "rejected" || outcome.status === "interrupted")
    ? { text: outcome.message ? `${refused} ${outcome.message}` : refused, message: target } : undefined;
  const settle = (forTurn: string, result: SubmissionReceipt) => record(forTurn, result.status === "uncertain"
    ? { state: "checking", requestId: result.requestId }
    : { state: "settled", requestId: result.requestId, receipt: result });
  // Checked by its ID, never sent as a new request, until a receipt settles it or the turn changes.
  useReceiptCheck(checking && turn ? followed : undefined, result => settle(turn!, result), turn);
  const run = async (original: Message) => {
    if (!turn || sending.current.has(turn) || checking && !resendable) return;
    const forTurn = turn, again = checking;
    sending.current.add(forTurn);
    record(forTurn, { state: "sending", requestId: followed });
    let requestId = followed;
    try {
      requestId ??= await retryRequestId(botId, original.id, runId);
      // `retryOf` names the message, and a retry never carries a draft revision.
      const body: MessageRequest = { requestId, text: original.text, attachments: original.files ?? [], retryOf: original.id,
        ...(again ? { reviewedUncertain: true } : {}) };
      settle(forTurn, await sendMessage(botId, body));
    } catch (cause) {
      const shown = turnRef.current === forTurn;
      // Only a first attempt the server refused outright never reached Hermes. Anything else may
      // have, so it is checked by its ID.
      if (!again && (!requestId || cause instanceof ApiError && cause.status < 500)) {
        record(forTurn, null);
        if (shown) reportRef.current(cause instanceof Error ? cause.message : "Hermes didn't take the retry. Try again in a moment.");
      } else {
        record(forTurn, { state: "checking", requestId });
        if (shown) reportRef.current(resendable
          ? "Hermes hasn't confirmed the retry yet. It's being checked; Retry sends the same request again, so it can't run twice."
          : "Hermes hasn't confirmed the retry yet. It's being checked and won't be sent again. If it never arrives, send the message again from the message box.");
      }
    } finally {
      sending.current.delete(forTurn);
    }
  };
  return { message: settled ? undefined : target, refusal, busy: local?.state === "sending", checking, resendable, run };
}
