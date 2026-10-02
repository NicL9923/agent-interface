import { useEffect, useRef, useState } from "react";
import { api, ApiError, write } from "../client-api";
import type { RoutinePreview, RoutineRunReceipt } from "../shared/experience";
import type { Routine } from "../shared/types";
import "./experience.css";
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
      const result = await write<RoutinePreview>("/routines/preview", input);
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
    {error && requested === schedule && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

export function RoutineEnhancements({ routine, userId, disabled, onOpenResults }: { routine: Routine; userId: string; disabled?: boolean; onOpenResults?: () => void }) {
  const key = `agent-interface:routine-trial:${userId}:${routine.id}`;
  const [requestId, setRequestId] = useState(() => { try { return localStorage.getItem(key) || ""; } catch { return ""; } });
  const [receipt, setReceipt] = useState<RoutineRunReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const checking = useRef(false);
  const path = `/routines/${encodeURIComponent(routine.id)}`;
  const canStart = !requestId || receipt?.status === "completed" || receipt?.status === "failed";
  async function check(id: string) {
    if (checking.current) return;
    checking.current = true;
    setBusy(true); setError("");
    try { setReceipt(await api<RoutineRunReceipt>(`${path}/runs/${encodeURIComponent(id)}`)); setMissing(false); }
    catch (e) { setError((e as Error).message); setMissing(e instanceof ApiError && e.status === 404); }
    finally { checking.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (requestId && !receipt && !busy) void check(requestId);
  }, [requestId]);
  useEffect(() => {
    if (receipt?.status !== "accepted" || !requestId || disabled) return;
    const timer = setInterval(() => void check(requestId), 5000);
    return () => clearInterval(timer);
  }, [receipt?.status, requestId, disabled]);
  async function start(retryId?: string) {
    const id = retryId || crypto.randomUUID();
    try { localStorage.setItem(key, id); }
    catch { setError("This browser cannot save a run receipt. Allow local storage before trying a routine."); return; }
    setRequestId(id); setReceipt(null); setBusy(true); setError(""); setMissing(false);
    try { setReceipt(await write<RoutineRunReceipt>(`${path}/run`, { requestId: id })); }
    catch (e) { setError(`${(e as Error).message} Check this run's status before starting another.`); }
    finally { setBusy(false); }
  }
  return <div className="routine-enhancements"><RoutineSchedulePreview botId={routine.botId} schedule={routine.schedule} />
    {onOpenResults ? <button type="button" onClick={onOpenResults}>View results</button> : <a href={`/?bot=${encodeURIComponent(routine.botId)}&routine=${encodeURIComponent(routine.id)}`}>View results</a>}
    <small className="muted">Runs now. Hermes may move the next run or finish a one-time routine. Paused recurring routines stay paused.</small>
    <div className="actions">{canStart ? <button type="button" disabled={busy || disabled} onClick={() => void start()}>{busy ? "Starting..." : "Try once"}</button>
      : <button type="button" disabled={busy || disabled} onClick={() => void check(requestId)}>{busy ? "Checking..." : "Check run status"}</button>}
      {missing && <button type="button" disabled={busy || disabled} onClick={() => void start(requestId)}>Retry the same request</button>}</div>
    {receipt && <p className="routine-run-status" role="status">{receipt.status === "accepted" ? "Trial run started. Hermes will finish it even if you close this screen."
      : receipt.status === "completed" ? "Trial run completed."
      : receipt.status === "failed" ? "Trial run failed."
      : "The run's outcome is unknown. Review its result before starting another."}{receipt.message && ` ${receipt.message}`}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
