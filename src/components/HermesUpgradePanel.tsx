import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, write } from "../client-api";
import type { Bot } from "../shared/types";
import type { UpgradePhase, UpgradeRevision, UpgradeStatus, UpgradeControlAction } from "../shared/upgrades";
import "./hermes-upgrade.css";
import { Icon } from "./Icon";
import { When } from "./When";

const runningPhases: UpgradePhase[] = ["checking", "qualifying", "installing", "verifying", "recovering"];
const installPhases: UpgradePhase[] = ["installing", "verifying", "recovering", "rolled_back"];
type Operation = "check" | "install";
// Checks find and test an update in a separate copy; only Install changes Hermes.
function title(status: UpgradeStatus, operation: Operation) {
  switch (status.phase) {
    case "idle": return status.checkedAt && !status.candidate ? "Hermes is up to date" : "Hermes updates";
    case "checking": return "Looking for an update";
    case "qualifying": return "Testing the update";
    case "ready": return "Update tested and ready";
    case "installing": return "Installing the update";
    case "verifying": return "Making sure everything works";
    case "succeeded": return operation === "install" ? "Hermes is up to date" : "Hermes is ready";
    case "blocked": return operation === "install" ? "The update was stopped safely" : "This update needs a look";
    case "failed": return operation === "install" ? "The update couldn't finish" : "The check didn't finish";
    case "rolled_back": return "The previous version is restored";
    case "recovering": return "Restoring the connection";
    case "cancelled": return operation === "install" ? "The update was cancelled" : "Check stopped";
  }
}
type StepState = "waiting" | "active" | "done" | "failed";
function steps(status: UpgradeStatus, operation: Operation): [string, StepState][] {
  const { phase, candidate } = status;
  const stopped = ["blocked", "failed", "cancelled"].includes(phase);
  const find: StepState = phase === "checking" && !candidate ? "active" : candidate ? "done" : stopped && operation === "check" ? "failed" : "waiting";
  const test: StepState = phase === "qualifying" || phase === "checking" && candidate ? "active"
    : ["ready", "installing", "verifying", "recovering", "rolled_back"].includes(phase) || phase === "succeeded" && operation === "install" || operation === "install" ? "done"
    : stopped && candidate ? "failed" : "waiting";
  const install: StepState = ["installing", "verifying", "recovering"].includes(phase) ? "active"
    : phase === "succeeded" && operation === "install" ? "done"
    : operation === "install" && (stopped || phase === "rolled_back") ? "failed" : "waiting";
  return [["Find", find], ["Test in a copy", test], ["Install", install]];
}

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
  // Polls and actions are separate: a click during a poll must not be dropped, and a
  // poll that started before a click must not overwrite the click's fresher status.
  const pollBusy = useRef(false);
  const actionBusy = useRef(false);
  const generation = useRef(0);
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
    // Start at the title, so the close button is not pre-selected.
    element?.querySelector<HTMLElement>("#hermes-upgrade-title")?.focus();
    return () => {
      element?.close();
      if (previous?.isConnected && !previous.closest("[inert]")) previous.focus();
      else (document.querySelector<HTMLButtonElement>(".bot-rail:not([inert]) [aria-label='Settings']")
        ?? document.querySelector<HTMLButtonElement>("[aria-label='Back to assistants']"))?.focus();
    };
  }, [open]);

  const refresh = useCallback(async () => {
    if (pollBusy.current) return;
    if (navigator.onLine === false) {
      setError("You're offline. We'll check the update status when you're connected again.");
      return;
    }
    pollBusy.current = true;
    setLoading(true);
    const started = generation.current;
    try {
      const next = await api<UpgradeStatus>("/hermes/upgrade");
      if (!mounted.current || generation.current !== started) return;
      setStatus(next);
      setError("");
      setUncertain(false);
    } catch {
      if (mounted.current) setError("Can't reach the update service. We'll keep checking its status.");
    } finally {
      pollBusy.current = false;
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
    if (actionBusy.current || !status || uncertain || submitting || active) return;
    if (install ? !status.canInstall || !status.candidate : !status.canCheck) return;
    actionBusy.current = true;
    generation.current++;
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
      actionBusy.current = false;
      generation.current++;
      if (mounted.current) setSubmitting(false);
    }
  };

  const control = async (action: UpgradeControlAction) => {
    if (actionBusy.current || !status?.operationId || submitting || uncertain) return;
    const permitted = action === "retry" ? status.canRetry : action === "cancel" ? status.canCancel : status.canRestartService;
    if (!permitted) return;
    actionBusy.current = true;
    generation.current++;
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
      actionBusy.current = false;
      generation.current++;
      if (mounted.current) setSubmitting(false);
    }
  };

  const install = !!status?.canInstall && !!status.candidate;
  const operation: Operation = status?.operation ?? (status && installPhases.includes(status.phase) ? "install" : "check");
  // Background polls never disable controls; only the first load and real requests do.
  const settling = submitting || uncertain || !status && loading;
  const disabled = settling || active || !status || !(install ? status.canInstall : status.canCheck);
  const stopped = !!status && ["blocked", "failed", "cancelled"].includes(status.phase);
  const upToDate = status?.phase === "idle" && !!status.checkedAt && !status.candidate;
  const label = submitting ? install ? "Starting the install…" : "Starting the check…"
    : uncertain ? "Checking update status…"
    : active ? operation === "install" ? "Installing…" : "Testing…"
    : install ? "Install update" : stopped && operation === "check" ? "Check again" : "Check for an update";
  const busyNames = status?.busyBots.map(id => bots.find(bot => bot.id === id)?.name || id) || [];
  const failed = status && ["failed", "rolled_back", "blocked"].includes(status.phase);
  // A check's own retry is just "Check again"; recovery actions belong to installs.
  const recovery = !!status && (operation === "install" && (status.canRetry || status.canCancel) || status.canRestartService);
  return <dialog ref={dialog} className="hermes-upgrade-panel" aria-labelledby="hermes-upgrade-title"
    onCancel={onClose} onClose={onClose}>
    <header className="upgrade-header">
      <p className="eyebrow">Hermes updates</p>
      <button className="icon-button" aria-label="Close Hermes updates" onClick={onClose}><Icon name="close" /></button>
    </header>
    <div className={`upgrade-mark ${active || submitting || uncertain ? "is-working" : ""} ${failed ? "needs-attention" : ""}`} aria-hidden="true">
      <Icon size={28} name={status?.phase === "succeeded" ? "check" : status?.phase === "rolled_back" ? "undo" : "upgrade"} />
    </div>
    <h2 id="hermes-upgrade-title" tabIndex={-1}>{status ? title(status, operation) : "Hermes updates"}</h2>
    <p className="upgrade-description" role="status">
      {upToDate ? "You're running the newest Hermes." : status?.message || (loading ? "Getting the current version and update status…" : "Find the newest Hermes and test it before installing it.")}
    </p>
    {status && status.phase !== "idle" && <ol className="upgrade-steps" aria-label="Update steps">
      {steps(status, operation).map(([name, state]) => <li key={name} data-step={state}>
        <span className="upgrade-step-dot" aria-hidden="true">{state === "done" ? <Icon name="check" size={14} /> : state === "failed" ? "!" : ""}</span>
        <span>{name}<span className="sr-only">: {state === "done" ? "done" : state === "active" ? "in progress" : state === "failed" ? "stopped" : "not started"}</span></span>
      </li>)}
    </ol>}
    <dl className="upgrade-versions">
      <div><dt>Running now</dt><dd>{status?.current ? revisionLabel(status.current) : currentVersion || "Checking…"}</dd></div>
      {status?.candidate && <div><dt>{status.phase === "ready" ? "Checked update" : "Update"}</dt><dd>{revisionLabel(status.candidate)}</dd></div>}
    </dl>
    {busyNames.length > 0 && <p className="upgrade-work-block">Finish active work before upgrading: <strong>{busyNames.join(", ")}</strong>.</p>}
    {error && <p className="upgrade-error" role="alert">{error}</p>}
    <div className="upgrade-action">
      <button className="primary" disabled={disabled} onClick={() => void act(install)}>
        {(active || submitting) && <Icon name="spinner" className="spin" size={16} />}{label}
      </button>
      <p>{active || uncertain ? "You can close this. Progress continues on the server."
        : install ? "Installing briefly reconnects Hermes. Conversations and drafts stay saved."
        : "A check finds the newest Hermes and tests it in a separate copy. Nothing is installed until you choose Install."}</p>
      {active && operation === "check" && status?.canCancel && <button type="button" className="upgrade-stop" disabled={settling}
        onClick={() => void control("cancel")}>Stop checking</button>}
      {!status && error && <button disabled={loading} onClick={() => void refresh()}>Try again</button>}
    </div>
    {status && recovery && <section className="upgrade-recovery" aria-label="Update recovery">
      <h3>{active ? "Need to stop this update?" : "Get back on track"}</h3>
      <p>{active ? "Cancellation waits for a safe stopping point and checks the previous version."
        : "Recovery checks the connection before assistants can work again."}</p>
      {confirmation ? <div className="upgrade-confirmation" role="group" aria-label="Confirm update recovery">
        <p>{confirmation === "cancel" ? "Cancel this update and restore a working version?"
          : "Restart the Hermes service and check the connection? This may briefly disconnect everyone."}</p>
        <div className="actions">
          <button disabled={settling} onClick={() => void control(confirmation)}>
            {confirmation === "cancel" ? "Yes, cancel update" : "Yes, restart Hermes"}
          </button>
          <button onClick={() => setConfirmation(null)}>Keep current state</button>
        </div>
      </div> : <div className="actions">
        {status.canRetry && operation === "install" && <button disabled={settling} onClick={() => void control("retry")}>Check and try again</button>}
        {status.canRestartService && <button disabled={settling} onClick={() => setConfirmation("restart_service")}>Restart Hermes</button>}
        {status.canCancel && operation === "install" && <button disabled={settling} onClick={() => setConfirmation("cancel")}>Cancel update</button>}
      </div>}
    </section>}
    {!!status?.checks.length && <details className="upgrade-checks" open={stopped || undefined}>
      <summary>Test details <span>{status.checks.filter(check => check.status === "passed").length} of {status.checks.length} passed</span></summary>
      <ol>{status.checks.map(check => <li key={check.id} data-check-status={check.status}>
        <span className="upgrade-check-icon" aria-hidden="true">{check.status === "passed" ? "✓" : check.status === "failed" ? "!" : check.status === "running" ? "◌" : "·"}</span>
        <div><strong>{check.label}</strong><small>{check.status === "passed" ? "Passed" : check.status === "failed" ? "Failed" : check.status === "running" ? "Running" : "Waiting"}{check.detail ? ` · ${check.detail}` : ""}</small></div>
      </li>)}</ol>
      {status.error && <p className="upgrade-checked-at">Update reference: <code>{status.error}</code></p>}
    </details>}
    {status?.checkedAt && <p className="upgrade-checked-at">Last checked <When value={status.checkedAt} inline /></p>}
  </dialog>;
}
