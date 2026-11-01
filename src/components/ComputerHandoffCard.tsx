import { useEffect, useRef, useState } from "react";
import { ApiError, api, write } from "../client-api";
import type { ComputerHandoff, ComputerHandoffResult, ComputerStatus } from "../shared/computer";
import { rememberSettled } from "../app/waiting-input";
import { attentionAnchor } from "../app/transcript-logic";
import { Icon } from "./Icon";
import { FormMessage } from "./ui/form-message";
import { SettledReceipt } from "./SecureRequestCard";
import "./handoff.css";

/** Opens the computer view, taking control in the same step when `take` is set. App.tsx listens. */
export function openComputer(take = false) {
  window.dispatchEvent(new CustomEvent("wildbots:computer", { detail: { take } }));
}

/** Tools that act on the household computer, as src/hermes/computer.py brackets them. */
export const usesComputer = (name?: string) => !!name && (name === "computer_use" || name.startsWith("browser_"));

/**
 * An assistant asks a person to take over the household computer. Take over opens the computer
 * and takes control; handing it back answers the request. Not now declines it, and a chat
 * message closes it so the assistant reads that message instead.
 */
export function ComputerHandoffCard({ handoff, requestId, botId, assistantName, disconnected }: {
  handoff: ComputerHandoff; requestId: string; botId: string; assistantName?: string; disconnected: boolean;
}) {
  const name = assistantName || "The assistant";
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [declining, setDeclining] = useState(false);
  const [accepted, setAccepted] = useState<string | null>(null);
  const [error, setError] = useState("");
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const next = await api<ComputerStatus>("/computer", { signal: controller.signal });
        if (!controller.signal.aborted) setStatus(next);
      } catch { /* The card keeps its last known status; Take over still opens the computer view. */ }
    };
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 4000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  const control = status?.control;
  const mine = control?.kind === "human" && !!control.mine;
  const elsewhere = control?.kind === "human" && !control.mine;
  const unavailable = status && (!status.available || !status.running);
  async function decline() {
    if (declining || accepted) return;
    setDeclining(true); setError("");
    try {
      const result = await write<ComputerHandoffResult>(`/bots/${encodeURIComponent(botId)}/computer-handoffs/${encodeURIComponent(requestId)}`,
        { decision: "decline", epoch: handoff.epoch, sessionId: handoff.sessionId });
      if (!live.current) return;
      if (result.status === "expired") setError("This request had already closed. Refresh the conversation to see what happened.");
      else {
        const text = `You chose Not now. ${name} will continue without it.`;
        setAccepted(text);
        rememberSettled(botId, requestId, text);
      }
    } catch (cause) {
      if (live.current) setError(cause instanceof ApiError && cause.status < 500 ? cause.message : "Couldn't reach Hermes. Try Not now again.");
    } finally { if (live.current) setDeclining(false); }
  }
  if (accepted) return <SettledReceipt requestId={requestId} text={accepted} />;
  return <article className="approval-card computer-handoff" data-request-id={requestId} {...attentionAnchor("computer", requestId)}>
    <p className="eyebrow"><Icon name="computer" size={16} />Household computer</p>
    <h2>{name} needs you on the computer</h2>
    <dl className="handoff-ask">
      <dt>Why</dt><dd>{handoff.reason}</dd>
      <dt>What to do</dt><dd>{handoff.whatToDo}</dd>
    </dl>
    <p className="muted handoff-source">In {name}'s words. {name} pauses its computer actions while you have control.</p>
    {mine ? <p className="handoff-state" role="status">You have control. Press Hand back in the computer view when you're done, and {name} will continue.</p>
      : elsewhere ? <p className="handoff-state" role="status">{control?.name || "Another household member"} has control right now. Take over is available after they hand back.</p>
      : unavailable ? <p className="handoff-state" role="status">{status?.reason || "The household computer isn't running right now."}</p>
      : null}
    <div className="actions">
      <button type="button" className="primary with-progress" disabled={disconnected || declining || elsewhere || !!unavailable}
        onClick={() => openComputer(!mine)}><Icon name="computer" size={16} />{mine ? "Open computer" : "Take over"}</button>
      {!mine && <button type="button" className="with-progress" disabled={disconnected || declining} onClick={() => void decline()}>
        {declining && <Icon name="spinner" className="spin" size={16} />}{declining ? "Sending…" : "Not now"}</button>}
    </div>
    <p className="muted secure-reply-hint">Or send a message instead. That cancels this request so {name} can read it.</p>
    {error && <FormMessage tone="error">{error}</FormMessage>}
  </article>;
}
