import { useEffect, useRef, useState } from "react";
import { ApiError, api, write } from "../client-api";
import type { ComputerStatus, TerminalRequest, TerminalRequestDecision, TerminalRequestResult } from "../shared/computer";
import { rememberSettled } from "../app/waiting-input";
import { attentionAnchor } from "../app/transcript-logic";
import { Icon } from "./Icon";
import { FormMessage } from "./ui/form-message";
import { SettledReceipt } from "./SecureRequestCard";
import "./handoff.css";

/** Opens the computer view on its Terminal tab. With a command, the shell offers to paste it at the prompt. App.tsx listens. */
export function openTerminal(command?: string) {
  window.dispatchEvent(new CustomEvent("wildbots:computer", { detail: { terminal: { ...(command ? { command } : {}) } } }));
}

/**
 * An assistant asks a person to do a step in the system terminal. Open terminal opens the shell and
 * offers the suggested command for the person to paste at the prompt; it never runs it. Done tells the assistant the
 * person finished, Not now declines, and a chat message closes the request so the assistant reads
 * that message instead.
 */
export function TerminalRequestCard({ request, requestId, botId, assistantName, disconnected }: {
  request: TerminalRequest; requestId: string; botId: string; assistantName?: string; disconnected: boolean;
}) {
  const name = assistantName || "The assistant";
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [sending, setSending] = useState<TerminalRequestDecision | null>(null);
  const [settled, setSettled] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const live = useRef(true);
  // Set in the effect too: StrictMode runs cleanup and setup again on mount.
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const next = await api<ComputerStatus>("/computer", { signal: controller.signal });
        if (!controller.signal.aborted) setStatus(next);
      } catch { /* The card keeps its last known status; the server still checks every button. */ }
    };
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 4000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  // Until the status loads the buttons stay usable; the server refuses anyone who may not use the terminal.
  const blocked = status && !status.terminal.available
    ? status.terminal.reason || "The system terminal isn't available right now." : null;

  async function settle(decision: TerminalRequestDecision) {
    if (sending || settled) return;
    setSending(decision); setError("");
    try {
      const result = await write<TerminalRequestResult>(`/bots/${encodeURIComponent(botId)}/terminal-requests/${encodeURIComponent(requestId)}`,
        { decision, epoch: request.epoch, sessionId: request.sessionId });
      if (!live.current) return;
      if (result.status === "expired") setError("This request had already closed. Refresh the conversation to see what happened.");
      else {
        const text = decision === "done" ? `Marked done. ${name} will check the result.` : `You chose Not now. ${name} will continue without it.`;
        setSettled(text);
        rememberSettled(botId, requestId, text);
      }
    } catch (cause) {
      if (live.current) setError(cause instanceof ApiError && cause.status < 500 ? cause.message
        : `Couldn't reach Hermes. Try ${decision === "done" ? "Done" : "Not now"} again.`);
    } finally { if (live.current) setSending(null); }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(request.command!); setCopied(true); setTimeout(() => { if (live.current) setCopied(false); }, 2000); }
    catch { setError("Couldn't copy. Select the command and copy it yourself."); }
  }

  if (settled) return <SettledReceipt requestId={requestId} text={settled} />;
  return <article className="approval-card computer-handoff" data-request-id={requestId} {...attentionAnchor("terminal", requestId)}>
    <p className="eyebrow"><Icon name="terminal" size={16} />System terminal</p>
    <h2>{name} needs you in the terminal</h2>
    <dl className="handoff-ask">
      <dt>Why</dt><dd>{request.reason}</dd>
      <dt>What to do</dt><dd>{request.whatToDo}</dd>
      {request.command && <><dt>Command</dt><dd className="terminal-request-command">
        <code>{request.command}</code>
        <button type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
      </dd></>}
    </dl>
    <p className="muted handoff-source">In {name}'s words. {name} can't see your terminal. Check the command before you run it.</p>
    {blocked && <p className="handoff-state" role="status">{blocked}</p>}
    <div className="actions">
      <button type="button" className="primary with-progress" disabled={disconnected || !!sending || !!blocked}
        onClick={() => openTerminal(request.command)}><Icon name="terminal" size={16} />Open terminal</button>
      <button type="button" className="with-progress" disabled={disconnected || !!sending || !!blocked} onClick={() => void settle("done")}>
        {sending === "done" && <Icon name="spinner" className="spin" size={16} />}{sending === "done" ? "Sending…" : "Done"}</button>
      <button type="button" className="with-progress" disabled={disconnected || !!sending} onClick={() => void settle("decline")}>
        {sending === "decline" && <Icon name="spinner" className="spin" size={16} />}{sending === "decline" ? "Sending…" : "Not now"}</button>
    </div>
    {request.command && <p className="muted secure-reply-hint">Open terminal offers to paste the command at the prompt. It doesn't run until you press Enter.</p>}
    <p className="muted secure-reply-hint">Or send a message instead. That cancels this request so {name} can read it.</p>
    {error && <FormMessage tone="error">{error}</FormMessage>}
  </article>;
}
