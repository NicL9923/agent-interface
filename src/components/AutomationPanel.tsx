import { Fragment, useEffect, useId, useRef, useState } from "react";
import { ApiError, request } from "../client-api";
import { useAction } from "../app/use-action";
import { routeUrl } from "../shared/api";
import { useResource } from "../app/use-resource";
import { goalResumeKey } from "../app/storage";
import type { Bot, Routine } from "../shared/types";
import type { AutomationOverview, AutomationTask, EventSubscription, SkillContent, SkillDiff, TaskInput, TriggerInput } from "../shared/automation";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { SettingsConfirmation } from "./SettingsConfirmation";
import "./automation.css";

function useAutomation(botId: string) {
  const path = routeUrl("GET /bots/:id/automation", { id: botId });
  const action = useAction();
  const [uncertain, setUncertain] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  // A status someone loaded answers "Refresh status before trying again", so it retires that warning.
  const overview = useResource(path, { load: (_, signal) => request("GET /bots/:id/automation", { params: { id: botId }, signal }), onData: () => { setUncertain(false); action.setError(""); } });
  const { data: value, loading } = overview;
  const change = <T,>(send: () => Promise<T>, onRefused?: () => void, successNotice = "Saved in Hermes."): Promise<T | undefined> => {
    if (uncertain || loading) return Promise.resolve(undefined);
    return action.run(async ({ current }) => {
      let result: T;
      try { result = await send(); }
      catch (cause) {
        if (!current()) throw cause;
        if (cause instanceof ApiError && cause.status < 500) onRefused?.();
        const unknown = !(cause instanceof ApiError) || cause.status >= 500;
        setUncertain(unknown || cause instanceof ApiError && cause.status === 409);
        throw unknown ? new Error("We couldn't confirm this change. Refresh status and review it before trying again. Nothing will be sent again automatically.") : cause;
      }
      if (!current()) return result;
      const resume = (result as AutomationOverview | undefined)?.goals?.resume;
      if (resume?.status === "uncertain") {
        setUncertain(true); action.setError("The goal's start is uncertain. Refresh status and review the conversation before trying again.");
        return result;
      }
      let next: AutomationOverview;
      try { next = await request("GET /bots/:id/automation", { params: { id: botId } }); }
      catch {
        if (current()) { setUncertain(true); action.setError("The change was accepted, but status could not refresh. Refresh status before making another change."); }
        return result;
      }
      if (!current()) return result;
      // Fresher than any load still running, which is dropped.
      overview.setData(next);
      if (resume?.status === "rejected") action.setError(resume.message || "Hermes refused to start this goal. Review its status before resuming.");
      else action.setNotice(successNotice);
      return result;
    });
  };
  const changeTask = <T,>(send: () => Promise<T>): Promise<{ kind: "saved" | "refused"; message: string; overview: AutomationOverview; result?: T } | undefined> => {
    if (uncertain || loading) return Promise.resolve(undefined);
    return action.run(async ({ current }) => {
      let refusal = "";
      let result: T | undefined;
      try { result = await send(); }
      catch (cause) {
        if (!current()) throw cause;
        if (cause instanceof ApiError && cause.status < 500) refusal = cause.message;
        else {
          setUncertain(true);
          throw new Error("We couldn't confirm this change. Refresh status and review it before trying again. Nothing will be sent again automatically.");
        }
      }
      if (!current()) return undefined;
      let next: AutomationOverview;
      try { next = await request("GET /bots/:id/automation", { params: { id: botId } }); }
      catch {
        if (current()) { setUncertain(true); action.setError("The change could not be confirmed because status could not refresh. Refresh status before making another change."); }
        return undefined;
      }
      if (!current()) return undefined;
      overview.setData(next);
      return { kind: refusal ? "refused" as const : "saved" as const, message: refusal, overview: next, result };
    });
  };
  const refresh = () => { setRefreshCount(count => count + 1); return overview.reload(); };
  return { value: value ?? undefined, botId, change, changeTask, refresh, refreshCount, busy: action.busy, disabled: action.busy || loading || uncertain, loading,
    error: action.error || overview.error, notice: action.notice, clearNotice: () => action.setNotice(""), uncertain };
}
type Controls = ReturnType<typeof useAutomation>;

function Status({ control, work = false }: { control: Controls; work?: boolean }) {
  const receipt = work ? control.value?.goals.resume : undefined;
  const rejectedMessage = receipt?.status === "rejected" ? receipt.message || "Hermes refused to start this goal. Review its status before resuming." : undefined;
  const receiptAnnounced = !!rejectedMessage && control.error === rejectedMessage;
  const receiptAnnouncement = receipt?.status === "rejected" ? rejectedMessage : receipt?.status === "uncertain"
    ? receipt.message || "Hermes could not confirm this goal continuation. Review the conversation before trying again." : "";
  const receiptKey = receipt ? `${receipt.requestId}:${receipt.status}` : "";
  const [resultKey, setResultKey] = useState("");
  if (receiptAnnounced && resultKey !== receiptKey) setResultKey(receiptKey);
  const statusText = receiptAnnounced || receiptKey === resultKey ? "" : receiptAnnouncement;
  return <><div className="automation-toolbar"><span className="muted">Managed by Hermes</span><Button disabled={control.loading || control.busy} onClick={() => void control.refresh()}>{control.loading ? "Refreshing..." : "Refresh status"}</Button></div>
    {work && <><p className="sr-only" role="status" aria-label="Resume status" aria-live="polite" aria-atomic="true">{statusText}</p>
      <p className="sr-only" role="status" aria-label="Resume result" aria-live="polite" aria-atomic="true">{receiptAnnounced ? control.error : ""}</p></>}
    {control.error && !receiptAnnounced && <p className="form-error" role="alert">{control.error}</p>}
    {control.notice && <p className="form-notice" role="status">{control.notice}</p>}
    {!control.value && control.loading && <p role="status">Loading assistant controls...</p>}</>;
}

export function AutomationPanel({ botId, bots, accountScope }: { botId: string; bots: Bot[]; accountScope?: string }) {
  const control = useAutomation(botId);
  return <div className="automation-panel automation-work"><h2>Goals, tasks & triggers</h2>
    <p className="muted">Give this assistant work, track its tasks, or run a routine when an event arrives.</p>
    <Status control={control} work />
    {control.value && <><GoalSection control={control} intentKey={accountScope ? goalResumeKey(accountScope, botId) : undefined} /><TaskSection control={control} bots={bots} botId={botId} /><TriggerSection control={control} botId={botId} /></>}
  </div>;
}

function GoalSection({ control, intentKey }: { control: Controls; intentKey?: string }) {
  const state = control.value!.goals;
  const goalId = useId();
  const [title, setTitle] = useState("");
  const [maxTurns, setMaxTurns] = useState(20);
  const [editing, setEditing] = useState(false);
  const [clear, setClear] = useState(false);
  const replaceOpener = useRef<HTMLButtonElement>(null);
  const clearOpener = useRef<HTMLButtonElement>(null);
  const setOpener = useRef<HTMLButtonElement>(null);
  const [returnFocus, setReturnFocus] = useState<"replace" | "clear" | "set" | null>(null);
  const [resumeId, setResumeId] = useState(() => {
    try { const saved = intentKey && localStorage.getItem(intentKey); if (saved && /^[a-f0-9-]{36}$/i.test(saved)) return saved; } catch { /* In-memory retries still share one intent. */ }
    return crypto.randomUUID();
  });
  const [reviewed, setReviewed] = useState(false);
  const [reviewedNewAttempt, setReviewedNewAttempt] = useState(false);
  const [replacementConfirmed, setReplacementConfirmed] = useState(false);
  const freshIntent = () => { setResumeId(crypto.randomUUID()); if (intentKey) try { localStorage.removeItem(intentKey); } catch {} };
  useEffect(() => {
    if (state.resume?.requestId === resumeId && state.resume.status !== "uncertain") freshIntent();
  }, [state.resume?.requestId, state.resume?.status, resumeId, intentKey]);
  const goal = state.goal;
  useEffect(() => {
    if (!returnFocus || editing || clear || control.disabled) return;
    const opener = goal ? (returnFocus === "clear" ? clearOpener.current : replaceOpener.current) : setOpener.current;
    if (opener) { opener.focus(); setReturnFocus(null); }
  }, [returnFocus, editing, clear, control.disabled, goal]);
  const statusLabels: Record<string, string> = { active: "Active", paused: "Paused", done: "Done" };
  const receipt = state.resume;
  const receiptVisible = receipt?.status === "uncertain" || receipt?.status === "rejected";
  const resumeDisabled = !goal || control.disabled || editing || clear || !["active", "paused"].includes(goal.status) || goal.status !== "active" && (receipt?.status === "uncertain" || !!state.interruptionPending && !reviewed);
  const descriptionIds = [state.interruptionPending ? `${goalId}-interruption` : "", receipt?.status === "uncertain" ? `${goalId}-receipt` : ""].filter(Boolean).join(" ");
  return <section className="automation-section automation-goal"><h3>Standing goal</h3>
    {!state.supported ? <p className="capability-note">{state.reason || "Goals are unavailable on this Hermes installation."}</p> : <>
      {goal ? <div className="automation-goal-card">
        <p className="automation-goal-title">{goal.title}</p>
        <p className="automation-goal-meta"><span className={`automation-goal-status${goal.status === "active" ? " is-active" : ""}`}>{Object.hasOwn(statusLabels, goal.status) ? statusLabels[goal.status] : goal.status}</span><span>{goal.turnsUsed} of {goal.maxTurns} turns used</span></p>
        {goal.pausedReason && <p className="automation-goal-reason">{goal.status === "paused" ? "Paused: " : ""}{goal.pausedReason}</p>}
        {receiptVisible && <div id={`${goalId}-receipt`} className={`automation-goal-callout${receipt?.status === "rejected" ? " is-danger" : ""}`}>
          <strong>{receipt?.status === "uncertain" ? "Resume not confirmed" : "Resume rejected"}</strong>
          <p>{receipt?.message || (receipt?.status === "uncertain" ? "Hermes could not confirm this goal continuation. Review the conversation before trying again." : "Hermes refused to start this goal. Review its status before resuming.")}</p>
        </div>}
        {state.interruptionPending && <div id={`${goalId}-interruption`} className="automation-confirm automation-goal-callout"><p>Review the interrupted work in this assistant's conversation before resuming.</p><label className="automation-check"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />I've reviewed the interrupted work in this conversation.</label></div>}
        {receipt?.status === "uncertain" && <div className="automation-confirm automation-goal-attempt"><p>The previous attempt may have started work. Refresh status and review this assistant's conversation before starting again.</p>
          <label className="automation-check"><input type="checkbox" checked={reviewedNewAttempt} onChange={event => setReviewedNewAttempt(event.target.checked)} />I've reviewed the conversation and want to start a new attempt.</label>
          <Button className={!control.disabled && !editing && !clear && reviewedNewAttempt && goal.status === "paused" ? "primary" : undefined} disabled={control.disabled || editing || clear || !reviewedNewAttempt || goal.status !== "paused"} onClick={async () => {
            const requestId = crypto.randomUUID(); setResumeId(requestId);
            if (intentKey) try { localStorage.setItem(intentKey, requestId); } catch {}
            const result = await control.change(() => request("POST /bots/:id/automation/goal/resume", { params: { id: control.botId }, body: { requestId, reviewedInterruption: true } }), freshIntent);
            setReviewedNewAttempt(false);
            if (result && result.goals.resume?.status !== "uncertain") { freshIntent(); setReviewed(false); }
          }}>Start a new attempt</Button>
        </div>}
        <div className="actions automation-goal-actions">
          {goal.status !== "done" && <Button className={!resumeDisabled ? "primary" : undefined} disabled={resumeDisabled} aria-describedby={descriptionIds || undefined} onClick={async () => {
            const active = goal.status === "active";
            if (!active && intentKey) try { localStorage.setItem(intentKey, resumeId); } catch {}
            const result = await control.change(() => active
              ? request("POST /bots/:id/automation/goal/pause", { params: { id: control.botId }, body: {} })
              : request("POST /bots/:id/automation/goal/resume", { params: { id: control.botId }, body: { requestId: resumeId, ...(state.interruptionPending && reviewed ? { reviewedInterruption: true } : {}) } }), active ? undefined : freshIntent);
            if (!active && result?.goals.resume?.status !== "uncertain" && result) { freshIntent(); setReviewed(false); }
          }}>{goal.status === "active" ? "Pause goal" : "Resume goal"}</Button>}
          <Button ref={replaceOpener} disabled={control.disabled || editing || clear} onClick={() => { setTitle(goal.title); setMaxTurns(goal.maxTurns); setReplacementConfirmed(false); setEditing(true); }}>Replace goal…</Button>
          <Button ref={clearOpener} className="danger automation-goal-clear" disabled={control.disabled || editing || clear} onClick={() => setClear(true)}>Clear goal…</Button>
        </div>
        {clear && <div className="automation-confirm"><p>Clear this standing goal? The conversation stays saved.</p><div className="actions"><Button autoFocus onClick={() => { setClear(false); setReturnFocus("clear"); }}>Keep goal</Button><Button className="danger" disabled={control.disabled} onClick={async () => { if (await control.change(() => request("POST /bots/:id/automation/goal/clear", { params: { id: control.botId }, body: {} }))) { setClear(false); setReturnFocus("clear"); } }}>Clear goal</Button></div></div>}
      </div> : <p className="muted">No standing goal. A goal keeps working across turns until it finishes, pauses, or reaches its budget.</p>}
      {!editing && !goal && <Button ref={setOpener} className="primary" onClick={() => setEditing(true)} disabled={control.disabled}>Set a goal</Button>}
      {editing && <form className="automation-form" onSubmit={async event => { event.preventDefault(); if (goal && !replacementConfirmed) return; if (await control.change(() => request("PUT /bots/:id/automation/goal", { params: { id: control.botId }, body: { title, maxTurns } }))) { setEditing(false); setReturnFocus(goal ? "replace" : "set"); freshIntent(); setReviewed(false); setReviewedNewAttempt(false); } }}>
        <label>Objective<textarea autoFocus required maxLength={10000} rows={3} placeholder="What should the assistant work toward?" value={title} onChange={event => setTitle(event.target.value)} disabled={control.disabled} /></label>
        <label>Continuation turn budget<Input required type="number" min={1} max={1000} value={maxTurns} onChange={event => setMaxTurns(Number(event.target.value))} disabled={control.disabled} /></label>
        <p className="muted">Saves paused. Resume it when you're ready for the assistant to work.</p>
        {goal && <div className="automation-confirm"><p>Replacing this goal resets its progress and removes its native subgoals, completion contracts and verification gates. The conversation stays saved.</p><label className="automation-check"><input type="checkbox" checked={replacementConfirmed} onChange={event => setReplacementConfirmed(event.target.checked)} />Replace the entire standing goal.</label></div>}
        <div className="actions"><Button type="submit" className="primary" disabled={control.disabled || !title.trim() || !!goal && !replacementConfirmed}>{goal ? "Replace with paused goal" : "Save paused goal"}</Button><Button disabled={control.disabled} onClick={() => { setEditing(false); setReturnFocus(goal ? "replace" : "set"); }}>Cancel</Button></div>
      </form>}
    </>}
  </section>;
}

function TaskSection({ control, bots, botId }: { control: Controls; bots: Bot[]; botId: string }) {
  const state = control.value!.tasks;
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const createOpener = useRef<HTMLButtonElement>(null);
  const createMessage = useRef<HTMLParagraphElement>(null);
  const focusedCreateNotice = useRef("");
  const [attempt, setAttempt] = useState<{ knownIds: string[]; title: string; requestId: string; refreshCount: number; unconfirmed: boolean } | null>(null);
  const [createFeedback, setCreateFeedback] = useState("");
  const [draft, setDraft] = useState<TaskInput>({ requestId: crypto.randomUUID(), title: "", body: "", assignee: botId, priority: 0, dependencies: [] });
  const [openTask, setOpenTaskState] = useState<string | null>(null);
  const openTaskRef = useRef<string | null>(null);
  const setOpenTask = (id: string | null) => { openTaskRef.current = id; setOpenTaskState(id); };
  const [feedback, setFeedback] = useState<Record<string, TaskFeedback>>({});
  const [collapsed, setCollapsed] = useState<string[]>(["done"]);
  const [focusTask, setFocusTask] = useState<string | null>(null);
  const summaries = useRef<Record<string, HTMLElement | null>>({});
  const taskHeading = useRef<HTMLHeadingElement>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => { setFeedback({}); setAnnouncement(""); }, [control.refreshCount]);
  useEffect(() => {
    if (!focusTask) return;
    const summary = summaries.current[focusTask];
    const result = summary?.parentElement?.querySelector<HTMLElement>(".automation-task-feedback");
    const target = result ?? summary ?? taskHeading.current;
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: "nearest" });
    }
    setFocusTask(null);
  }, [focusTask, control.value]);
  const runTask = async (task: AutomationTask, send: () => Promise<unknown>, moved = false, edit = false) => {
    setFeedback(previous => { const next = { ...previous }; delete next[task.id]; return next; });
    setAnnouncement("");
    const result = await control.changeTask(send);
    if (!result) {
      setFeedback(previous => ({ ...previous, [task.id]: { kind: "uncertain", source: edit ? "edit" : moved ? "move" : "dependency", title: task.title, message: "Not confirmed. Use Refresh status at the top of Work." } }));
      return false;
    }
    const updated = result.overview.tasks.items.find(item => item.id === task.id);
    const message = result.kind === "refused" ? `${result.message} Status refreshed.` : moved && updated ? `Moved to ${taskStatusLabel(updated.status)}.` : "Saved in Hermes.";
    setFeedback(previous => ({ ...previous, [task.id]: { kind: result.kind, source: edit ? "edit" : moved ? "move" : "dependency", title: task.title, message } }));
    setAnnouncement(message);
    if (openTaskRef.current === task.id) {
      if (updated) setCollapsed(previous => previous.filter(status => status !== updated.status));
      setFocusTask(task.id);
    }
    return result.kind === "saved";
  };
  const likely = attempt && control.refreshCount > attempt.refreshCount && !control.disabled ? likelyCreatedTask(attempt.knownIds, attempt.title, state.items) : undefined;
  const reviewedAttempt = !!attempt && control.refreshCount > attempt.refreshCount && !control.disabled;
  const resend = reviewedAttempt && !likely && attempt?.requestId === draft.requestId;
  const unconfirmed = !!(control.uncertain && attempt?.unconfirmed);
  useEffect(() => {
    if (reviewedAttempt && attempt?.unconfirmed) setAttempt(previous => previous && { ...previous, unconfirmed: false });
  }, [reviewedAttempt, attempt?.unconfirmed]);
  useEffect(() => {
    const phase = unconfirmed ? "unconfirmed" : likely ? `match:${likely.id}` : resend ? "no-match" : null;
    if (!creating || !phase || !attempt || !createMessage.current) return;
    const reviewVersion = unconfirmed ? attempt.refreshCount : control.refreshCount;
    const key = JSON.stringify([attempt.requestId, reviewVersion, phase]);
    if (focusedCreateNotice.current === key) return;
    focusedCreateNotice.current = key;
    createMessage.current.focus();
    if (likely || resend) setAnnouncement(createMessage.current.textContent || "");
  }, [creating, unconfirmed, likely, resend, attempt, control.refreshCount]);
  const resetCreate = () => { setCreating(false); setAttempt(null); setCreateFeedback(""); setDraft({ requestId: crypto.randomUUID(), title: "", body: "", assignee: botId, priority: 0, dependencies: [] }); };
  const revealCreated = (task: AutomationTask, message: string) => { setOpenTask(task.id); setCollapsed(previous => previous.filter(status => status !== task.status)); setFeedback(previous => ({ ...previous, [task.id]: { kind: "saved", source: "edit", title: task.title, message } })); setAnnouncement(message); setFocusTask(task.id); };
  const statuses = [...new Set(state.items.map(task => task.status))].sort(compareTaskStatuses);
  const editDraft = (change: Partial<TaskInput>) => setDraft(previous => ({ ...previous, ...change, requestId: crypto.randomUUID() }));
  return <section className="automation-section automation-tasks"><h3 ref={taskHeading} tabIndex={-1}>Task board</h3>
    <p className="sr-only" role="status" aria-label="Task result" aria-live="polite" aria-atomic="true">{announcement}</p>
    {Object.entries(feedback).filter(([id]) => !state.items.some(task => task.id === id)).map(([id, item]) => <p key={id} className={`automation-task-feedback ${taskFeedbackStyle(item)}`}>{item.title}: {item.message}</p>)}
    {!state.supported ? <p className="capability-note">{state.reason || "Task boards are unavailable on this Hermes installation."}</p> : <>
      <p className="muted">Tasks belong to this assistant. Assign work to a teammate, add dependencies, and request review.</p>
      {state.truncated && <p className="capability-note" role="status">Showing the newest {state.limit || 100} visible tasks. Older tasks remain in Hermes.</p>}
      {!state.items.length && <p>No tasks yet.</p>}
      {statuses.map(status => <div className="automation-task-group" key={status}>
        <h4><button type="button" className="automation-task-group-toggle" aria-expanded={!collapsed.includes(status)} onClick={() => setCollapsed(previous => previous.includes(status) ? previous.filter(item => item !== status) : [...previous, status])}>{taskStatusLabel(status)} · {state.items.filter(task => task.status === status).length}</button></h4>
        {!collapsed.includes(status) && state.items.filter(task => task.status === status).map(task => <TaskCard key={task.id} task={task} control={control} bots={bots} open={openTask === task.id} feedback={feedback[task.id]} runTask={runTask} summaryRef={node => { summaries.current[task.id] = node; }} onToggle={() => { if (openTask === task.id) { setOpenTask(null); setFeedback(previous => { const next = { ...previous }; delete next[task.id]; return next; }); setAnnouncement(""); } else { if (openTask) setFeedback(previous => { const next = { ...previous }; delete next[openTask]; return next; }); setAnnouncement(""); setOpenTask(task.id); } }} />)}
      </div>)}
      {!creating ? <Button ref={createOpener} disabled={control.disabled} onClick={() => setCreating(true)}>New task</Button> : <form className="automation-form" aria-labelledby="new-task-heading" onSubmit={async event => {
        event.preventDefault();
        const snapshot = { knownIds: state.items.map(item => item.id), title: draft.title.trim(), requestId: draft.requestId, refreshCount: control.refreshCount, unconfirmed: false };
        setAttempt(snapshot); setCreateFeedback("");
        setSubmitting(true);
        try {
          const result = await control.changeTask(() => request("POST /bots/:id/automation/tasks", { params: { id: botId }, body: { ...draft, dependencies: draft.dependencies || [] } }));
          if (!result) {
            setAttempt(previous => previous?.requestId === snapshot.requestId ? { ...previous, unconfirmed: true } : previous);
            return;
          }
          if (result.kind === "refused") { setAttempt(null); setCreateFeedback(result.message + " Status refreshed."); return; }
          const created = result.overview.tasks.items.find(item => item.id === result.result?.id) ?? likelyCreatedTask(snapshot.knownIds, snapshot.title, result.overview.tasks.items);
          resetCreate();
          if (created) revealCreated(created, `Created. "${created.title}" stays blocked until you start it.`);
          else { setAnnouncement("Created in Hermes. Refresh status to review the task."); requestAnimationFrame(() => createOpener.current?.focus()); }
        } finally { setSubmitting(false); }
      }}>
        <h4 id="new-task-heading">New task</h4>
        <label>Task title<Input autoFocus required maxLength={500} value={draft.title} disabled={control.disabled || !!likely} onChange={event => editDraft({ title: event.target.value })} /></label>
        <label>Instructions (optional)<textarea rows={3} maxLength={20000} value={draft.body} disabled={control.disabled || !!likely} onChange={event => editDraft({ body: event.target.value })} /></label>
        <label>Assigned assistant<NativeSelect value={draft.assignee || ""} disabled={control.disabled || !!likely} onChange={event => editDraft({ assignee: event.target.value || null })}><option value="">Unassigned</option>{bots.map(bot => <option value={bot.id} key={bot.id}>{bot.name}</option>)}</NativeSelect></label>
        <label>Priority<Input type="number" min={-100} max={100} value={draft.priority} disabled={control.disabled || !!likely} onChange={event => editDraft({ priority: Number(event.target.value) })} /></label>
        {state.items.length > 0 && <fieldset disabled={control.disabled || !!likely}><legend>Wait for these tasks (optional)</legend><div className={state.items.length > 6 ? "automation-task-choices is-bounded" : "automation-task-choices"}>{state.items.filter(task => task.id !== likely?.id).map(task => <label className="automation-check" key={task.id}><input type="checkbox" checked={draft.dependencies?.includes(task.id) || false} disabled={!draft.dependencies?.includes(task.id) && (draft.dependencies?.length || 0) >= 20} onChange={event => editDraft({ dependencies: event.target.checked ? [...draft.dependencies || [], task.id] : draft.dependencies?.filter(id => id !== task.id) })} /><span>{task.title} <span className="muted">· {taskStatusLabel(task.status)}</span></span></label>)}</div></fieldset>}
        <p className="muted">Creates a blocked task. Start it explicitly when the instructions are ready.</p>
        {(unconfirmed || likely) && <p ref={createMessage} tabIndex={-1} className="automation-task-callout">{likely ? "A task with this title appeared on the board. Hermes may have saved it. Close this form to review it." : "Not confirmed. Hermes may have created this task. Use Refresh status at the top of Work before trying again."}</p>}
        {resend && <p ref={createMessage} tabIndex={-1}>No new task with this title is visible. Create task sends the same request again.</p>}
        {createFeedback && <p className="form-error" role="alert">{createFeedback}</p>}
        <div className="actions">{likely ? <Button className="primary" onClick={() => { resetCreate(); revealCreated(likely, `"${likely.title}" appeared on the board. Hermes may have saved it.`); }}>Close</Button> : <><Button type="submit" className="primary" disabled={control.disabled || !draft.title.trim()}>{submitting ? "Creating…" : "Create task"}</Button><Button disabled={control.disabled} onClick={() => { setCreating(false); setAttempt(null); setCreateFeedback(""); requestAnimationFrame(() => createOpener.current?.focus()); }}>Cancel</Button></>}</div>
      </form>}
    </>}
  </section>;
}

const taskStatusOrder = ["blocked", "running", "review", "ready", "todo", "scheduled", "triage"];
const taskStatusLabels: Record<string, string> = { blocked: "Blocked", running: "Running", review: "In review", ready: "Ready", todo: "To do", scheduled: "Scheduled", triage: "Triage", done: "Done" };
function taskStatusLabel(status: string) {
  return Object.hasOwn(taskStatusLabels, status) ? taskStatusLabels[status] : status.replace(/_/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}
function compareTaskStatuses(a: string, b: string) {
  const rank = (status: string) => status === "done" ? taskStatusOrder.length + 1 : taskStatusOrder.includes(status) ? taskStatusOrder.indexOf(status) : taskStatusOrder.length;
  return rank(a) - rank(b) || taskStatusLabel(a).localeCompare(taskStatusLabel(b));
}

export function likelyCreatedTask(knownIds: readonly string[], title: string, items: AutomationTask[]) {
  return items.find(item => !knownIds.includes(item.id) && item.title === title);
}

type TaskFeedback = { kind: "saved" | "refused" | "uncertain"; source: "move" | "dependency" | "edit"; title: string; message: string };
function taskFeedbackStyle(feedback: Pick<TaskFeedback, "kind">) { return feedback.kind === "refused" ? "form-error" : feedback.kind === "uncertain" ? "automation-task-uncertain" : "form-notice"; }
function TaskCard({ task, control, bots, open, feedback, runTask, summaryRef, onToggle }: { task: AutomationTask; control: Controls; bots: Bot[]; open: boolean; feedback?: TaskFeedback; runTask: (task: AutomationTask, send: () => Promise<unknown>, moved?: boolean, edit?: boolean) => Promise<boolean>; summaryRef: (node: HTMLElement | null) => void; onToggle: () => void }) {
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body);
  const [assignee, setAssignee] = useState(task.assignee || "");
  const [priority, setPriority] = useState(task.priority);
  const [reason, setReason] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [form, setForm] = useState<"block" | "review" | null>(null);
  const editOpener = useRef<HTMLButtonElement>(null);
  const blockOpener = useRef<HTMLButtonElement>(null);
  const reviewOpener = useRef<HTMLButtonElement>(null);
  const cancelForm = () => { const opener = form === "block" ? blockOpener : reviewOpener; setForm(null); setReason(""); opener.current?.focus(); };
  const [dependency, setDependency] = useState("");
  const params = { id: control.botId, taskId: task.id };
  const running = task.status === "running";
  useEffect(() => { if (running) setEditing(false); }, [running]);
  const resultNotice = feedback && <p tabIndex={-1} className={`automation-task-feedback ${feedback.source === "edit" ? "automation-task-feedback--edit " : ""}${taskFeedbackStyle(feedback)}`}>{feedback.message}</p>;
  const name = bots.find(bot => bot.id === task.assignee)?.name || task.assignee || "Unassigned";
  const action = async (actionName: "start" | "block" | "request_review") => {
    const payload = { action: actionName, ...(reason.trim() && (actionName !== "start" || !form) ? { reason } : {}), ...(actionName === "request_review" && reviewer ? { reviewer } : {}) };
    if (await runTask(task, () => request("POST /bots/:id/automation/tasks/:taskId/actions", { params, body: payload }), true)) { setForm(null); setReason(""); setReviewer(""); }
  };
  return <details className="automation-item automation-task" data-task-id={task.id} open={open}>
    <summary ref={summaryRef} onClick={event => { event.preventDefault(); onToggle(); }}><span>{task.title}</span><small>{name}{task.priority !== 0 && ` · Priority ${task.priority}`}</small></summary>
    <div className="automation-task-detail">
      <p className="automation-task-meta"><span className="automation-task-status">{taskStatusLabel(task.status)}</span><span>{name}</span>{task.priority !== 0 && <span>Priority {task.priority}</span>}</p>
      <p className="preserve-lines">{task.body || "No additional instructions."}</p>
      {task.blockedReason && <div className="automation-task-callout"><strong>Blocked</strong><p>{task.blockedReason}</p></div>}
      {!running && (editing ? <form className="automation-form" aria-labelledby={`edit-task-${task.id}`} onSubmit={async event => { event.preventDefault(); setSubmitting(true); try { if (await runTask(task, () => request("PATCH /bots/:id/automation/tasks/:taskId", { params, body: { title, body, priority, assignee: assignee || null } }), false, true)) setEditing(false); } finally { setSubmitting(false); } }}>
        <h4 id={`edit-task-${task.id}`}>Edit task</h4>
        <label>Task title<Input autoFocus required value={title} maxLength={500} disabled={control.disabled} onChange={event => setTitle(event.target.value)} /></label>
        <label>Instructions (optional)<textarea value={body} maxLength={20000} rows={3} disabled={control.disabled} onChange={event => setBody(event.target.value)} /></label>
        <label>Assigned assistant<NativeSelect value={assignee} disabled={control.disabled} onChange={event => setAssignee(event.target.value)}><option value="">Unassigned</option>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</NativeSelect></label>
        <label>Priority<Input type="number" min={-100} max={100} value={priority} disabled={control.disabled} onChange={event => setPriority(Number(event.target.value))} /></label>
        <div className="actions"><Button type="submit" className="primary" disabled={control.disabled || !title.trim()}>{submitting ? "Saving…" : "Save task"}</Button><Button disabled={control.disabled} onClick={() => { setEditing(false); requestAnimationFrame(() => editOpener.current?.focus()); }}>Cancel</Button></div>
      </form> : <Button ref={editOpener} disabled={control.disabled} onClick={() => { setTitle(task.title); setBody(task.body); setPriority(task.priority); setAssignee(task.assignee || ""); setEditing(true); }}>Edit task</Button>)}
      {!running && feedback?.source === "edit" && resultNotice}
      <section className="automation-task-dependencies"><h5>Dependencies</h5>
        {!task.dependencies.length && <p className="muted">None.</p>}
        {task.dependencies.map(id => { const parent = control.value!.tasks.items.find(item => item.id === id); return <div className="automation-dependency" key={id}><span>{parent ? `${parent.title} · ${taskStatusLabel(parent.status)}` : id}</span>{!running && <Button aria-label={`Remove dependency on ${parent?.title || id}`} disabled={control.disabled} onClick={() => void runTask(task, () => request("PUT /bots/:id/automation/tasks/:taskId/dependencies/:dependencyId", { params: { ...params, dependencyId: id }, body: { remove: true } }))}>Remove dependency</Button>}</div>; })}
        {!running && <div className="automation-task-add"><label>Wait for task<NativeSelect value={dependency} disabled={control.disabled} onChange={event => setDependency(event.target.value)}><option value="">Choose a task</option>{control.value!.tasks.items.filter(item => item.id !== task.id && !task.dependencies.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</NativeSelect></label><Button disabled={control.disabled || !dependency} onClick={async () => { if (await runTask(task, () => request("PUT /bots/:id/automation/tasks/:taskId/dependencies/:dependencyId", { params: { ...params, dependencyId: dependency }, body: { remove: false } }))) setDependency(""); }}>Add dependency</Button></div>}
        {feedback?.source === "dependency" && resultNotice}
      </section>
      <section className="automation-task-move"><h5>Move task</h5>
        {running ? <p>A Hermes worker is running this task. You can change it after the run finishes.</p> : <>
          <div className="actions"><Button className={task.status === "blocked" || task.status === "todo" ? "primary" : undefined} disabled={control.disabled} onClick={() => void action("start")}>Start task</Button><Button ref={blockOpener} aria-expanded={form === "block"} disabled={control.disabled} onClick={() => { setForm("block"); setReason(""); }}>Block task…</Button><Button ref={reviewOpener} aria-expanded={form === "review"} disabled={control.disabled} onClick={() => { setForm("review"); setReason(""); }}>Request review…</Button></div>
          {feedback?.source === "move" && resultNotice}
          {form === "block" && <div className="automation-form"><label>What is blocking this task?<Input value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} disabled={control.disabled} /></label><div className="actions"><Button disabled={control.disabled || !reason.trim()} onClick={() => void action("block")}>Block task</Button><Button disabled={control.disabled} onClick={cancelForm}>Cancel</Button></div></div>}
          {form === "review" && <div className="automation-form"><label>Reviewer<NativeSelect value={reviewer} onChange={event => setReviewer(event.target.value)} disabled={control.disabled}><option value="">Choose one</option>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</NativeSelect></label><label>Notes for the reviewer (optional)<Input value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} disabled={control.disabled} /></label><div className="actions"><Button disabled={control.disabled || !reviewer} onClick={() => void action("request_review")}>Request review</Button><Button disabled={control.disabled} onClick={cancelForm}>Cancel</Button></div></div>}
          {!form && <details className="automation-task-note"><summary>Add an optional start note</summary><label>Start note<Input value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} disabled={control.disabled} /></label></details>}
          {task.status === "review" && <p className="muted">The reviewing assistant can request changes through Hermes while it owns the review.</p>}
          <p className="muted">Hermes checks the task's current state and dependencies before changing it.</p>
        </>}
        {running && feedback?.source !== "dependency" && resultNotice}
      </section>
    </div>
  </details>;
}

export function likelyCreatedTrigger(knownIds: string[], draftId: string, items: EventSubscription[]) {
  return knownIds.includes(draftId) ? undefined : items.find(item => item.id === draftId);
}

function TriggerSection({ control, botId }: { control: Controls; botId: string }) {
  const state = control.value!.triggers;
  const canManage = control.value!.canManageTriggers === true;
  const routineList = useResource(state.supported ? routeUrl("GET /routines", {}) : null, { load: (_, signal) => request("GET /routines", { signal }) });
  const routines = routineList.data?.filter(row => row.botId === botId) ?? [];
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EventSubscription>();
  const [draft, setDraft] = useState<TriggerInput>({ id: "", description: "", events: [], routineId: "" });
  const [events, setEvents] = useState("");
  const [secret, setSecret] = useState<{ id: string; url: string; secret: string }>();
  const [reveal, setReveal] = useState(false);
  const [seen, setSeen] = useState(false);
  const [copyResult, setCopyResult] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState("");
  const [feedback, setFeedback] = useState<Record<string, { message: string; kind: "saved" | "refused" | "uncertain" }>>({});
  const [announcement, setAnnouncement] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [attempt, setAttempt] = useState<{ knownIds: string[]; payload: TriggerInput; refreshCount: number }>();
  const [createRefusal, setCreateRefusal] = useState<{ id: string; message: string }>();
  const [focus, setFocus] = useState("");
  const section = useRef<HTMLElement>(null);
  const createOpener = useRef<HTMLButtonElement>(null);
  const secretHeading = useRef<HTMLHeadingElement>(null);
  const secretPanel = useRef<HTMLDivElement>(null);
  const createMessage = useRef<HTMLParagraphElement>(null);
  const focusedPhase = useRef("");
  const id = useId();
  const reviewed = !!attempt && control.refreshCount > attempt.refreshCount && !control.disabled;
  const likely = reviewed && attempt ? likelyCreatedTrigger(attempt.knownIds, attempt.payload.id, state.items) : undefined;
  const unconfirmed = !!attempt && control.uncertain;
  const stale = editing && state.items.find(item => item.id === editing.id);
  const staleMessage = editing && (!stale ? "This trigger is no longer in Hermes." : stale.revision !== editing.revision ? "This trigger changed. Close this editor and review its current settings before editing again." : "");
  useEffect(() => {
    if (!focus) return;
    const target = focus === "secret" ? secretHeading.current : focus === "create-opener" ? createOpener.current : focus === "create-feedback" ? section.current?.querySelector<HTMLElement>("form .automation-trigger-feedback") : focus.startsWith("edit-opener:") ? Array.from(section.current?.querySelectorAll<HTMLElement>("[data-trigger-id]") ?? []).find(row => row.dataset.triggerId === focus.slice(12))?.querySelector<HTMLElement>(".trigger-edit-opener") : Array.from(section.current?.querySelectorAll<HTMLElement>("[data-trigger-id]") ?? []).find(row => row.dataset.triggerId === focus)?.querySelector<HTMLElement>(".automation-trigger-feedback") ?? Array.from(section.current?.querySelectorAll<HTMLElement>(".automation-trigger-removed") ?? []).find(row => row.dataset.triggerId === focus);
    if (focus === "secret") { secretPanel.current?.scrollIntoView?.({ block: "start" }); target?.focus({ preventScroll: true }); }
    else target?.focus();
    setFocus("");
  }, [focus, control.value, secret]);
  useEffect(() => {
    const phase = unconfirmed ? "unconfirmed" : likely ? `match:${likely.id}` : reviewed ? "missing" : "";
    if (!creating || !phase || !createMessage.current) return;
    const key = `${attempt?.refreshCount}:${control.refreshCount}:${phase}`;
    if (focusedPhase.current === key) return;
    focusedPhase.current = key;
    createMessage.current.focus(); setAnnouncement(createMessage.current.textContent || "");
  }, [creating, unconfirmed, likely, reviewed, attempt, control.refreshCount]);
  const publish = (triggerId: string, message: string, kind: "saved" | "refused" | "uncertain" = "saved") => { setFeedback(previous => ({ ...previous, [triggerId]: { message, kind } })); setAnnouncement(message); setFocus(triggerId); };
  useEffect(() => {
    if (!staleMessage) return;
    const target = section.current?.querySelector<HTMLElement>("form .automation-trigger-feedback");
    target?.focus(); setAnnouncement(staleMessage);
  }, [staleMessage]);
  const clearFeedback = (triggerId: string) => {
    if (feedback[triggerId]?.message === announcement) setAnnouncement("");
    setFeedback(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== triggerId)));
  };
  const clearCreateRefusal = () => {
    if (createRefusal?.message === announcement) setAnnouncement("");
    setCreateRefusal(undefined);
  };
  const run = async (triggerId: string, send: () => Promise<unknown>, success: string) => {
    const result = await control.changeTask(send);
    const message = !result ? "Not confirmed. Use Refresh status at the top of Work." : result.kind === "refused" ? `${result.message} Status refreshed.` : success;
    publish(triggerId, message, !result ? "uncertain" : result.kind);
    return result?.kind === "saved";
  };
  const copy = async (kind: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopyResult(previous => ({ ...previous, [kind]: "Copied." })); if (kind === "secret") setSeen(true); }
    catch { setCopyResult(previous => ({ ...previous, [kind]: "Couldn't copy. Try again." })); }
  };
  const form = (edit?: EventSubscription) => <form className="automation-form" aria-labelledby={`${id}-heading`} onSubmit={async event => {
    event.preventDefault();
    if (control.disabled || likely || staleMessage) return;
    const payload = reviewed && attempt ? attempt.payload : { ...draft, events: events.split(",").map(value => value.trim()).filter(Boolean) };
    if (!edit) clearCreateRefusal();
    if (!edit) setAttempt({ knownIds: state.items.map(item => item.id), payload, refreshCount: control.refreshCount });
    setSubmitting(true);
    let created: { subscription: EventSubscription; secret?: string } | undefined;
    const result = await control.changeTask(async () => {
      if (edit) return request("PUT /bots/:id/automation/triggers/:triggerId", { params: { id: botId, triggerId: edit.id }, body: { description: payload.description, events: payload.events, routineId: payload.routineId, revision: edit.revision } });
      created = await request("POST /bots/:id/automation/triggers", { params: { id: botId }, body: payload });
      return created;
    });
    setSubmitting(false);
    if (created?.secret) {
      setAttempt(undefined); setCreating(false); setSecret({ id: created.subscription.id, url: created.subscription.url, secret: created.secret }); setReveal(false); setSeen(false); setCopyResult({});
      setAnnouncement(`${created.subscription.id} was created. Save its signing secret now.`); setFocus("secret");
      return;
    }
    if (!result) { if (edit) publish(edit.id, "Not confirmed. Use Refresh status at the top of Work.", "uncertain"); return; }
    if (result.kind === "refused") {
      const message = `${result.message} Status refreshed.`;
      if (edit) {
        const refreshed = result.overview.triggers.items.find(item => item.id === edit.id);
        if (!refreshed || refreshed.revision !== edit.revision) clearFeedback(edit.id);
        else publish(edit.id, message, "refused");
      }
      else { setAttempt(undefined); setCreateRefusal({ id: payload.id, message }); setAnnouncement(message); setFocus("create-feedback"); }
      return;
    }
    setAttempt(undefined);
    if (edit) { setEditing(undefined); publish(edit.id, "Saved in Hermes."); }
  }}>
    <h4 id={`${id}-heading`}>{edit ? "Edit trigger" : "New event trigger"}</h4>
    {edit ? <p>Trigger ID: {edit.id}</p> : <div className="automation-trigger-field"><label htmlFor={`${id}-trigger-id`}>Trigger ID</label><Input id={`${id}-trigger-id`} autoFocus required pattern="[a-z0-9][a-z0-9_-]{0,79}" maxLength={80} aria-describedby={`${id}-id-hint`} value={draft.id} disabled={control.disabled || !!likely || reviewed} onChange={event => { clearCreateRefusal(); setDraft({ ...draft, id: event.target.value }); }} /><p id={`${id}-id-hint`} className="muted">Use lowercase letters, numbers, underscores or hyphens. Start with a letter or number, up to 80 characters.</p></div>}
    <div className="automation-trigger-field"><label htmlFor={`${id}-description`}>Description (optional)</label><textarea id={`${id}-description`} autoFocus={!!edit} rows={2} maxLength={1000} value={draft.description} disabled={control.disabled || !!likely || reviewed} onChange={event => setDraft({ ...draft, description: event.target.value })} /></div>
    <div className="automation-trigger-field"><label htmlFor={`${id}-events`}>Event names</label><Input id={`${id}-events`} required aria-describedby={`${id}-events-hint`} value={events} disabled={control.disabled || !!likely || reviewed} onChange={event => setEvents(event.target.value)} placeholder="alert.created" /><p id={`${id}-events-hint`} className="muted">Separate names with commas. Up to 20. Use letters, numbers, underscores, periods, asterisks, colons or hyphens.</p></div>
    <label>Routine<NativeSelect required value={draft.routineId} disabled={control.disabled || !!likely || reviewed} onChange={event => setDraft({ ...draft, routineId: event.target.value })}><option value="">Choose a routine</option>{routines.map(row => <option key={row.id} value={row.id}>{row.name}{row.enabled ? "" : " (paused)"}</option>)}</NativeSelect></label>
    <p className="muted">{!edit && "New triggers start disabled. "}The selected routine must also be enabled to run.</p>
    {staleMessage && <p className="automation-trigger-feedback form-error" tabIndex={-1}>{staleMessage}</p>}
    {edit && !staleMessage && feedback[edit.id] && <p className={`automation-trigger-feedback ${taskFeedbackStyle(feedback[edit.id])}`} tabIndex={-1}>{feedback[edit.id].message}</p>}
    {!edit && (unconfirmed || reviewed) && <p ref={createMessage} className={`automation-trigger-feedback ${unconfirmed || likely ? "automation-trigger-callout" : "form-notice"}`} tabIndex={-1}>{unconfirmed ? "Not confirmed. Hermes may have created this trigger. Use Refresh status at the top of Work before trying again." : likely ? `${likely.id} is now in Hermes. This request probably created it, but this app never received its signing secret. To get a secret, delete ${likely.id} and create it again.` : "No trigger with this ID is in Hermes. Create trigger sends the same request again."}</p>}
    {!edit && createRefusal?.id === draft.id && <p className="automation-trigger-feedback form-error" tabIndex={-1}>{createRefusal.message}</p>}
    {!edit && <p className="muted">Finish or cancel this new trigger before editing another.</p>}
    <div className="actions">{likely ? <Button className="primary" onClick={() => { setCreating(false); setAttempt(undefined); publish(likely.id, `${likely.id} is now in Hermes. This app never received its signing secret.`); }}>Close</Button> : <Button type="submit" className="primary" disabled={control.disabled || !!staleMessage || !draft.id || !draft.routineId || !events.trim()}>{submitting ? edit ? "Saving…" : "Creating…" : edit ? "Save trigger" : "Create trigger"}</Button>}{!likely && <Button disabled={submitting} onClick={() => { if (edit) { setEditing(undefined); setFocus(`edit-opener:${edit.id}`); } else { clearCreateRefusal(); setCreating(false); setAttempt(undefined); setFocus("create-opener"); } }}>Cancel</Button>}</div>
  </form>;
  return <section className="automation-section automation-triggers" ref={section}><h3>Event triggers</h3>
    <p className="sr-only" role="status" aria-label="Trigger result" aria-live="polite" aria-atomic="true">{announcement}</p>
    {Object.entries(feedback).filter(([triggerId]) => !state.items.some(item => item.id === triggerId) && (!creating || triggerId !== draft.id) && !(staleMessage && triggerId === editing?.id)).map(([triggerId, message]) => <p key={triggerId} data-trigger-id={triggerId} className={`automation-trigger-feedback automation-trigger-removed ${taskFeedbackStyle(message)}`} tabIndex={-1}>{message.message}</p>)}
    {!state.supported ? <p className="capability-note">{state.reason || "Event triggers are unavailable on this Hermes installation."}</p> : <>
      <p className="muted">Run an existing routine when a service sends Hermes a matching event.</p>
      {!canManage && <p className="capability-note">Only an integration administrator can change event triggers.</p>}
      {!state.platformEnabled && <p className="capability-note">The installer must enable Hermes's webhook channel before events can arrive.</p>}
      {routineList.loading && <p role="status">Loading routines…</p>}
      {routineList.error && <div><p className="form-error" role="alert">Couldn't load routines: {routineList.error}</p><Button onClick={() => void routineList.reload()}>Retry routines</Button></div>}
      {!state.items.length && <p>No event triggers yet.</p>}
      {state.items.map(trigger => { const routine = routines.find(row => row.id === trigger.routineId); const missing = !routineList.loading && !routineList.error && !routine; return <article className="automation-item" data-trigger-id={trigger.id} key={trigger.id}><h4>{trigger.description || trigger.id}</h4><span className="automation-trigger-status">{trigger.enabled ? "Enabled" : "Disabled"}</span><p>Events: {trigger.events.join(", ") || "All events"}</p><p>{routineList.loading ? "Routine: loading…" : routineList.error ? `Routine ID: ${trigger.routineId}` : routine ? `Routine: ${routine.name}${routine.enabled ? "" : " · Paused"}` : `Routine: ${trigger.routineId} · Not found`}</p><p className="automation-trigger-label">Webhook URL</p><code className="automation-url">{trigger.url}</code>
        {canManage && (editing?.id === trigger.id ? form(editing) : <><div className="actions"><Button disabled={control.disabled || !trigger.enabled && (!state.platformEnabled || missing || routineList.loading || !!routineList.error)} onClick={() => void run(trigger.id, () => request("PATCH /bots/:id/automation/triggers/:triggerId", { params: { id: botId, triggerId: trigger.id }, body: { enabled: !trigger.enabled, revision: trigger.revision } }), trigger.enabled ? "Disabled." : "Enabled.")}>{trigger.enabled ? "Disable trigger" : "Enable trigger"}</Button><Button className="trigger-edit-opener" disabled={control.disabled || creating} onClick={() => { clearFeedback(trigger.id); setEditing(trigger); setDraft({ id: trigger.id, description: trigger.description, events: trigger.events, routineId: trigger.routineId }); setEvents(trigger.events.join(", ")); }}>Edit trigger</Button><Button disabled={control.disabled} onClick={() => { clearFeedback(trigger.id); setDeleting(trigger.id); }}>Delete trigger…</Button></div>
          {!trigger.enabled && !state.platformEnabled && <p className="muted">Can't enable until the installer turns on Hermes's webhook channel.</p>}{!trigger.enabled && missing && <p className="muted">{creating ? "Its routine is no longer available. Finish or cancel the new trigger, then edit this trigger to choose another routine." : "Its routine is no longer available. Edit the trigger to choose another routine before enabling it."}</p>}
          {!trigger.enabled && routineList.loading && <p className="muted">Routines are still loading.</p>}{!trigger.enabled && routineList.error && <p className="muted">Routines couldn't load. Retry routines before enabling this trigger.</p>}
          {deleting === trigger.id && <div className="automation-confirm"><p>{trigger.description || trigger.id} will be removed. Its routine stays saved.</p><div className="actions"><Button className="danger" disabled={control.disabled} onClick={async () => { if (await run(trigger.id, () => request("DELETE /bots/:id/automation/triggers/:triggerId", { params: { id: botId, triggerId: trigger.id }, body: { revision: trigger.revision } }), `Deleted ${trigger.id}.`)) setDeleting(""); }}>Delete trigger</Button><Button onClick={() => setDeleting("")}>Keep trigger</Button></div></div>}
          {feedback[trigger.id] && <p className={`automation-trigger-feedback ${taskFeedbackStyle(feedback[trigger.id])}`} tabIndex={-1}>{feedback[trigger.id].message}</p>}</>)}
      </article>; })}
      {editing && !stale && form(editing)}
      {secret && <div className="automation-secret" ref={secretPanel}><h4 ref={secretHeading} tabIndex={-1}>Save this signing secret now</h4><p>{secret.id} was created and starts disabled.</p><p>Hermes shows it once. Configure the sending service with this URL and secret. Leaving Work or reloading the page clears it from this screen.</p><div className="automation-secret-field"><p>Webhook URL</p><code className="automation-secret-value">{secret.url}</code>{typeof navigator.clipboard?.writeText === "function" && <div><Button onClick={() => void copy("url", secret.url)}>Copy URL</Button> <span role="status">{copyResult.url}</span></div>}</div><div className="automation-secret-field"><p>Signing secret</p>{reveal ? <code className="automation-secret-value">{secret.secret}</code> : <p className="muted">Hidden</p>}<div className="actions"><Button onClick={() => { setReveal(!reveal); setSeen(true); }}>{reveal ? "Hide secret" : "Show secret"}</Button>{typeof navigator.clipboard?.writeText === "function" && <Button onClick={() => void copy("secret", secret.secret)}>Copy secret</Button>}<span role="status">{copyResult.secret}</span></div></div>{!seen && <p className="muted">Copy or show the secret first.</p>}<div className="actions"><Button disabled={!seen} onClick={() => { const triggerId = secret.id; setSecret(undefined); setReveal(false); setSeen(false); publish(triggerId, state.items.some(item => item.id === triggerId) ? "Saved in Hermes." : `${triggerId} was created. Refresh status to see its current settings.`); }}>I've saved it</Button></div></div>}
      {canManage && !secret && !editing && (creating ? form() : <Button ref={createOpener} disabled={control.disabled || routineList.loading || !!routineList.error || !routines.length} aria-describedby={!routineList.loading && !routineList.error && !routines.length ? `${id}-routine-hint` : undefined} onClick={() => { setEditing(undefined); setDraft({ id: "", description: "", events: [], routineId: routines[0]?.id || "" }); setEvents(""); setAttempt(undefined); setCreating(true); }}>New event trigger</Button>)}
      {!routines.length && !routineList.loading && !routineList.error && <p id={`${id}-routine-hint`} className="muted">Create a routine in this assistant's Routines settings first.</p>}
    </>}
  </section>;
}

function SkillDiffPreview({ text, id }: { text: string; id: string }) {
  const lines = (text || "No textual diff.").split("\n");
  return <pre id={id} className="automation-code automation-diff"><code>{lines.map((line, index) => {
    const kind = /^(diff |index |@@|---|\+\+\+)/.test(line) ? "meta" : line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context";
    return <Fragment key={index}><span className={`automation-diff-line automation-diff-${kind}`}>{line}</span>{index < lines.length - 1 ? "\n" : ""}</Fragment>;
  })}</code></pre>;
}

export function LearningPanel({ botId }: { botId: string }) {
  const control = useAutomation(botId);
  const [content, setContent] = useState<SkillContent>();
  const [diff, setDiff] = useState<SkillDiff>();
  const [allowingWrites, setAllowingWrites] = useState(false);
  const policyInput = useRef<HTMLInputElement>(null);
  const id = useId();
  // Reading a skill or a pending change, one at a time.
  const reader = useAction();
  const { busy: reading, error: readError } = reader;
  const read = <T,>(load: () => Promise<T>, accept: (value: T) => void) => {
    control.clearNotice();
    return reader.run(async ({ current }) => { const value = await load(); if (current()) accept(value); });
  };
  const setPolicy = (approvalRequired: boolean) => {
    setAllowingWrites(false);
    void control.change(() => request("PUT /bots/:id/automation/skills/policy", { params: { id: botId }, body: { approvalRequired } }), undefined, approvalRequired ? "Approval is required before skill changes are saved." : "Skill changes can now be saved without review.");
  };
  const state = control.value?.skills;
  return <div className="automation-panel automation-learning"><h2>Skills & learning</h2><p className="muted">Inspect reusable instructions and review changes the assistant wants to save.</p><Status control={control} />
    {readError && <p className="form-error" role="alert">{readError}</p>}
    {state && (!state.supported ? <p className="capability-note">{state.reason || "Learning review is unavailable on this Hermes installation."}</p> : <>
      <section className="automation-section automation-learning-policy"><h3>Skill write policy</h3><label className="automation-check"><input ref={policyInput} type="checkbox" checked={state.approvalRequired} disabled={control.disabled || control.value?.canManageLearningPolicy === false} onChange={event => { if (event.target.checked) setPolicy(true); else setAllowingWrites(true); }} />Require approval before skill changes are saved</label><p className="muted">When enabled, Hermes stages new skills, edits and deletions for review.</p>{control.value?.canManageLearningPolicy === false && <p className="capability-note">Only an integration administrator can change the skill write policy.</p>}</section>
      <section className="automation-section"><h3>Pending changes ({state.pending.length})</h3>{!state.pending.length && <p className="muted">No skill changes waiting for review.</p>}
        {state.pending.map(item => <article className="automation-item" key={item.id}><h4>{item.summary || item.id}</h4><p className="muted">Source: {item.origin ? item.origin[0].toUpperCase() + item.origin.slice(1) : "Not reported"}</p><Button disabled={reading || control.disabled} aria-expanded={diff?.id === item.id} aria-controls={`${id}-diff-${item.id}`} onClick={() => { if (diff?.id === item.id) setDiff(undefined); else void read(() => request("GET /bots/:id/automation/skills/pending/:pendingId", { params: { id: botId, pendingId: item.id } }), value => { setDiff(value); setContent(undefined); }); }}>{diff?.id === item.id ? "Hide change" : "Review change"}</Button>
          {diff?.id === item.id && <><SkillDiffPreview text={diff.diff} id={`${id}-diff-${item.id}`} />{diff.truncated && <p>The diff is truncated. Read the full change in Hermes before approving.</p>}<div className="actions"><Button className="primary" disabled={control.disabled || diff.truncated} onClick={async () => { if (await control.change(() => request("POST /bots/:id/automation/skills/pending/:pendingId", { params: { id: botId, pendingId: item.id }, body: { revision: diff.revision, decision: "approve" } }), undefined, "Approved the skill change.")) setDiff(undefined); }}>Approve change</Button><Button className="danger" disabled={control.disabled} onClick={async () => { if (await control.change(() => request("POST /bots/:id/automation/skills/pending/:pendingId", { params: { id: botId, pendingId: item.id }, body: { revision: diff.revision, decision: "reject" } }), undefined, "Rejected the skill change.")) setDiff(undefined); }}>Reject change</Button></div></>}
        </article>)}
      </section>
      <section className="automation-section"><h3>Installed skills</h3>{!state.installed.length && <p className="muted">No installed skills reported.</p>}{state.installed.map(item => <article className="automation-item" key={item.name}><h4>{item.name}</h4><p>{item.description}</p><Button disabled={reading || control.disabled} onClick={() => void read(() => request("GET /bots/:id/automation/skills/content", { params: { id: botId }, query: { name: item.name } }), value => { setContent(value); setDiff(undefined); })}>Read skill</Button>{content?.name === item.name && <><pre className="automation-code">{content.content}</pre>{content.truncated && <p>Preview truncated. Open Hermes for the full skill.</p>}</>}</article>)}</section>
    </>)}
    {allowingWrites && <SettingsConfirmation className="learning-policy-confirmation" title="Allow skill changes without review?" detail="Hermes can save new skills, edits and deletions without asking for approval." confirmLabel="Allow changes without review" cancelLabel="Keep approval required" danger busy={control.disabled} fallbackFocus={policyInput} onCancel={() => setAllowingWrites(false)} onConfirm={() => setPolicy(false)} />}
  </div>;
}
