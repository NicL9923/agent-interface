import { useEffect, useState } from "react";
import { write } from "../client-api";
import { useAction } from "../app/use-action";
import { useResource } from "../app/use-resource";
import type { AddVaultLogin, ProfileVault, VaultSourceName } from "../shared/vault";
import { FormMessage } from "./ui/form-message";
import "./vault.css";

function validOrigin(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  } catch { return false; }
}

export function VaultPanel({ botId }: { botId: string }) {
  const [uncertain, setUncertain] = useState(false);
  const [adding, setAdding] = useState(false);
  const [remove, setRemove] = useState<string | null>(null);
  const [unlock, setUnlock] = useState<VaultSourceName | null>(null);
  const [password, setPassword] = useState("");
  const [master, setMaster] = useState("");
  const [form, setForm] = useState<Omit<AddVaultLogin, "password">>({ label: "", origin: "", identifier: "", identifierType: "email" });
  const path = `/bots/${encodeURIComponent(botId)}/vault`;
  const vaultResource = useResource<ProfileVault>(path, {
    errorMessage: () => "Could not load this Hermes profile's logins. Check the connection and reload.",
    onData: () => setUncertain(false),
  });
  const { data: vault, loading } = vaultResource;
  const action = useAction();
  const { busy } = action;
  const error = action.error || vaultResource.error;
  useEffect(() => {
    const clear = () => { setPassword(""); setMaster(""); };
    const hidden = () => { if (document.visibilityState === "hidden") clear(); };
    document.addEventListener("visibilitychange", hidden); window.addEventListener("pagehide", clear);
    return () => { document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", clear); };
  }, []);
  // Reloading is how a person reviews an uncertain change, so it retires that warning.
  function reload() { setPassword(""); setMaster(""); action.setError(""); void vaultResource.reload(); }
  async function mutate(work: () => Promise<unknown>, success: string) {
    if (loading || uncertain) return;
    setPassword(""); setMaster("");
    await action.run(work, {
      success,
      onSuccess: () => { setRemove(null); setUnlock(null); setAdding(false); void vaultResource.reload(); },
      onError: () => {
        setUncertain(true);
        return "Hermes could not confirm this change. Reload and review the saved entries before trying again. Secret fields have been cleared.";
      },
    });
  }
  const disabled = busy || loading || uncertain;
  return <section className="vault-panel">
    <div className="vault-heading"><h2>Passwords &amp; logins</h2><button type="button" disabled={disabled} onClick={() => {
      if (!adding) setForm({ label: "", origin: "", identifier: "", identifierType: "email" });
      setAdding(!adding); setPassword(""); setMaster(""); setUnlock(null);
    }}>Add login</button></div>
    <p className="muted">Manage this assistant's Hermes vault. Passwords stay out of your conversation and draft; usernames and labels are visible metadata.</p>
    {vault && <p className="capability-note"><strong>Profile: {vault.profile}.</strong> {vault.notice}</p>}
    {loading && <p role="status">Loading Hermes vault...</p>}
    {error && <FormMessage tone="error">{error}</FormMessage>}{action.notice && <FormMessage tone="notice">{action.notice}</FormMessage>}
    {adding && <form className="vault-form" autoComplete="off" onSubmit={event => {
      event.preventDefault();
      if (!validOrigin(form.origin)) { action.setError("Enter the website address through the hostname, such as https://example.com."); return; }
      const input = { ...form, password };
      void mutate(() => write(path + "/logins", input), "Login saved in Hermes.");
    }}>
      <label>Label<input required maxLength={200} value={form.label} disabled={disabled} onChange={event => setForm({ ...form, label: event.target.value })} placeholder="Ranch supply account" /></label>
      <label>Website origin<input required type="url" maxLength={2048} value={form.origin} disabled={disabled} onChange={event => setForm({ ...form, origin: event.target.value })} placeholder="https://example.com" /></label>
      <p className="muted">Use the exact website, such as https://example.com, without a page path. Hermes checks the website before filling credentials.</p>
      <label>Identifier type<select value={form.identifierType} disabled={disabled} onChange={event => setForm({ ...form, identifierType: event.target.value as AddVaultLogin["identifierType"] })}>
        <option value="email">Email</option><option value="username">Username</option><option value="phone">Phone</option></select></label>
      <label>Username, email or phone<input required maxLength={1000} autoComplete="off" value={form.identifier} disabled={disabled} onChange={event => setForm({ ...form, identifier: event.target.value })} /></label>
      <label>Password<input required type="password" maxLength={4096} autoComplete="off" autoCorrect="off" spellCheck={false} value={password} disabled={disabled} onChange={event => setPassword(event.target.value)} /></label>
      <div className="actions"><button className="primary" disabled={disabled || !password || !validOrigin(form.origin)}>{busy ? "Saving..." : "Save login"}</button>
        <button type="button" disabled={busy} onClick={() => { setAdding(false); setPassword(""); }}>Cancel</button></div>
    </form>}
    {vault && <><div><h3>Saved logins</h3>{!vault.items.length && <p className="muted">No saved logins in the enabled sources.</p>}
      {vault.items.map(item => <article className="vault-entry" key={item.id}><div className="vault-entry-heading"><h3>{item.label}</h3><small>{item.backend === "local" ? "Hermes vault" : item.backend === "onepassword" ? "1Password" : "Bitwarden"}</small></div>
        <p className="vault-origin">{item.origin}</p><p>{item.identifier}</p>{item.hasOtp && <small>Includes a saved authenticator secret.</small>}
        {item.canRemove && (remove === item.id ? <div className="actions"><span>Remove this login from Hermes?</span><button type="button" className="danger" disabled={disabled}
          onClick={() => void mutate(() => write(path + `/logins/${encodeURIComponent(item.id)}`, {}, "DELETE"), "Login removed from Hermes.")}>Remove login</button>
          <button type="button" disabled={busy} onClick={() => setRemove(null)}>Keep login</button></div> : <button type="button" disabled={disabled} onClick={() => setRemove(item.id)}>Remove...</button>)}
      </article>)}</div>
      <div><h3>Hermes vault sources</h3>{vault.sources.map(source => <div className="vault-source" key={source.name}>
        <div><strong>{source.displayName}</strong><p className="muted">{!source.installed ? "CLI is not installed" : source.name === "local" ? "Available to Hermes in this profile" : !source.enabled ? "Disabled" : source.unlocked ? "Unlocked for this profile" : "Locked"}</p></div>
        <div className="vault-source-actions">{source.canToggle && <label><input type="checkbox" checked={source.enabled} disabled={disabled} onChange={event => {
          const enabled = event.target.checked; void mutate(() => write(path + `/sources/${source.name}`, { enabled }, "PUT"), enabled ? "Vault source enabled." : "Vault source disabled.");
        }} /> Enable</label>}
          {source.canUnlock && <button type="button" disabled={disabled} onClick={() => { setUnlock(source.name); setMaster(""); setPassword(""); setAdding(false); }}>Unlock</button>}
          {source.canLock && <button type="button" disabled={disabled} onClick={() => void mutate(() => write(path + `/sources/${source.name}/lock`, {}), "Vault source locked.")}>Lock</button>}
          {unlock === source.name && <form autoComplete="off" onSubmit={event => { event.preventDefault(); const value = master; void mutate(() => write(path + `/sources/${source.name}/unlock`, { password: value }), "Vault source unlocked for this profile."); }}>
            <label>Master password<input required type="password" autoComplete="off" maxLength={4096} value={master} disabled={disabled} onChange={event => setMaster(event.target.value)} /></label>
            <div className="actions"><button disabled={disabled || !master}>Unlock source</button><button type="button" disabled={busy} onClick={() => { setUnlock(null); setMaster(""); }}>Cancel</button></div>
          </form>}
        </div>
      </div>)}</div></>}
    <button type="button" disabled={busy || loading} onClick={reload}>Reload logins</button>
  </section>;
}
