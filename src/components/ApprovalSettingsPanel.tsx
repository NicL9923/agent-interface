import { useRef, useState } from "react";
import { request } from "../client-api";
import { routeUrl } from "../shared/api";
import { useAction } from "../app/use-action";
import { useResource } from "../app/use-resource";
import type { ApprovalSettings } from "../shared/types";
import { Button } from "./ui/button";
import { FormMessage } from "./ui/form-message";
import { SettingsConfirmation } from "./SettingsConfirmation";
import "./automation.css";

/**
 * The reverse of "Always allow": the command patterns Hermes runs for this assistant without asking,
 * each with Remove, and Hermes's own review of routine commands. Hidden from an older add-on.
 */
export function ApprovalSettingsPanel({ botId, name }: { botId: string; name: string }) {
  const resource = useResource<ApprovalSettings>(routeUrl("GET /bots/:id/approval-settings", { id: botId }), {
    load: (_, signal) => request("GET /bots/:id/approval-settings", { params: { id: botId }, signal }),
    errorMessage: () => "Could not load this assistant's always-allowed commands. Check the connection and reload.",
  });
  const action = useAction();
  const [enabling, setEnabling] = useState(false);
  const toggle = useRef<HTMLInputElement>(null);
  const settings = resource.data;
  if (settings && !settings.supported) return null;
  const disabled = action.busy || resource.loading || !settings;
  const apply = (work: () => Promise<ApprovalSettings>, success: string) => void action.run(work, {
    success, onSuccess: value => { resource.setData(value); setEnabling(false); },
  });
  const remove = (pattern: string) => apply(() => request("DELETE /bots/:id/approval-settings/allowlist", { params: { id: botId }, body: { pattern } }),
    `Removed “${pattern}”. Hermes will ask again next time.`);
  const review = (autoReview: boolean) => apply(() => request("PUT /bots/:id/approval-settings", { params: { id: botId }, body: { autoReview } }),
    autoReview ? "Hermes now reviews routine commands itself." : "Hermes now asks before every flagged command.");
  return <div className="automation-panel approval-settings">
    <h2 id="settings-approvals-heading">Always-allowed commands</h2>
    <p className="muted">{name} runs these kinds of commands without asking, in every conversation. Each one is a kind Hermes flags, so it covers more than the command you first allowed.</p>
    {settings && (settings.allowlist.length
      ? <ul className="approval-allowlist" aria-labelledby="settings-approvals-heading">{settings.allowlist.map(pattern => <li key={pattern}>
        <span>{pattern}</span>
        <Button type="button" disabled={disabled} aria-label={`Remove ${pattern}`} onClick={() => remove(pattern)}>Remove</Button>
      </li>)}</ul>
      : <p className="muted">Nothing yet. Choose Always allow on an approval to add one.</p>)}
    {settings && settings.allowlist.length > 0 && <p className="capability-note">Removing one takes effect at {name}'s next command in this app. A chat already running in another Hermes app, such as Discord, keeps it until that chat ends.</p>}
    {settings && <section className="automation-section">
      <h3>Auto-review</h3>
      <label className="automation-check">
        <input ref={toggle} type="checkbox" checked={settings.mode === "smart"} disabled={disabled || !settings.canManageAutoReview || settings.mode === "off"}
          onChange={event => { if (event.target.checked) setEnabling(true); else review(false); }} />
        Auto-review routine commands
      </label>
      <p className="muted">Hermes checks each flagged command first and runs the ones it judges safe without asking. Anything it doubts still comes to you, and only for once.</p>
      {settings.mode === "off" && <p className="capability-note">Hermes doesn't ask before commands for this assistant. Change that in Hermes.</p>}
      {settings.mode !== "off" && !settings.canManageAutoReview && <p className="capability-note">Only an integration administrator can change auto-review.</p>}
    </section>}
    {(action.error || resource.error) && <FormMessage tone="error">{action.error || resource.error}</FormMessage>}
    {action.notice && <FormMessage tone="notice">{action.notice}</FormMessage>}
    {enabling && <SettingsConfirmation title="Let Hermes approve routine commands?" confirmLabel="Turn on auto-review" cancelLabel="Keep asking me"
      detail={`Hermes will run commands it judges safe for ${name} without asking you. You'll still be asked about anything it doubts.`}
      busy={action.busy} fallbackFocus={toggle} onCancel={() => setEnabling(false)} onConfirm={() => review(true)} />}
  </div>;
}
