import { useEffect, useRef, useState } from "react";
import { ApiError, request as apiRequest, write } from "../client-api";
import type { ExplicitLoginRequest, SecureRequest, SecureRequestAnswer } from "../shared/vault";
import "./vault.css";
import { FormMessage } from "./ui/form-message";
import { attentionAnchor } from "../app/transcript-logic";
import { rememberSettled } from "../app/waiting-input";
import { supersedePrefetch } from "../app/conversation-page";
import { Icon } from "./Icon";

// The accepted card reads for this long, then folds to its one-line receipt.
const COLLAPSE_MS = 1200;
// What a locked password field shows while sending, as a placeholder. The field itself is already empty.
const MASK = "\u2022".repeat(10);
// Volatile binding metadata only. Reopening the same native prompt must not turn
// an uncertain submission into a fresh attempt. Never persist entered values.
const uncertainRequests = new Set<string>();

export function SecureRequestCard({ request, requestId, botId, ownerId, title, detail, assistantName }: {
  request: SecureRequest; requestId: string; botId: string; ownerId: string; title: string; detail: string; assistantName?: string;
}) {
  const scope = JSON.stringify({ request, requestId, botId, ownerId });
  const [identifier, setIdentifier] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  // While sending, the card shows what is on its way: the visible identifier and a masked stand-in, never the secret.
  const [sending, setSending] = useState<{ identifier: string; cancel: boolean } | null>(null);
  const [accepted, setAccepted] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [uncertain, setUncertain] = useState(() => uncertainRequests.has(scope));
  const [settled, setSettled] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const current = useRef(scope); current.current = scope;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    setIdentifier(""); setSecret(""); setUncertain(uncertainRequests.has(scope)); setSettled(false); setBusy(false); setError(""); setNotice("");
    setSending(null); setAccepted(null); setCollapsed(false);
  }, [scope]);
  useEffect(() => {
    if (!accepted) return;
    const timer = setTimeout(() => setCollapsed(true), COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [accepted]);
  useEffect(() => {
    const clear = () => { setIdentifier(""); setSecret(""); };
    const hidden = () => { if (document.visibilityState === "hidden") clear(); };
    document.addEventListener("visibilitychange", hidden); window.addEventListener("pagehide", clear);
    return () => { document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", clear); };
  }, []);
  const active = (started: string) => mounted.current && current.current === started;
  const name = assistantName || "The assistant";
  // A login the assistant asked for by address. Only the member whose task asked may answer it.
  const explicit = request.method === "vault.save_login" ? request.explicit : undefined;
  const requester = explicit?.requestedBy;
  const answerable = !requester || requester.id === ownerId;
  const login = request.method === "vault.save_login";
  async function answer(cancel = false) {
    if (busy || uncertain || settled || accepted || !answerable || uncertainRequests.has(scope)) return;
    const started = scope;
    const binding = { epoch: request.epoch, sessionId: request.sessionId, method: request.method };
    const payload: SecureRequestAnswer = cancel ? { ...binding, cancel: true }
      : request.method === "vault.save_login" ? { ...binding, method: "vault.save_login", identifier, password: secret,
        ...(explicit ? { origin: request.origin } : {}) }
      : { ...binding, method: request.method, value: secret };
    uncertainRequests.add(started);
    setSending({ identifier: cancel ? "" : identifier.trim(), cancel });
    setSecret(""); setIdentifier(""); setBusy(true); setError(""); setNotice("");
    try {
      const result = await write<{ status: "ok" | "expired" }>(`/bots/${encodeURIComponent(botId)}/secure-requests/${encodeURIComponent(requestId)}`, payload);
      uncertainRequests.delete(started);
      if (!active(started)) return;
      if (result.status === "expired") {
        setSettled(true);
        setNotice("This request had already closed, so Hermes didn't use what you entered. It may have timed out, been stopped, or closed when someone sent a message.");
      } else {
        const text = cancel ? `Request cancelled. ${name} will continue without it.`
          : login ? `Login saved. ${name} is continuing.` : `Sent securely. ${name} is continuing.`;
        setAccepted(text);
        rememberSettled(botId, requestId, text);
      }
    } catch (e) {
      const ambiguous = !(e instanceof ApiError) || e.status >= 500;
      if (ambiguous) uncertainRequests.add(started);
      else uncertainRequests.delete(started);
      if (!active(started)) return;
      setUncertain(ambiguous);
      if (e instanceof ApiError && e.status === 409) setSettled(true);
      setError(ambiguous ? "Hermes has not confirmed the result. Refresh to check before doing anything else. Your secret has been cleared."
        : "This secure request could not be completed. Refresh the conversation to check whether it is still waiting.");
    } finally { if (active(started)) { setBusy(false); setSending(null); } }
  }
  async function refresh() {
    const started = scope; setBusy(true);
    try {
      const conversation = await apiRequest("GET /bots/:id/conversation", { params: { id: botId } });
      supersedePrefetch(botId);
      if (!active(started)) return;
      const pending = conversation.attention?.some(item => item.id === requestId && JSON.stringify(item.secure) === JSON.stringify(request));
      if (!pending) { uncertainRequests.delete(started); setSettled(true); setNotice("Hermes is no longer waiting for this request."); setError(""); }
      else {
        const blocked = uncertainRequests.has(started);
        setUncertain(blocked);
        setNotice(blocked ? "The same request is still visible. Its result is uncertain; it will not be submitted again." : "Hermes is still waiting for this request.");
      }
    } catch { if (active(started)) setError("Could not refresh the secure request. Check the Hermes connection."); }
    finally { if (active(started)) setBusy(false); }
  }
  if (accepted && collapsed) return <SettledReceipt requestId={requestId} text={accepted} />;
  const secretLabel = login ? "Password" : request.method === "vault.code" ? "One-time code"
    : request.method === "vault.unlock_prompt" ? `${request.displayName} master password` : "Secret value";
  const locked = busy || uncertain;
  return <article className={`approval-card secure-request${accepted ? " is-accepted" : ""}`} data-request-id={requestId} {...attentionAnchor("secure", requestId)}>
    <p className="eyebrow">Secure input for Hermes</p><h2>{title}</h2>
    {accepted ? <p className="secure-accepted" role="status"><Icon name="check" size={18} />{accepted}</p> : <>
      <p>{detail}</p>
      {login && !explicit && <p className="vault-origin">Website: {request.origin}</p>}
      {login && explicit && <ExplicitLoginDetails origin={request.origin} request={explicit} assistantName={assistantName} />}
      {request.method === "vault.code" && request.site && <p className="vault-origin">Website: {request.site}</p>}
      {request.method === "secret" && <p>Hermes setting: <code>{request.envVar}</code>. Hermes saves this in its profile environment, separately from saved logins.</p>}
      {!settled && !answerable && <>
        <p role="status">Waiting for {requester?.name ?? "the household member who started this task"}. Only they can save or cancel this login.</p>
        <p className="muted secure-reply-hint">Messages you send reach {name} after they answer.</p>
      </>}
      {!settled && answerable && <form autoComplete="off" aria-busy={busy || undefined} onSubmit={event => { event.preventDefault(); void answer(); }}>
        {login && <label>Username, email or phone<input required maxLength={1000} autoComplete="off"
          value={sending ? sending.identifier : identifier} readOnly={!!sending} disabled={locked} onChange={event => setIdentifier(event.target.value)} /></label>}
        <label>{secretLabel}<input required type="password" autoComplete="off" autoCorrect="off" spellCheck={false} maxLength={4096}
          value={secret} placeholder={sending && !sending.cancel ? MASK : undefined} readOnly={!!sending} disabled={locked}
          onChange={event => setSecret(event.target.value)} /></label>
        <p className="muted">Sent directly to Hermes, outside your message and draft. Fields clear when you submit or leave this screen.</p>
        <div className="actions"><button className={`primary with-progress${sending && !sending.cancel ? " is-sending" : ""}`} disabled={locked || !secret || (login && !identifier.trim())}>
          {sending && !sending.cancel && <Icon name="spinner" className="spin" size={16} />}
          {sending && !sending.cancel ? "Sending securely…" : login ? "Save login and continue" : "Send to Hermes"}</button>
          <button type="button" className="with-progress" disabled={locked} onClick={() => void answer(true)}>
            {sending?.cancel && <Icon name="spinner" className="spin" size={16} />}{sending?.cancel ? "Cancelling…" : "Cancel request"}</button></div>
        {sending && <p className="sr-only" role="status">{sending.cancel ? "Cancelling the request…" : "Sending securely…"}</p>}
        <p className="muted secure-reply-hint">Need to change something? Send a message instead. That cancels this request so {name} can read it and ask again.</p>
      </form>}
    </>}
    {(uncertain || settled || error) && <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh request</button>}
    {error && <FormMessage tone="error">{error}</FormMessage>}{notice && <FormMessage tone="notice">{notice}</FormMessage>}
  </article>;
}

/** The one line a settled request leaves, in the card's place and briefly after Hermes stops listing it. */
export function SettledReceipt({ requestId, text }: { requestId: string; text: string }) {
  return <p className="secure-receipt" data-request-id={requestId} role="status"><Icon name="check" size={16} />{text}</p>;
}

/** What the assistant asked for. The address is the only part Hermes checks; the rest is the assistant's own text. */
function ExplicitLoginDetails({ origin, request, assistantName }: { origin: string; request: ExplicitLoginRequest; assistantName?: string }) {
  const assistant = assistantName && assistantName !== request.profile ? `${assistantName} (Hermes profile ${request.profile})` : `Hermes profile ${request.profile}`;
  return <dl className="credential-context">
    <dt>Address</dt>
    <dd><span className="vault-origin">{origin}</span>
      <span className="muted">Hermes has not opened or checked it.{origin.startsWith("http://") && " This address does not use HTTPS."}</span></dd>
    <dt>Name</dt><dd>{request.label}</dd>
    <dt>Asked by</dt><dd>{assistant}{request.requestedBy?.name ? ` for ${request.requestedBy.name}` : ""}</dd>
    <dt>Reason, in the assistant's words</dt><dd>{request.purpose}</dd>
    <dt>Storage</dt>
    <dd>Saved in this profile's encrypted Hermes vault until someone removes it in Logins. The assistant gets a handle and
      the username, never the password. Hermes fills the password only on pages at exactly this address.</dd>
    <dt>Who can reach it</dt>
    <dd>Profiles organize access but are not a household security boundary. Household members with Hermes access, and
      tools running on the Hermes server, can reach saved logins.</dd>
  </dl>;
}
