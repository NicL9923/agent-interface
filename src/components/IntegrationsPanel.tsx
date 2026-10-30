import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { useEffect, useId, useRef, useState } from "react";
import { api, ApiError, write } from "../client-api";
import { useAction } from "../app/use-action";
import { useResource } from "../app/use-resource";
import { integrationFlowKey } from "../app/storage";
import { FormMessage } from "./ui/form-message";
import type { Bot } from "../shared/types";
import type { IntegrationCatalog, IntegrationConnection, IntegrationFlow } from "../shared/integrations";
import "./integrations.css";
import { Icon } from "./Icon";
import { When } from "./When";

const statusLabels: Record<IntegrationConnection["status"], string> = {
  connected: "Connected", configured: "Configured · not checked", not_connected: "Not connected",
  expired: "Expired", missing_permission: "Permission needed", unavailable: "Unavailable", unsupported: "Setup needed",
};
const categoryLabels: Record<string, string> = { productivity: "Accounts & productivity", development: "Development & infrastructure", files: "Files & storage", home: "Home", devices: "On your devices", providers: "Models, search & images", messaging: "Messaging", custom: "Custom connections" };
function authorizationUrl(value?: string) {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) ? url.href : undefined; } catch { return undefined; }
}

export function IntegrationsPanel({ bots, accountScope, onClose }: { bots: Bot[]; accountScope: string; onClose: () => void }) {
  const [profile, setProfile] = useState(bots[0]?.id || "");
  return <Dialog className="integrations-panel" aria-labelledby="integrations-title" onCancel={onClose} onClose={onClose}>
    <header><div><p className="eyebrow">Your household workspace</p><h2 id="integrations-title">Integrations</h2></div><Button className="icon-button" aria-label="Close integrations" onClick={onClose}><Icon name="close" /></Button></header>
    <p className="muted">Each assistant has its own connections. Connecting an account for one assistant doesn't give another assistant access.</p>
    {bots.length > 1 && <label className="integration-profile">Connections for<NativeSelect value={profile} onChange={e => setProfile(e.target.value)}>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</NativeSelect></label>}
    {profile ? <IntegrationList key={profile} profile={profile} bots={bots} accountScope={accountScope} /> : <p>Create an assistant before connecting its services.</p>}
  </Dialog>;
}

export function IntegrationList({ profile, bots, accountScope = "" }: { profile: string; bots: Bot[]; accountScope?: string }) {
  const disconnectButtons = useRef(new Map<string, HTMLButtonElement>());
  const keepConnected = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const returnToDisconnect = useRef<string | null>(null);
  const disconnectPromptId = useId();
  const [flowService, setFlowService] = useState("");
  const [editing, setEditing] = useState<IntegrationConnection>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [disconnect, setDisconnect] = useState("");
  const [flow, setFlow] = useState<IntegrationFlow>();
  const [callback, setCallback] = useState("");
  const [custom, setCustom] = useState(false);
  const [mcp, setMcp] = useState({ name: "", url: "", auth: "none", token: "" });
  const flowKey = integrationFlowKey(accountScope, profile);
  const connections = useResource<IntegrationCatalog>(`/integrations?profile=${encodeURIComponent(profile)}`, { wake: true });
  const { data: catalog, loading, reload: refresh } = connections;
  const action = useAction();
  const copyCode = useAction();
  const { busy } = action;
  useEffect(() => {
    if (busy || loading) return;
    if (disconnect) { keepConnected.current?.focus(); return; }
    if (returnToDisconnect.current) {
      const trigger = disconnectButtons.current.get(returnToDisconnect.current);
      (trigger && !trigger.disabled ? trigger : refreshButton.current)?.focus();
      returnToDisconnect.current = null;
    }
  }, [disconnect, busy, loading]);
  useEffect(() => { copyCode.reset(); }, [flow?.flowId, flow?.userCode]);
  // Which control started the work, to label it "Working…".
  const [working, setWorking] = useState("");
  // A pending sign-in is checked until it finishes. A check that lands after the flow changed is dropped.
  const pendingFlow = flow?.status === "pending" ? flow.flowId : undefined;
  const flowCheck = useResource<IntegrationFlow>(pendingFlow ? `/integrations/flows/${encodeURIComponent(pendingFlow)}?profile=${encodeURIComponent(profile)}` : null, {
    pollMs: 2500,
    onData: next => {
      setFlow(next);
      if (next.status !== "pending") { try { sessionStorage.removeItem(flowKey); } catch {} void refresh(); }
    },
  });
  const error = action.error || connections.error || flowCheck.error;
  // A refresh someone asks for answers "Refresh status before trying again", so it retires that error.
  const refreshStatus = () => { action.setError(""); void refresh(); };
  useEffect(() => {
    let saved: string | null = null;
    try { saved = sessionStorage.getItem(flowKey); } catch { /* Private browsing can disable storage. */ }
    if (saved) setFlow({ flowId: saved, kind: "instructions", status: "pending", message: "Restoring the sign-in status…" });
  }, [flowKey]);
  const acceptFlow = (next: IntegrationFlow, service = "") => {
    setFlowService(service);
    setFlow(next);
    if (next.flowId && next.status === "pending") try { sessionStorage.setItem(flowKey, next.flowId); } catch {}
    const url = authorizationUrl(next.url);
    if (url && next.status === "pending") window.open(url, "_blank", "noopener,noreferrer");
  };
  const actionError = (cause: unknown, checking = false) => cause instanceof ApiError && cause.status >= 500
    ? checking ? "The connection check could not finish. Refresh status or try the check again." : "We couldn't confirm the connection change. Refresh status before trying again. Your request won't be sent again automatically."
    : (cause as Error).message;
  const act = (id: string, operation: string, payload: unknown = { profile }) => action.run(async ({ current }) => {
    setWorking(id);
    const next = await write<IntegrationFlow>(`/integrations/${encodeURIComponent(id)}/${operation}`, payload);
    if (!current()) return;
    if (operation === "connect") {
      setFields({}); setEditing(undefined); acceptFlow(next, catalog?.connections.find(item => item.id === id)?.name);
    }
    setDisconnect(""); await refresh();
  }, { onError: cause => actionError(cause, operation === "check") });
  const finishFlow = (cancel = false) => {
    if (!flow?.flowId) return;
    const { flowId } = flow;
    return action.run(async ({ current }) => {
      setWorking("flow");
      const path = `/integrations/flows/${encodeURIComponent(flowId)}`;
      const next = cancel ? await api<IntegrationFlow>(`${path}?profile=${encodeURIComponent(profile)}`, { method: "DELETE" })
        : await write<IntegrationFlow>(`${path}/callback`, { profile, callbackUrl: callback });
      // A check that started before this answer could otherwise replace it with the older state.
      if (current()) { flowCheck.invalidate(); setFlow(next); setCallback(""); await refresh(); }
      if (next.status !== "pending") try { sessionStorage.removeItem(flowKey); } catch {}
    });
  };
  const categories = [...new Set(catalog?.connections.map(item => item.category))];
  return <div className="integration-list">
    <div className="integration-toolbar"><span className="muted">{catalog ? `${catalog.connections.filter(c => c.status === "connected").length} connected` : "Checking connections…"}</span><Button ref={refreshButton} disabled={loading || busy} onClick={refreshStatus}>{loading ? "Refreshing…" : "Refresh status"}</Button></div>
    {error && <FormMessage tone="error">{error}</FormMessage>}
    {!catalog && !loading && error && <Button onClick={refreshStatus}>Try again</Button>}
    {flow && <section className="integration-flow" aria-label="Connection sign-in" role="status">
      <strong>{flow.status === "approved" || flow.kind === "connected" ? `Connection ready${flowService ? ` for ${flowService}` : ""}` : flow.status === "pending" ? `Finish connecting ${flowService || "your account"}` : `Sign-in status${flowService ? ` for ${flowService}` : ""}`}</strong>
      <p>{flow.message}</p>
      {flow.userCode && <div className="integration-code-row"><p>Enter this code: <code className="integration-code">{flow.userCode}</code></p><Button disabled={copyCode.busy} onClick={() => void copyCode.run(() => navigator.clipboard.writeText(flow.userCode!), { success: "Sign-in code copied.", onError: () => "Could not copy the code. Select and copy it instead." })}>Copy code</Button></div>}
      {copyCode.notice && <FormMessage tone="notice">{copyCode.notice}</FormMessage>}{copyCode.error && <FormMessage tone="error">{copyCode.error}</FormMessage>}
      {flow.status === "pending" && authorizationUrl(flow.url) && <a href={authorizationUrl(flow.url)} target="_blank" rel="noopener noreferrer">Open sign-in <Icon name="external" size={15} /></a>}
      {flow.callbackInput && flow.status === "pending" && <form onSubmit={e => { e.preventDefault(); void finishFlow(); }}><label>Returned address<Input type="url" required value={callback} onChange={e => setCallback(e.target.value)} placeholder="Paste the full browser address after sign-in" autoComplete="off" /></label><Button type="submit" disabled={busy}>Finish connection</Button></form>}
      {flow.status === "pending" ? <Button disabled={busy} onClick={() => void finishFlow(true)}>Cancel sign-in</Button> : <Button onClick={() => setFlow(undefined)}>Dismiss</Button>}
    </section>}
    {editing && <form className="integration-setup" onSubmit={e => { e.preventDefault(); void act(editing.id, "connect", { profile, fields }); }}>
      <h3>Connect {editing.name}</h3><p className="muted">Connection credentials stay with Hermes. Secret fields are cleared after saving.</p>
      {editing.setup.map(field => <label key={field.key}>{field.label}{field.options ? <NativeSelect required={field.required} value={fields[field.key] || ""} onChange={e => setFields({ ...fields, [field.key]: e.target.value })}>{!fields[field.key] && <option value="">Choose a sign-in method</option>}{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</NativeSelect> : <Input required={field.required} type={field.kind === "secret" ? "password" : field.kind === "url" ? "url" : "text"} autoComplete="off" value={fields[field.key] || ""} onChange={e => setFields({ ...fields, [field.key]: e.target.value })} />}</label>)}
      <div className="actions"><Button type="submit" className="primary" disabled={busy}>{busy ? "Connecting…" : "Connect"}</Button><Button type="button" disabled={busy} onClick={() => { setEditing(undefined); setFields({}); }}>Cancel</Button></div>
    </form>}
    {categories.map(category => <section className="integration-group" key={category}><h3>{categoryLabels[category] || category}</h3><div className="integration-cards">{catalog!.connections.filter(item => item.category === category).map(item => {
      const recommendsCheck = ["configured", "unavailable"].includes(item.status);
      const recommendsConnect = ["not_connected", "unsupported", "expired", "missing_permission"].includes(item.status);
      return <article className="integration-card" key={item.id} data-status={item.status}>
      <div className="integration-card-heading"><h4>{item.name}</h4><span className="integration-status">{statusLabels[item.status]}</span></div>
      {item.account && <p className="integration-account">{item.account}</p>}<p>{item.detail}</p>{item.uses && <p className="muted">{item.uses}</p>}
      <dl><div><dt>Managed by</dt><dd>{item.owner}</dd></div><div><dt>Assistants</dt><dd>{item.botIds.length ? item.botIds.map(id => bots.find(bot => bot.id === id)?.name || id).join(", ") : "This assistant"}</dd></div><div><dt>Last checked</dt><dd>{item.checkedAt ? <When value={item.checkedAt} /> : "Not checked yet"}</dd></div></dl>
      {item.permissions.length > 0 && <details><summary>Access & permissions</summary><ul>{item.permissions.map(permission => <li key={permission.id}>{permission.name}<span>{permission.granted === true ? "Granted" : permission.granted === false ? "Missing" : "Not checked"}</span></li>)}</ul></details>}
      {disconnect === item.id ? <div className="integration-confirmation"><p id={disconnectPromptId}>Disconnect {item.name}? Assistants using it will lose access.</p><div className="actions"><Button aria-describedby={disconnectPromptId} className="danger" disabled={busy} onClick={() => void act(item.id, "disconnect")}>Disconnect</Button><Button ref={keepConnected} aria-describedby={disconnectPromptId} disabled={busy} onClick={() => setDisconnect("")}>Keep connected</Button></div></div> : <div className="actions">
        {(recommendsCheck ? ["check", "connect"] : ["connect", "check"]).map(operation =>
          operation === "connect" ? item.actions.connect && <Button key={operation} className={recommendsConnect ? "primary" : ""} disabled={busy || !catalog!.canManage || flow?.status === "pending"} onClick={() => { if (item.setup.length) { setEditing(item); setFields(Object.fromEntries(item.setup.filter(field => field.defaultValue !== undefined).map(field => [field.key, field.defaultValue!]))); } else void act(item.id, "connect"); }}>{busy && working === item.id ? "Working…" : item.status === "not_connected" || item.status === "unsupported" ? "Connect" : "Reconnect"}</Button> :
          item.actions.check && <Button key={operation} className={recommendsCheck ? "primary" : ""} disabled={busy} onClick={() => void act(item.id, "check")}>Check connection</Button>)}
        {item.actions.disconnect && <Button ref={node => { if (node) disconnectButtons.current.set(item.id, node); else disconnectButtons.current.delete(item.id); }} disabled={busy || !catalog!.canManage} onClick={() => { returnToDisconnect.current = item.id; setDisconnect(item.id); }}>Disconnect</Button>}
      </div>}
    </article>; })}</div></section>)}
    {catalog && catalog.connections.length === 0 && <p className="muted">Hermes has not reported any connections for this assistant.</p>}
    {catalog?.canManage && <section className="integration-custom"><Button aria-expanded={custom} onClick={() => setCustom(!custom)}><Icon name="plus" size={18} /> Add custom MCP connection</Button>{custom && <form onSubmit={e => {
      e.preventDefault();
      void action.run(async ({ current }) => {
        const next = await write<IntegrationFlow | IntegrationConnection>("/integrations/mcp", { profile, ...mcp, token: mcp.auth === "bearer" ? mcp.token : undefined });
        if (!current()) return;
        if ("kind" in next) acceptFlow(next, mcp.name);
        setMcp({ name: "", url: "", auth: "none", token: "" }); setCustom(false); await refresh();
      }, { onError: cause => actionError(cause) });
    }}><label>Connection name<Input required pattern="[A-Za-z0-9_-]{1,80}" title="Use letters, numbers, underscores, or hyphens, up to 80 characters" value={mcp.name} onChange={e => setMcp({ ...mcp, name: e.target.value })} /></label><label>Server address<Input required type="url" placeholder="https://" value={mcp.url} onChange={e => setMcp({ ...mcp, url: e.target.value })} /></label><label>Sign-in method<NativeSelect value={mcp.auth} onChange={e => setMcp({ ...mcp, auth: e.target.value, token: "" })}><option value="none">No sign-in</option><option value="oauth">Sign in with browser</option><option value="bearer">Access token</option></NativeSelect></label>{mcp.auth === "bearer" && <label>Access token<Input required type="password" autoComplete="off" value={mcp.token} onChange={e => setMcp({ ...mcp, token: e.target.value })} /></label>}<Button type="submit" className="primary" disabled={busy}>Add connection</Button></form>}</section>}
  </div>;
}
