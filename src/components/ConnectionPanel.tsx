import { useState } from "react";
import type { RuntimeStatus } from "../shared/types";
import { Avatar } from "./Avatar";
import { When } from "./When";

const explanations: Record<string, { title: string; detail: string; setup?: boolean }> = {
  not_configured: { title: "Connect your household to Hermes", detail: "Set up the connection once on the computer running this app. Your existing assistants will appear here automatically.", setup: true },
  invalid_config: { title: "The connection needs a small correction", detail: "The saved Hermes address or token is incomplete. Run setup on the computer hosting this app to correct it.", setup: true },
  unauthorized: { title: "Hermes didn't accept the connection", detail: "The saved connection token needs to be updated. Your conversations are still with Hermes.", setup: true },
  addon_missing: { title: "Hermes is reachable. One step remains.", detail: "This installation needs the compatible connection add-on before it can safely send messages or recover work.", setup: true },
  incompatible: { title: "Hermes and this app need matching versions", detail: "Run the connection check on the app's computer for the required version and update instructions.", setup: true },
  connecting: { title: "Connecting to Hermes", detail: "Checking the connection and restoring your assistants." },
  reconnecting: { title: "Reconnecting to Hermes", detail: "Your draft is kept. Existing work stays with Hermes, and messages won't be resent automatically." },
  unreachable: { title: "Hermes is temporarily unavailable", detail: "Your draft is kept. We'll reconnect automatically when Hermes is reachable again." },
  closed: { title: "The connection is restarting", detail: "Your draft is kept. We'll reconnect automatically." },
};

export function SetupCommand() {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return <div className="setup-command">
    <code>npm run setup</code>
    <button type="button" onClick={async () => {
      setCopied(false); setFailed(false);
      try {
        await navigator.clipboard.writeText("npm run setup");
        setCopied(true); setFailed(false);
      } catch { setFailed(true); }
    }}>{copied ? "Copied" : "Copy command"}</button>
    {failed && <span role="status">Select the command to copy it.</span>}
  </div>;
}

export function ConnectionPanel({ connection, offline = false, appUnavailable = false, busy, retry, compact = false }: {
  connection: RuntimeStatus;
  offline?: boolean;
  appUnavailable?: boolean;
  busy: boolean;
  retry: () => void;
  compact?: boolean;
}) {
  const copy = offline ? { title: "You're offline", detail: "Your draft is kept on this device. We'll reconnect when you're back online." }
    : appUnavailable ? { title: "Reconnecting to the app", detail: "Your conversation stays here and your draft is kept. We'll check again automatically." }
    : explanations[connection.code || "unreachable"] || explanations.unreachable!;
  return <section className={compact ? "connection-panel compact" : "connection-panel setup"} aria-label="Hermes connection">
    {!compact && <Avatar size={84} state="disconnected" />}
    <div className="connection-copy">
      {!compact && <p className="eyebrow">Your household workspace</p>}
      <h2>{copy.title}</h2>
      <p role="status">{copy.detail}</p>
      {!compact && copy.setup && <>
        <ol className="setup-steps">
          <li><span aria-hidden="true">✓</span><div><strong>You're signed in</strong><small>Your household account is ready.</small></div></li>
          <li><span aria-hidden="true">2</span><div><strong>Connect the app to Hermes</strong><small>Guided setup checks the address, access and compatibility before saving.</small></div></li>
          <li><span aria-hidden="true">3</span><div><strong>Pick up with your assistants</strong><small>Their existing conversations stay in Hermes.</small></div></li>
        </ol>
      </>}
      <div className="connection-actions">
        <button className={!compact ? "primary" : ""} disabled={busy || offline} onClick={retry}>
          {busy ? "Checking connection…" : copy.setup ? "Check connection" : "Reconnect now"}
        </button>
      </div>
      <details className="connection-help">
        <summary>{copy.setup ? "Set up this installation" : "Connection details"}</summary>
        {connection.address && <p>Hermes address: <code>{connection.address}</code></p>}
        {connection.detail && <p>{connection.detail}</p>}
        {connection.lastConnectedAt && <p>Last connected <When value={connection.lastConnectedAt} inline />.</p>}
        {copy.setup && <>
          <p>On the computer running Agent Interface, open its project folder and run:</p>
          <SetupCommand />
          <p>Setup keeps the connection token on that computer. Restart this app after saving; everyone else can simply sign in.</p>
        </>}
        <p>For a read-only connection check on that computer, run <code>npm run doctor</code>.</p>
      </details>
    </div>
  </section>;
}
