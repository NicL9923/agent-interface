import { useEffect, useId, useRef, useState } from "react";
import { ApiError, pollWhileVisible, request } from "../client-api";
import type { RoutinePreview, RoutineRunReceipt } from "../shared/experience";
import type { Routine } from "../shared/types";
import { routineTrialKey } from "../app/storage";
import "./experience.css";
import { FormMessage } from "./ui/form-message";
function runTime(instant: string, timezone: string) {
  try { return new Date(instant).toLocaleString(undefined, { timeZone: timezone }); }
  catch { return `${new Date(instant).toLocaleString(undefined, { timeZone: "UTC" })} UTC`; }
}

export function RoutineSchedulePreview({ botId, schedule, onReady }: { botId: string; schedule: string; onReady?: (schedule: string) => void }) {
  const [preview, setPreview] = useState<RoutinePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = useRef({ botId, schedule }); current.current = { botId, schedule };
  const [requested, setRequested] = useState("");
  async function load() {
    const input = { botId, schedule }; setBusy(true); setError(""); setRequested(schedule);
    try {
      const result = await request("POST /routines/preview", { body: input });
      if (current.current.botId !== input.botId || current.current.schedule !== input.schedule) return;
      setPreview(result); onReady?.(input.schedule);
    } catch (e) { if (current.current.schedule === input.schedule) setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const visible = preview && requested === schedule && preview.botId === botId;
  return <div className="routine-preview-control"><button type="button" disabled={busy || !schedule.trim()} onClick={() => void load()}>{busy ? "Checking schedule..." : "Preview schedule"}</button>
    {visible && <div className="routine-preview"><strong>{preview.kind === "once" ? "Scheduled run" : "Next runs"}</strong><p>Hermes timezone: {preview.timezone}</p>
      <ol>{preview.nextRuns.map(instant => <li key={instant}>{runTime(instant, preview.timezone)}</li>)}</ol>
      <small>The assistant's Hermes profile controls this timezone.</small></div>}
    {error && requested === schedule && <FormMessage tone="error">{error}</FormMessage>}
  </div>;
}

export function RoutineEnhancements({ routine, userId, disabled, onOpenResults }: { routine: Routine; userId: string; disabled?: boolean; onOpenResults?: () => void }) {
  const key = routineTrialKey(userId, routine.id);
  const trialHintId = useId();
  const retryHintId = useId();
  const [requestId, setRequestId] = useState(() => { try { return localStorage.getItem(key) || ""; } catch { return ""; } });
  const [receipt, setReceipt] = useState<RoutineRunReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const checking = useRef(false);

  const canStart = !requestId || receipt?.status === "completed" || receipt?.status === "failed";
  async function check(id: string) {
    if (checking.current) return;
    checking.current = true;
    setBusy(true); setError("");
    try { setReceipt(await request("GET /routines/:id/runs/:requestId", { params: { id: routine.id, requestId: id } })); setMissing(false); }
    catch (e) { setError((e as Error).message); setMissing(e instanceof ApiError && e.status === 404); }
    finally { checking.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (requestId && !receipt && !busy) void check(requestId);
  }, [requestId]);
  useEffect(() => {
    if (receipt?.status !== "accepted" || !requestId || disabled) return;
    return pollWhileVisible(() => void check(requestId), 5000);
  }, [receipt?.status, requestId, disabled]);
  async function start(retryId?: string) {
    const id = retryId || crypto.randomUUID();
    try { localStorage.setItem(key, id); }
    catch { setError("This browser cannot save a run receipt. Allow local storage before trying a routine."); return; }
    setRequestId(id); setReceipt(null); setBusy(true); setError(""); setMissing(false);
    try { setReceipt(await request("POST /routines/:id/run", { params: { id: routine.id }, body: { requestId: id } })); }
    catch (e) { setError(`${(e as Error).message} Check this run's status before starting another.`); }
    finally { setBusy(false); }
  }
  return <div className="routine-enhancements">
    <div className="routine-enhancement-actions">
      {canStart ? <button type="button" aria-describedby={trialHintId} disabled={busy || disabled} onClick={() => void start()}>{busy ? "Starting..." : "Try once"}</button>
        : <button type="button" aria-describedby={trialHintId} disabled={busy || disabled} onClick={() => void check(requestId)}>{busy ? "Checking..." : "Check run status"}</button>}
      {missing && <button type="button" aria-describedby={retryHintId} disabled={busy || disabled} onClick={() => void start(requestId)}>Retry the same request</button>}
      <RoutineSchedulePreview botId={routine.botId} schedule={routine.schedule} />
      {onOpenResults ? <button type="button" onClick={onOpenResults}>View results</button> : <a href={`/?bot=${encodeURIComponent(routine.botId)}&routine=${encodeURIComponent(routine.id)}`}>View results</a>}
    </div>
    <p id={trialHintId} className="routine-trial-note">{canStart ? "Try once runs this routine now. Hermes may move the next run or finish a one-time routine. Paused recurring routines stay paused." : "Check the saved run's status before starting another. Checking does not run it again."}</p>
    {missing && <p id={retryHintId} className="routine-trial-note">Retry sends the saved request again and may run this routine. It uses the same request ID.</p>}
    {receipt && <p className="routine-run-status" role="status">{receipt.status === "accepted" ? "Trial run started. Hermes will finish it even if you close this screen."
      : receipt.status === "completed" ? "Trial run completed."
      : receipt.status === "failed" ? "Trial run failed."
      : "The run's outcome is unknown. Review its result before starting another."}{receipt.message && ` ${receipt.message}`}</p>}
    {error && <FormMessage tone="error">{error}</FormMessage>}
  </div>;
}
