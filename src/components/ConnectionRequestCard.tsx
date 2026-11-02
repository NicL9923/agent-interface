import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ApiError, write } from "../client-api";
import type { Bot } from "../shared/types";
import { connectionReady, type ConnectionRequest, type ConnectionRequestDecision, type ConnectionRequestResult, type IntegrationCatalog, type IntegrationConnection } from "../shared/integrations";
import { rememberSettled } from "../app/waiting-input";
import { attentionAnchor } from "../app/transcript-logic";
import { Icon } from "./Icon";
import { FormMessage } from "./ui/form-message";
import { SettledReceipt } from "./SecureRequestCard";
import "./handoff.css";

// The integrations UI loads with Settings, so the transcript only pays for it when a card appears.
const IntegrationList = lazy(() => import("./IntegrationsPanel").then(module => ({ default: module.IntegrationList })));

const ready = (item?: IntegrationConnection | null) => connectionReady(item ?? undefined);

/**
 * An assistant asks a person to set up one of its connections, in the chat. The card holds that
 * connection's own setup and sign-in. Once it reads as set up, the card tells the assistant to
 * continue on its own; Continue does the same for a connection that was already set up, and
 * Not now declines. A chat message closes it so the assistant reads that message instead.
 */
export function ConnectionRequestCard({ request, requestId, botId, bots, userId, assistantName, disconnected }: {
  request: ConnectionRequest; requestId: string; botId: string; bots: Bot[]; userId: string; assistantName?: string; disconnected: boolean;
}) {
  const name = assistantName || "The assistant";
  const [item, setItem] = useState<IntegrationConnection | null>();
  const [canManage, setCanManage] = useState(true);
  const [sending, setSending] = useState<ConnectionRequestDecision | null>(null);
  const [settled, setSettled] = useState<string | null>(null);
  const [error, setError] = useState("");
  const live = useRef(true);
  // Set in the effect too: StrictMode runs cleanup and setup again on mount.
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // Whether it was already set up when the card first read the catalog. Only a change while the
  // card is open continues on its own, so an expired grant that still reads as saved waits for Continue.
  const initiallyReady = useRef<boolean | undefined>(undefined);
  const autoSent = useRef(false);
  const service = item?.name || "a service";

  async function settle(decision: ConnectionRequestDecision, automatic = false) {
    if (sending || settled) return;
    setSending(decision); setError("");
    try {
      const result = await write<ConnectionRequestResult>(`/bots/${encodeURIComponent(botId)}/connection-requests/${encodeURIComponent(requestId)}`,
        { decision, epoch: request.epoch, sessionId: request.sessionId, connection: request.connectionId });
      if (!live.current) return;
      if (result.status === "expired") setError("This request had already closed. Refresh the conversation to see what happened.");
      else {
        const text = decision === "connected" ? `Connected ${service}. ${name} will continue.` : `You chose Not now. ${name} will continue without it.`;
        setSettled(text);
        rememberSettled(botId, requestId, text);
      }
    } catch (cause) {
      if (!live.current) return;
      // An automatic continue that the server refuses waits for the person instead of showing an error.
      if (automatic && cause instanceof ApiError && cause.status === 409) autoSent.current = false;
      else setError(cause instanceof ApiError && cause.status < 500 ? cause.message
        : `Couldn't reach Hermes. Try ${decision === "connected" ? "Continue" : "Not now"} again.`);
    } finally { if (live.current) setSending(null); }
  }

  function continueOnce() {
    if (autoSent.current || disconnected) return;
    autoSent.current = true;
    void settle("connected", true);
  }

  /** A finished sign-in continues only for this request's connection; one restored from Settings may be another's. */
  function onApproved(connectionId?: string) {
    if (connectionId === request.connectionId) continueOnce();
  }

  function onCatalog(catalog: IntegrationCatalog) {
    const next = catalog.connections.find(connection => connection.id === request.connectionId) ?? null;
    setItem(next); setCanManage(catalog.canManage);
    if (initiallyReady.current === undefined) initiallyReady.current = ready(next);
    else if (!initiallyReady.current && ready(next)) continueOnce();
  }

  if (settled) return <SettledReceipt requestId={requestId} text={settled} />;
  const missing = item === null;
  return <article className="approval-card computer-handoff connection-request" data-request-id={requestId} {...attentionAnchor("connection", requestId)}>
    <p className="eyebrow"><Icon name="plug" size={16} />Connection</p>
    <h2>{missing ? `${name} asked for a connection` : `${name} wants to connect ${service}`}</h2>
    <dl className="handoff-ask"><dt>Why</dt><dd>{request.reason}</dd></dl>
    <p className="muted handoff-source">In {name}'s words. Credentials go straight to Hermes, never into this chat.</p>
    {missing ? <p className="handoff-state" role="status">WildBots doesn't have a connection called {request.connectionId} for {name}.</p>
      : !canManage && !ready(item) ? <p className="handoff-state" role="status">Only a household integration administrator can connect {service}. Ask one of them, or choose Not now.</p>
      : null}
    <div className="connection-request-setup">
      <Suspense fallback={<p className="muted" role="status">Loading connection…</p>}>
        <IntegrationList profile={botId} bots={bots} accountScope={userId} only={request.connectionId} onCatalog={onCatalog} onApproved={onApproved} />
      </Suspense>
    </div>
    <div className="actions">
      {/* Until it is set up, Connect inside is the next step; the card continues on its own once it is. */}
      {ready(item) && <button type="button" className="primary with-progress" disabled={disconnected || !!sending}
        onClick={() => void settle("connected")}>{sending === "connected" && <Icon name="spinner" className="spin" size={16} />}{sending === "connected" ? "Sending…" : "Continue"}</button>}
      <button type="button" className="with-progress" disabled={disconnected || !!sending} onClick={() => void settle("decline")}>
        {sending === "decline" && <Icon name="spinner" className="spin" size={16} />}{sending === "decline" ? "Sending…" : "Not now"}</button>
    </div>
    <p className="muted secure-reply-hint">Or send a message instead. That cancels this request so {name} can read it.</p>
    {error && <FormMessage tone="error">{error}</FormMessage>}
  </article>;
}
