import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, write } from "../client-api";
import type { Bot } from "../shared/types";
import type { UpgradePhase, UpgradeRevision, UpgradeStatus, UpgradeControlAction } from "../shared/upgrades";
import "./hermes-upgrade.css";
import { Icon } from "./Icon";
import { When } from "./When";

const runningPhases: UpgradePhase[] = ["checking", "qualifying", "installing", "verifying", "recovering"];
const titles: Record<UpgradePhase, string> = {
  idle: "Keep Hermes feeling at home",
  checking: "Looking for an update",
  qualifying: "Checking this update",
  ready: "Ready when you are",
  installing: "Updating Hermes",
  verifying: "Making sure everything works",
  succeeded: "Hermes is up to date",
  blocked: "One thing needs attention",
  failed: "The update couldn't finish",
  rolled_back: "The previous version is restored",
  recovering: "Restoring the connection",
  cancelled: "The update was cancelled",
};

function revisionLabel(revision?: UpgradeRevision) {
  if (!revision) return "Not available yet";
  return revision.version || revision.revision.slice(0, 10);
}

export function HermesUpgradePanel({ open, onClose, bots, currentVersion }: {
  open: boolean;
  onClose: () => void;
  bots: Bot[];
  currentVersion?: string;
}) {
  const [status, setStatus] = useState<UpgradeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<UpgradeControlAction | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const requestBusy = useRef(false);
  const mounted = useRef(true);
  const active = !!status && runningPhases.includes(status.phase);
  const poll = open || active || uncertain;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (previous?.isConnected && !previous.closest("[inert]")) previous.focus();
      else (document.querySelector<HTMLButtonElement>(".bot-rail:not([inert]) [aria-label='Settings']")
        ?? document.querySelector<HTMLButtonElement>("[aria-label='Back to assistants']"))?.focus();
    };
  }, [open]);

  const refresh = useCallback(async () => {
    if (requestBusy.current) return;
    if (navigator.onLine === false) {
      setError("You're offline. We'll check the update status when you're connected again.");
      return;
    }
    requestBusy.current = true;
    setLoading(true);
    try {
      const next = await api<UpgradeStatus>("/hermes/upgrade");
      if (!mounted.current) return;
      setStatus(next);
      setError("");
      setUncertain(false);
    } catch {
      if (mounted.current) setError("Can't reach the update service. We'll keep checking its status.");
    } finally {
      requestBusy.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!poll) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    const wake = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [poll, refresh]);

  const act = async (install: boolean) => {
    if (requestBusy.current || !status || uncertain || submitting || active) return;
    if (install ? !status.canInstall || !status.candidate : !status.canCheck) return;
    requestBusy.current = true;
    setSubmitting(true);
    setError("");
    try {
      const next = await write<UpgradeStatus>(`/hermes/upgrade/${install ? "install" : "check"}`,
        install ? { candidateRevision: status.candidate!.revision, requestId: crypto.randomUUID() } : {});
      if (mounted.current) setStatus(next);
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError && cause.status < 500) setError(cause.message);
      else {
        setUncertain(true);
        setError("The connection dropped before we could confirm the request. Checking the update status…");
      }
    } finally {
      requestBusy.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  const control = async (action: UpgradeControlAction) => {
    if (requestBusy.current || !status?.operationId || submitting || uncertain || loading) return;
    const permitted = action === "retry" ? status.canRetry : action === "cancel" ? status.canCancel : status.canRestartService;
    if (!permitted) return;
    requestBusy.current = true;
    setSubmitting(true);
    setConfirmation(null);
    setError("");
    try {
      const next = await write<UpgradeStatus>("/hermes/upgrade/control", {
        action, operationId: status.operationId, requestId: crypto.randomUUID(),
      });
      if (mounted.current) setStatus(next);
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError && cause.status < 500) setError(cause.message);
      else {
        setUncertain(true);
        setError("The recovery request may have reached Hermes. Checking its status before you try again…");
      }
    } finally {
      requestBusy.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  const install = !!status?.canInstall && !!status.candidate;
  const disabled = submitting || uncertain || active || loading || !status || !(install ? status.canInstall : status.canCheck);
  const label = submitting ? install ? "Starting update…" : "Starting checks…"
    : uncertain ? "Checking update status…"
    : active ? status!.phase === "checking" || status!.phase === "qualifying" ? "Checking update…" : "Updating Hermes…"
    : install ? "Upgrade Hermes" : "Check for updates";
  const busyNames = status?.busyBots.map(id => bots.find(bot => bot.id === id)?.name || id) || [];
  const failed = status && ["failed", "rolled_back", "blocked"].includes(status.phase);
  return <dialog ref={dialog} className="hermes-upgrade-panel" aria-labelledby="hermes-upgrade-title"
    onCancel={onClose} onClose={onClose}>
    <header className="upgrade-header">
      <p className="eyebrow">Hermes updates</p>
      <button className="icon-button" aria-label="Close Hermes updates" onClick={onClose}><Icon name="close" /></button>
    </header>
    <div className={`upgrade-mark ${active || submitting || uncertain ? "is-working" : ""} ${failed ? "needs-attention" : ""}`} aria-hidden="true">
      <Icon size={28} name={status?.phase === "succeeded" ? "check" : status?.phase === "rolled_back" ? "undo" : "upgrade"} />
    </div>
    <h2 id="hermes-upgrade-title">{status ? titles[status.phase] : "A little care for Hermes"}</h2>
    <p className="upgrade-description" role="status">
      {status?.message || (loading ? "Getting the current version and update status…" : "Check for an update and verify it before upgrading your household.")}
    </p>
    <dl className="upgrade-versions">
      <div><dt>Running now</dt><dd>{status?.current ? revisionLabel(status.current) : currentVersion || "Checking…"}</dd></div>
      {status?.candidate && <div><dt>{status.phase === "ready" ? "Checked update" : "Update"}</dt><dd>{revisionLabel(status.candidate)}</dd></div>}
    </dl>
    {busyNames.length > 0 && <p className="upgrade-work-block">Finish active work before upgrading: <strong>{busyNames.join(", ")}</strong>.</p>}
    {error && <p className="upgrade-error" role="alert">{error}</p>}
    <div className="upgrade-action">
      <button className="primary" disabled={disabled} onClick={() => void act(install)}>{label}</button>
      <p>{active || uncertain ? "You can close this window. We'll keep checking progress."
        : install ? "This briefly reconnects Hermes. Your conversations and drafts stay saved."
        : "Checking never installs an update."}</p>
      {!status && error && <button disabled={loading} onClick={() => void refresh()}>Try again</button>}
    </div>
    {status && (status.canRetry || status.canCancel || status.canRestartService) && <section className="upgrade-recovery" aria-label="Update recovery">
      <h3>{active ? "Need to stop this update?" : "Get back on track"}</h3>
      <p>{active ? "Cancellation waits for a safe stopping point and checks the previous version."
        : "Recovery checks the connection before assistants can work again."}</p>
      {confirmation ? <div className="upgrade-confirmation" role="group" aria-label="Confirm update recovery">
        <p>{confirmation === "cancel" ? "Cancel this update and restore a working version?"
          : "Restart the Hermes service and check the connection? This may briefly disconnect everyone."}</p>
        <div className="actions">
          <button disabled={submitting || uncertain || loading} onClick={() => void control(confirmation)}>
            {confirmation === "cancel" ? "Yes, cancel update" : "Yes, restart Hermes"}
          </button>
          <button onClick={() => setConfirmation(null)}>Keep current state</button>
        </div>
      </div> : <div className="actions">
        {status.canRetry && <button disabled={submitting || uncertain || loading} onClick={() => void control("retry")}>Retry update</button>}
        {status.canRestartService && <button disabled={submitting || uncertain || loading} onClick={() => setConfirmation("restart_service")}>Restart Hermes</button>}
        {status.canCancel && <button disabled={submitting || uncertain || loading} onClick={() => setConfirmation("cancel")}>Cancel update</button>}
      </div>}
    </section>}
    {!!status?.checks.length && <details className="upgrade-checks">
      <summary>Update checks <span>{status.checks.filter(check => check.status === "passed").length} of {status.checks.length} passed</span></summary>
      <ol>{status.checks.map(check => <li key={check.id} data-check-status={check.status}>
        <span className="upgrade-check-icon" aria-hidden="true">{check.status === "passed" ? "✓" : check.status === "failed" ? "!" : check.status === "running" ? "◌" : "·"}</span>
        <div><strong>{check.label}</strong><small>{check.status === "passed" ? "Passed" : check.status === "failed" ? "Failed" : check.status === "running" ? "Running" : "Waiting"}{check.detail ? ` · ${check.detail}` : ""}</small></div>
      </li>)}</ol>
      {status.error && <p className="upgrade-checked-at">Update reference: <code>{status.error}</code></p>}
    </details>}
    {status?.checkedAt && <p className="upgrade-checked-at">Last checked <When value={status.checkedAt} inline /></p>}
  </dialog>;
}
