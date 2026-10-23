import { useEffect, useRef, useState } from "react";
import { ApiError, request as apiRequest, write } from "../client-api";
import type { ExplicitLoginRequest, SecureRequest, SecureRequestAnswer } from "../shared/vault";
import "./vault.css";
import { FormMessage } from "./ui/form-message";

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
  }, [scope]);
  useEffect(() => {
    const clear = () => { setIdentifier(""); setSecret(""); };
    const hidden = () => { if (document.visibilityState === "hidden") clear(); };
    document.addEventListener("visibilitychange", hidden); window.addEventListener("pagehide", clear);
    return () => { document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", clear); };
  }, []);
  const active = (started: string) => mounted.current && current.current === started;
  // A login the assistant asked for by address. Only the member whose task asked may answer it.
  const explicit = request.method === "vault.save_login" ? request.explicit : undefined;
  const requester = explicit?.requestedBy;
  const answerable = !requester || requester.id === ownerId;
  async function answer(cancel = false) {
    if (busy || uncertain || settled || !answerable || uncertainRequests.has(scope)) return;
    const started = scope;
    const binding = { epoch: request.epoch, sessionId: request.sessionId, method: request.method };
    const payload: SecureRequestAnswer = cancel ? { ...binding, cancel: true }
      : request.method === "vault.save_login" ? { ...binding, method: "vault.save_login", identifier, password: secret,
        ...(explicit ? { origin: request.origin } : {}) }
      : { ...binding, method: request.method, value: secret };
    uncertainRequests.add(started);
    setSecret(""); setIdentifier(""); setBusy(true); setError(""); setNotice("");
    try {
      const result = await write<{ status: "ok" | "expired" }>(`/bots/${encodeURIComponent(botId)}/secure-requests/${encodeURIComponent(requestId)}`, payload);
      uncertainRequests.delete(started);
      if (!active(started)) return;
      setSettled(true); setNotice(result.status === "expired" ? "This request has expired. Refresh the conversation."
        : cancel ? "Request cancelled in Hermes." : "Sent directly to Hermes.");
    } catch (e) {
      const ambiguous = !(e instanceof ApiError) || e.status >= 500;
      if (ambiguous) uncertainRequests.add(started);
      else uncertainRequests.delete(started);
      if (!active(started)) return;
      setUncertain(ambiguous);
      if (e instanceof ApiError && e.status === 409) setSettled(true);
      setError(ambiguous ? "Hermes has not confirmed the result. Refresh to check before doing anything else. Your secret has been cleared."
        : "This secure request could not be completed. Refresh the conversation to check whether it is still waiting.");
    } finally { if (active(started)) setBusy(false); }
  }
  async function refresh() {
    const started = scope; setBusy(true);
    try {
      const conversation = await apiRequest("GET /bots/:id/conversation", { params: { id: botId } });
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
  const login = request.method === "vault.save_login";
  const secretLabel = login ? "Password" : request.method === "vault.code" ? "One-time code"
    : request.method === "vault.unlock_prompt" ? `${request.displayName} master password` : "Secret value";
  return <article className="approval-card secure-request" data-request-id={requestId}>
    <p className="eyebrow">Secure input for Hermes</p><h2>{title}</h2><p>{detail}</p>
    {login && !explicit && <p className="vault-origin">Website: {request.origin}</p>}
    {login && explicit && <ExplicitLoginDetails origin={request.origin} request={explicit} assistantName={assistantName} />}
    {request.method === "vault.code" && request.site && <p className="vault-origin">Website: {request.site}</p>}
    {request.method === "secret" && <p>Hermes setting: <code>{request.envVar}</code>. Hermes saves this in its profile environment, separately from saved logins.</p>}
    {!settled && !answerable && <p role="status">Waiting for {requester?.name ?? "the household member who started this task"}. Only they can save or cancel this login.</p>}
    {!settled && answerable && <form autoComplete="off" onSubmit={event => { event.preventDefault(); void answer(); }}>
      {login && <label>Username, email or phone<input required maxLength={1000} autoComplete="off" value={identifier}
        disabled={busy || uncertain} onChange={event => setIdentifier(event.target.value)} /></label>}
      <label>{secretLabel}<input required type="password" autoComplete="off" autoCorrect="off" spellCheck={false} maxLength={4096} value={secret}
        disabled={busy || uncertain} onChange={event => setSecret(event.target.value)} /></label>
      <p className="muted">Send directly to Hermes, outside your message and draft. Fields clear when you submit or leave this screen.</p>
      <div className="actions"><button className="primary" disabled={busy || uncertain || !secret || (login && !identifier.trim())}>
        {busy ? "Sending..." : login ? "Save login and continue" : "Send to Hermes"}</button>
        <button type="button" disabled={busy || uncertain} onClick={() => void answer(true)}>Cancel request</button></div>
    </form>}
    {(uncertain || settled || error) && <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh request</button>}
    {error && <FormMessage tone="error">{error}</FormMessage>}{notice && <FormMessage tone="notice">{notice}</FormMessage>}
  </article>;
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
