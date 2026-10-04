import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, write } from "../client-api";
import type { Bot } from "../shared/types";
import type { IntegrationCatalog, IntegrationConnection, IntegrationFlow } from "../shared/integrations";
import "./integrations.css";
import { Icon } from "./Icon";
import { When } from "./When";

const statusLabels: Record<IntegrationConnection["status"], string> = {
  connected: "Connected", configured: "Configured · not checked", not_connected: "Not connected",
  expired: "Sign in again", missing_permission: "Permission needed", unavailable: "Unavailable", unsupported: "Setup needed",
};
const categoryLabels: Record<string, string> = { productivity: "Accounts & productivity", development: "Development & infrastructure", files: "Files & storage", home: "Home", devices: "On your devices", providers: "Models, search & images", messaging: "Messaging", custom: "Custom connections" };
function authorizationUrl(value?: string) {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) ? url.href : undefined; } catch { return undefined; }
}

export function IntegrationsPanel({ bots, accountScope, onClose }: { bots: Bot[]; accountScope: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [profile, setProfile] = useState(bots[0]?.id || "");
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="integrations-panel" aria-labelledby="integrations-title" onCancel={onClose} onClose={onClose}>
    <header><div><p className="eyebrow">Your household workspace</p><h2 id="integrations-title">Integrations</h2></div><button className="icon-button" aria-label="Close integrations" onClick={onClose}><Icon name="close" /></button></header>
    <p className="muted">Connect the accounts and services your assistants use. A saved connection is checked separately from its permissions.</p>
    {bots.length > 1 && <label className="integration-profile">Connections for<select value={profile} onChange={e => setProfile(e.target.value)}>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>}
    {profile ? <IntegrationList key={profile} profile={profile} bots={bots} accountScope={accountScope} /> : <p>Create an assistant before connecting its services.</p>}
  </dialog>;
}

export function IntegrationList({ profile, bots, accountScope = "" }: { profile: string; bots: Bot[]; accountScope?: string }) {
  const [catalog, setCatalog] = useState<IntegrationCatalog>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<IntegrationConnection>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [disconnect, setDisconnect] = useState("");
  const [flow, setFlow] = useState<IntegrationFlow>();
  const [callback, setCallback] = useState("");
  const [custom, setCustom] = useState(false);
  const [mcp, setMcp] = useState({ name: "", url: "", auth: "none", token: "" });
  const alive = useRef(true);
  const locked = useRef(false);
  const flowKey = `integration-flow:${accountScope ? `${accountScope}:` : ""}${profile}`;
  const refresh = useCallback(async () => {
    setLoading(true);
    try { const value = await api<IntegrationCatalog>(`/integrations?profile=${encodeURIComponent(profile)}`); if (alive.current) { setCatalog(value); setError(""); } }
    catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setLoading(false); }
  }, [profile]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    let saved: string | null = null;
    try { saved = sessionStorage.getItem(flowKey); } catch { /* Private browsing can disable storage. */ }
    if (saved) setFlow({ flowId: saved, kind: "instructions", status: "pending", message: "Restoring the sign-in status…" });
    const wake = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("focus", wake); window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => { alive.current = false; window.removeEventListener("focus", wake); window.removeEventListener("online", wake); document.removeEventListener("visibilitychange", wake); };
  }, [refresh, flowKey]);
  useEffect(() => {
    if (!flow?.flowId || flow.status !== "pending") return;
    let current = true;
    const poll = async () => {
      try {
        const next = await api<IntegrationFlow>(`/integrations/flows/${encodeURIComponent(flow.flowId!)}?profile=${encodeURIComponent(profile)}`);
        if (!current) return;
        setFlow(next);
        if (next.status !== "pending") { try { sessionStorage.removeItem(flowKey); } catch {} void refresh(); }
      } catch (e) { if (current) setError((e as Error).message); }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => { current = false; clearInterval(timer); };
  }, [flow?.flowId, flow?.status, profile, refresh, flowKey]);
  const acceptFlow = (next: IntegrationFlow) => {
    setFlow(next);
    if (next.flowId && next.status === "pending") try { sessionStorage.setItem(flowKey, next.flowId); } catch {}
    const url = authorizationUrl(next.url);
    if (url && next.status === "pending") window.open(url, "_blank", "noopener,noreferrer");
  };
  const actionError = (cause: unknown, checking = false) => cause instanceof ApiError && cause.status >= 500
    ? checking ? "The connection check could not finish. Refresh status or try the check again." : "We couldn't confirm the connection change. Refresh status before trying again. Your request won't be sent again automatically."
    : (cause as Error).message;
  const action = async (id: string, operation: string, payload: unknown = { profile }) => {
    if (locked.current) return;
    locked.current = true; setBusy(id); setError("");
    try {
      const next = await write<IntegrationFlow>(`/integrations/${encodeURIComponent(id)}/${operation}`, payload);
      if (!alive.current) return;
      if (operation === "connect") {
        setFields({}); setEditing(undefined); acceptFlow(next);
      }
      setDisconnect(""); await refresh();
    } catch (e) { if (alive.current) setError(actionError(e, operation === "check")); }
    finally { locked.current = false; if (alive.current) setBusy(""); }
  };
  const finishFlow = async (cancel = false) => {
    if (!flow?.flowId || locked.current) return;
    locked.current = true; setBusy("flow"); setError("");
    try {
      const path = `/integrations/flows/${encodeURIComponent(flow.flowId)}`;
      const next = cancel ? await api<IntegrationFlow>(`${path}?profile=${encodeURIComponent(profile)}`, { method: "DELETE" })
        : await write<IntegrationFlow>(`${path}/callback`, { profile, callbackUrl: callback });
      if (alive.current) { setFlow(next); setCallback(""); await refresh(); }
      if (next.status !== "pending") try { sessionStorage.removeItem(flowKey); } catch {}
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { locked.current = false; if (alive.current) setBusy(""); }
  };
  const categories = [...new Set(catalog?.connections.map(item => item.category))];
  return <div className="integration-list">
    <div className="integration-toolbar"><span className="muted">{catalog ? `${catalog.connections.filter(c => c.status === "connected").length} connected` : "Checking connections…"}</span><button disabled={loading || !!busy} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh status"}</button></div>
    {error && <p role="alert" className="form-error">{error}</p>}
    {!catalog && !loading && error && <button onClick={() => void refresh()}>Try again</button>}
    {flow && <section className="integration-flow" aria-label="Connection sign-in" role="status">
      <strong>{flow.status === "approved" || flow.kind === "connected" ? "Connection ready" : flow.status === "pending" ? "Finish connecting your account" : "Sign-in status"}</strong>
      <p>{flow.message}</p>
      {flow.userCode && <p>Enter this code: <code className="integration-code">{flow.userCode}</code></p>}
      {flow.status === "pending" && authorizationUrl(flow.url) && <a href={authorizationUrl(flow.url)} target="_blank" rel="noopener noreferrer">Open sign-in <Icon name="external" size={15} /></a>}
      {flow.callbackInput && flow.status === "pending" && <form onSubmit={e => { e.preventDefault(); void finishFlow(); }}><label>Returned address<input type="url" required value={callback} onChange={e => setCallback(e.target.value)} placeholder="Paste the full browser address after sign-in" autoComplete="off" /></label><button disabled={!!busy}>Finish connection</button></form>}
      {flow.status === "pending" ? <button disabled={!!busy} onClick={() => void finishFlow(true)}>Cancel sign-in</button> : <button onClick={() => setFlow(undefined)}>Dismiss</button>}
    </section>}
    {editing && <form className="integration-setup" onSubmit={e => { e.preventDefault(); void action(editing.id, "connect", { profile, fields }); }}>
      <h3>Connect {editing.name}</h3><p className="muted">Connection credentials stay with Hermes. Secret fields are cleared after saving.</p>
      {editing.setup.map(field => <label key={field.key}>{field.label}{field.options ? <select required={field.required} value={fields[field.key] || ""} onChange={e => setFields({ ...fields, [field.key]: e.target.value })}>{!fields[field.key] && <option value="">Choose a sign-in method</option>}{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input required={field.required} type={field.kind === "secret" ? "password" : field.kind === "url" ? "url" : "text"} autoComplete="off" value={fields[field.key] || ""} onChange={e => setFields({ ...fields, [field.key]: e.target.value })} />}</label>)}
      <div className="actions"><button className="primary" disabled={!!busy}>{busy ? "Connecting…" : "Connect"}</button><button type="button" disabled={!!busy} onClick={() => { setEditing(undefined); setFields({}); }}>Cancel</button></div>
    </form>}
    {categories.map(category => <section className="integration-group" key={category}><h3>{categoryLabels[category] || category}</h3><div className="integration-cards">{catalog!.connections.filter(item => item.category === category).map(item => <article className="integration-card" key={item.id} data-status={item.status}>
      <div className="integration-card-heading"><h4>{item.name}</h4><span className="integration-status">{statusLabels[item.status]}</span></div>
      {item.account && <p className="integration-account">{item.account}</p>}<p>{item.detail}</p>
      <dl><div><dt>Managed by</dt><dd>{item.owner}</dd></div><div><dt>Assistants</dt><dd>{item.botIds.length ? item.botIds.map(id => bots.find(bot => bot.id === id)?.name || id).join(", ") : "This assistant"}</dd></div><div><dt>Last checked</dt><dd>{item.checkedAt ? <When value={item.checkedAt} /> : "Not checked yet"}</dd></div></dl>
      {item.permissions.length > 0 && <details><summary>Access & permissions</summary><ul>{item.permissions.map(permission => <li key={permission.id}>{permission.name}<span>{permission.granted === true ? "Granted" : permission.granted === false ? "Missing" : "Not checked"}</span></li>)}</ul></details>}
      {disconnect === item.id ? <div className="integration-confirmation"><p>Disconnect {item.name}? Assistants using it will lose access.</p><div className="actions"><button className="danger" disabled={!!busy} onClick={() => void action(item.id, "disconnect")}>Disconnect</button><button disabled={!!busy} onClick={() => setDisconnect("")}>Keep connected</button></div></div> : <div className="actions">
        {item.actions.connect && <button className={item.status !== "connected" ? "primary" : ""} disabled={!!busy || !catalog!.canManage || flow?.status === "pending"} onClick={() => { if (item.setup.length) { setEditing(item); setFields(Object.fromEntries(item.setup.filter(field => field.defaultValue !== undefined).map(field => [field.key, field.defaultValue!]))); } else void action(item.id, "connect"); }}>{busy === item.id ? "Working…" : item.status === "not_connected" || item.status === "unsupported" ? "Connect" : "Reconnect"}</button>}
        {item.actions.check && <button disabled={!!busy} onClick={() => void action(item.id, "check")}>Check connection</button>}
        {item.actions.disconnect && <button disabled={!!busy || !catalog!.canManage} onClick={() => setDisconnect(item.id)}>Disconnect</button>}
      </div>}
    </article>)}</div></section>)}
    {catalog && catalog.connections.length === 0 && <p className="muted">Hermes has not reported any connections for this assistant.</p>}
    {catalog?.canManage && <section className="integration-custom"><button aria-expanded={custom} onClick={() => setCustom(!custom)}><Icon name="plus" size={18} /> Add custom MCP connection</button>{custom && <form onSubmit={async e => {
      e.preventDefault(); if (locked.current) return; locked.current = true; setBusy("mcp"); setError("");
      try { const next = await write<IntegrationFlow | IntegrationConnection>("/integrations/mcp", { profile, ...mcp, token: mcp.auth === "bearer" ? mcp.token : undefined }); if (alive.current) { if ("kind" in next) acceptFlow(next); setMcp({ name: "", url: "", auth: "none", token: "" }); setCustom(false); await refresh(); } }
      catch (e) { if (alive.current) setError(actionError(e)); }
      finally { locked.current = false; if (alive.current) setBusy(""); }
    }}><label>Connection name<input required pattern="[A-Za-z0-9_-]{1,80}" title="Use letters, numbers, underscores, or hyphens, up to 80 characters" value={mcp.name} onChange={e => setMcp({ ...mcp, name: e.target.value })} /></label><label>Server address<input required type="url" placeholder="https://" value={mcp.url} onChange={e => setMcp({ ...mcp, url: e.target.value })} /></label><label>Sign-in method<select value={mcp.auth} onChange={e => setMcp({ ...mcp, auth: e.target.value, token: "" })}><option value="none">No sign-in</option><option value="oauth">Sign in with browser</option><option value="bearer">Access token</option></select></label>{mcp.auth === "bearer" && <label>Access token<input required type="password" autoComplete="off" value={mcp.token} onChange={e => setMcp({ ...mcp, token: e.target.value })} /></label>}<button className="primary" disabled={!!busy}>Add connection</button></form>}</section>}
  </div>;
}
