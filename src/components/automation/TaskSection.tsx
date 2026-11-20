import { useEffect, useRef, useState } from "react";
import { request } from "../../client-api";
import type { Bot } from "../../shared/types";
import type { AutomationTask, TaskInput } from "../../shared/automation";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { fire } from "../../app/fire";
import type { Controls } from "./use-automation";

export function TaskSection({
  control,
  bots,
  botId,
}: {
  control: Controls;
  bots: Bot[];
  botId: string;
}) {
  const state = control.value!.tasks;
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const createOpener = useRef<HTMLButtonElement>(null);
  const [restoreCreateFocus, setRestoreCreateFocus] = useState(false);
  // Focus returns to "New task" once the form's close has committed and the button exists again. One try:
  // a request left pending would pull focus there whenever the panel next re-rendered.
  useEffect(() => {
    if (creating || !restoreCreateFocus) return;
    createOpener.current?.focus();
    setRestoreCreateFocus(false);
  }, [creating, restoreCreateFocus]);
  const createMessage = useRef<HTMLParagraphElement>(null);
  const focusedCreateNotice = useRef("");
  const [attempt, setAttempt] = useState<{
    knownIds: string[];
    title: string;
    requestId: string;
    refreshCount: number;
    unconfirmed: boolean;
  } | null>(null);
  const [createFeedback, setCreateFeedback] = useState("");
  const [draft, setDraft] = useState<TaskInput>({
    requestId: crypto.randomUUID(),
    title: "",
    body: "",
    assignee: botId,
    priority: 0,
    dependencies: [],
  });
  const [openTask, setOpenTaskState] = useState<string | null>(null);
  const openTaskRef = useRef<string | null>(null);
  const setOpenTask = (id: string | null) => {
    openTaskRef.current = id;
    setOpenTaskState(id);
  };
  const [feedback, setFeedback] = useState<Record<string, TaskFeedback>>({});
  const [collapsed, setCollapsed] = useState<string[]>(["done"]);
  const [focusTask, setFocusTask] = useState<string | null>(null);
  const summaries = useRef<Record<string, HTMLElement | null>>({});
  const taskHeading = useRef<HTMLHeadingElement>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    setFeedback({});
    setAnnouncement("");
  }, [control.refreshCount]);
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
  const runTask = async (
    task: AutomationTask,
    send: () => Promise<unknown>,
    moved = false,
    edit = false,
  ) => {
    setFeedback((previous) => {
      const next = { ...previous };
      delete next[task.id];
      return next;
    });
    setAnnouncement("");
    const result = await control.changeTask(send);
    if (!result) {
      setFeedback((previous) => ({
        ...previous,
        [task.id]: {
          kind: "uncertain",
          source: edit ? "edit" : moved ? "move" : "dependency",
          title: task.title,
          message: "Not confirmed. Use Refresh status at the top of Work.",
        },
      }));
      return false;
    }
    const updated = result.overview.tasks.items.find((item) => item.id === task.id);
    const message =
      result.kind === "refused"
        ? `${result.message}${result.refreshed === false ? "" : " Status refreshed."}`
        : moved && updated
          ? `Moved to ${taskStatusLabel(updated.status)}.`
          : "Saved in Hermes.";
    setFeedback((previous) => ({
      ...previous,
      [task.id]: {
        kind: result.kind,
        source: edit ? "edit" : moved ? "move" : "dependency",
        title: task.title,
        message,
      },
    }));
    setAnnouncement(message);
    if (openTaskRef.current === task.id) {
      if (updated)
        setCollapsed((previous) => previous.filter((status) => status !== updated.status));
      setFocusTask(task.id);
    }
    return result.kind === "saved";
  };
  const likely =
    attempt && control.refreshCount > attempt.refreshCount && !control.disabled
      ? likelyCreatedTask(attempt.knownIds, attempt.title, state.items)
      : undefined;
  const reviewedAttempt =
    !!attempt && control.refreshCount > attempt.refreshCount && !control.disabled;
  const resend = reviewedAttempt && !likely && attempt?.requestId === draft.requestId;
  const unconfirmed = !!(control.uncertain && attempt?.unconfirmed);
  useEffect(() => {
    if (reviewedAttempt && attempt?.unconfirmed)
      setAttempt((previous) => previous && { ...previous, unconfirmed: false });
  }, [reviewedAttempt, attempt?.unconfirmed]);
  useEffect(() => {
    const phase = unconfirmed
      ? "unconfirmed"
      : likely
        ? `match:${likely.id}`
        : resend
          ? "no-match"
          : null;
    if (!creating || !phase || !attempt || !createMessage.current) return;
    const reviewVersion = unconfirmed ? attempt.refreshCount : control.refreshCount;
    const key = JSON.stringify([attempt.requestId, reviewVersion, phase]);
    if (focusedCreateNotice.current === key) return;
    focusedCreateNotice.current = key;
    createMessage.current.focus();
    if (likely || resend) setAnnouncement(createMessage.current.textContent || "");
  }, [creating, unconfirmed, likely, resend, attempt, control.refreshCount]);
  const resetCreate = () => {
    setCreating(false);
    setAttempt(null);
    setCreateFeedback("");
    setDraft({
      requestId: crypto.randomUUID(),
      title: "",
      body: "",
      assignee: botId,
      priority: 0,
      dependencies: [],
    });
  };
  const revealCreated = (task: AutomationTask, message: string) => {
    setOpenTask(task.id);
    setCollapsed((previous) => previous.filter((status) => status !== task.status));
    setFeedback((previous) => ({
      ...previous,
      [task.id]: { kind: "saved", source: "edit", title: task.title, message },
    }));
    setAnnouncement(message);
    setFocusTask(task.id);
  };
  const statuses = [...new Set(state.items.map((task) => task.status))].sort(compareTaskStatuses);
  const editDraft = (change: Partial<TaskInput>) =>
    setDraft((previous) => ({ ...previous, ...change, requestId: crypto.randomUUID() }));
  return (
    <section className="automation-section automation-tasks">
      <h3 ref={taskHeading} tabIndex={-1}>
        Task board
      </h3>
      <p
        className="sr-only"
        role="status"
        aria-label="Task result"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
      {Object.entries(feedback)
        .filter(([id]) => !state.items.some((task) => task.id === id))
        .map(([id, item]) => (
          <p key={id} className={`automation-task-feedback ${taskFeedbackStyle(item)}`}>
            {item.title}: {item.message}
          </p>
        ))}
      {!state.supported ? (
        <p className="capability-note">
          {state.reason || "Task boards are unavailable on this Hermes installation."}
        </p>
      ) : (
        <>
          <p className="muted">
            Tasks belong to this assistant. Assign work to a teammate, add dependencies, and request
            review.
          </p>
          {state.truncated && (
            <p className="capability-note" role="status">
              Showing the newest {state.limit || 100} visible tasks. Older tasks remain in Hermes.
            </p>
          )}
          {!state.items.length && <p>No tasks yet.</p>}
          {statuses.map((status) => (
            <div className="automation-task-group" key={status}>
              <h4>
                <button
                  type="button"
                  className="automation-task-group-toggle"
                  aria-expanded={!collapsed.includes(status)}
                  onClick={() =>
                    setCollapsed((previous) =>
                      previous.includes(status)
                        ? previous.filter((item) => item !== status)
                        : [...previous, status],
                    )
                  }
                >
                  {taskStatusLabel(status)} ·{" "}
                  {state.items.filter((task) => task.status === status).length}
                </button>
              </h4>
              {!collapsed.includes(status) &&
                state.items
                  .filter((task) => task.status === status)
                  .map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      control={control}
                      bots={bots}
                      open={openTask === task.id}
                      feedback={feedback[task.id]}
                      runTask={runTask}
                      summaryRef={(node) => {
                        summaries.current[task.id] = node;
                      }}
                      onToggle={() => {
                        if (openTask === task.id) {
                          setOpenTask(null);
                          setFeedback((previous) => {
                            const next = { ...previous };
                            delete next[task.id];
                            return next;
                          });
                          setAnnouncement("");
                        } else {
                          if (openTask)
                            setFeedback((previous) => {
                              const next = { ...previous };
                              delete next[openTask];
                              return next;
                            });
                          setAnnouncement("");
                          setOpenTask(task.id);
                        }
                      }}
                    />
                  ))}
            </div>
          ))}
          {!creating ? (
            <Button
              ref={createOpener}
              disabled={control.disabled}
              onClick={() => setCreating(true)}
            >
              New task
            </Button>
          ) : (
            <form
              className="automation-form"
              aria-labelledby="new-task-heading"
              onSubmit={fire(async (event) => {
                event.preventDefault();
                const snapshot = {
                  knownIds: state.items.map((item) => item.id),
                  title: draft.title.trim(),
                  requestId: draft.requestId,
                  refreshCount: control.refreshCount,
                  unconfirmed: false,
                };
                setAttempt(snapshot);
                setCreateFeedback("");
                setSubmitting(true);
                try {
                  const result = await control.changeTask(() =>
                    request("POST /bots/:id/automation/tasks", {
                      params: { id: botId },
                      body: { ...draft, dependencies: draft.dependencies || [] },
                    }),
                  );
                  if (!result) {
                    setAttempt((previous) =>
                      previous?.requestId === snapshot.requestId
                        ? { ...previous, unconfirmed: true }
                        : previous,
                    );
                    return;
                  }
                  if (result.kind === "refused") {
                    setAttempt(null);
                    setCreateFeedback(
                      result.message + (result.refreshed === false ? "" : " Status refreshed."),
                    );
                    return;
                  }
                  const created =
                    result.overview.tasks.items.find((item) => item.id === result.result?.id) ??
                    likelyCreatedTask(
                      snapshot.knownIds,
                      snapshot.title,
                      result.overview.tasks.items,
                    );
                  resetCreate();
                  if (created)
                    revealCreated(
                      created,
                      `Created. "${created.title}" stays blocked until you start it.`,
                    );
                  else {
                    setAnnouncement("Created in Hermes. Refresh status to review the task.");
                    setRestoreCreateFocus(true);
                  }
                } finally {
                  setSubmitting(false);
                }
              })}
            >
              <h4 id="new-task-heading">New task</h4>
              <label>
                Task title
                <Input
                  autoFocus
                  required
                  maxLength={500}
                  value={draft.title}
                  disabled={control.disabled || !!likely}
                  onChange={(event) => editDraft({ title: event.target.value })}
                />
              </label>
              <label>
                Instructions (optional)
                <textarea
                  rows={3}
                  maxLength={20000}
                  value={draft.body}
                  disabled={control.disabled || !!likely}
                  onChange={(event) => editDraft({ body: event.target.value })}
                />
              </label>
              <label>
                Assigned assistant
                <NativeSelect
                  value={draft.assignee || ""}
                  disabled={control.disabled || !!likely}
                  onChange={(event) => editDraft({ assignee: event.target.value || null })}
                >
                  <option value="">Unassigned</option>
                  {bots.map((bot) => (
                    <option value={bot.id} key={bot.id}>
                      {bot.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label>
                Priority
                <Input
                  type="number"
                  min={-100}
                  max={100}
                  value={draft.priority}
                  disabled={control.disabled || !!likely}
                  onChange={(event) => editDraft({ priority: Number(event.target.value) })}
                />
              </label>
              {state.items.length > 0 && (
                <fieldset disabled={control.disabled || !!likely}>
                  <legend>Wait for these tasks (optional)</legend>
                  <div
                    className={
                      state.items.length > 6
                        ? "automation-task-choices is-bounded"
                        : "automation-task-choices"
                    }
                  >
                    {state.items
                      .filter((task) => task.id !== likely?.id)
                      .map((task) => (
                        <label className="automation-check" key={task.id}>
                          <input
                            type="checkbox"
                            checked={draft.dependencies?.includes(task.id) || false}
                            disabled={
                              !draft.dependencies?.includes(task.id) &&
                              (draft.dependencies?.length || 0) >= 20
                            }
                            onChange={(event) =>
                              editDraft({
                                dependencies: event.target.checked
                                  ? [...(draft.dependencies || []), task.id]
                                  : draft.dependencies?.filter((id) => id !== task.id),
                              })
                            }
                          />
                          <span>
                            {task.title}{" "}
                            <span className="muted">· {taskStatusLabel(task.status)}</span>
                          </span>
                        </label>
                      ))}
                  </div>
                </fieldset>
              )}
              <p className="muted">
                Creates a blocked task. Start it explicitly when the instructions are ready.
              </p>
              {(unconfirmed || likely) && (
                <p ref={createMessage} tabIndex={-1} className="automation-task-callout">
                  {likely
                    ? "A task with this title appeared on the board. Hermes may have saved it. Close this form to review it."
                    : "Not confirmed. Hermes may have created this task. Use Refresh status at the top of Work before trying again."}
                </p>
              )}
              {resend && (
                <p ref={createMessage} tabIndex={-1}>
                  No new task with this title is visible. Create task sends the same request again.
                </p>
              )}
              {createFeedback && (
                <p className="form-error" role="alert">
                  {createFeedback}
                </p>
              )}
              <div className="actions">
                {likely ? (
                  <Button
                    className="primary"
                    onClick={() => {
                      resetCreate();
                      revealCreated(
                        likely,
                        `"${likely.title}" appeared on the board. Hermes may have saved it.`,
                      );
                    }}
                  >
                    Close
                  </Button>
                ) : (
                  <>
                    <Button
                      type="submit"
                      className="primary"
                      disabled={control.disabled || !draft.title.trim()}
                    >
                      {submitting ? "Creating…" : "Create task"}
                    </Button>
                    <Button
                      disabled={control.disabled}
                      onClick={() => {
                        setCreating(false);
                        setAttempt(null);
                        setCreateFeedback("");
                        setRestoreCreateFocus(true);
                      }}
                    >
                      Cancel
                    </Button>
                  </>
                )}
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}

const taskStatusOrder = ["blocked", "running", "review", "ready", "todo", "scheduled", "triage"];
const taskStatusLabels: Record<string, string> = {
  blocked: "Blocked",
  running: "Running",
  review: "In review",
  ready: "Ready",
  todo: "To do",
  scheduled: "Scheduled",
  triage: "Triage",
  done: "Done",
};
function taskStatusLabel(status: string) {
  return Object.hasOwn(taskStatusLabels, status)
    ? taskStatusLabels[status]
    : status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function compareTaskStatuses(a: string, b: string) {
  const rank = (status: string) =>
    status === "done"
      ? taskStatusOrder.length + 1
      : taskStatusOrder.includes(status)
        ? taskStatusOrder.indexOf(status)
        : taskStatusOrder.length;
  return rank(a) - rank(b) || taskStatusLabel(a).localeCompare(taskStatusLabel(b));
}

export function likelyCreatedTask(
  knownIds: readonly string[],
  title: string,
  items: AutomationTask[],
) {
  return items.find((item) => !knownIds.includes(item.id) && item.title === title);
}

type TaskFeedback = {
  kind: "saved" | "refused" | "uncertain";
  source: "move" | "dependency" | "edit";
  title: string;
  message: string;
};
export function taskFeedbackStyle(feedback: Pick<TaskFeedback, "kind">) {
  return feedback.kind === "refused"
    ? "form-error"
    : feedback.kind === "uncertain"
      ? "automation-task-uncertain"
      : "form-notice";
}
function TaskCard({
  task,
  control,
  bots,
  open,
  feedback,
  runTask,
  summaryRef,
  onToggle,
}: {
  task: AutomationTask;
  control: Controls;
  bots: Bot[];
  open: boolean;
  feedback?: TaskFeedback;
  runTask: (
    task: AutomationTask,
    send: () => Promise<unknown>,
    moved?: boolean,
    edit?: boolean,
  ) => Promise<boolean>;
  summaryRef: (node: HTMLElement | null) => void;
  onToggle: () => void;
}) {
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
  const cancelForm = () => {
    const opener = form === "block" ? blockOpener : reviewOpener;
    setForm(null);
    setReason("");
    opener.current?.focus();
  };
  const [dependency, setDependency] = useState("");
  const params = { id: control.botId, taskId: task.id };
  const running = task.status === "running";
  useEffect(() => {
    if (running) setEditing(false);
  }, [running]);
  const resultNotice = feedback && (
    <p
      tabIndex={-1}
      className={`automation-task-feedback ${feedback.source === "edit" ? "automation-task-feedback--edit " : ""}${taskFeedbackStyle(feedback)}`}
    >
      {feedback.message}
    </p>
  );
  const name = bots.find((bot) => bot.id === task.assignee)?.name || task.assignee || "Unassigned";
  const action = async (actionName: "start" | "block" | "request_review") => {
    const payload = {
      action: actionName,
      ...(reason.trim() && (actionName !== "start" || !form) ? { reason } : {}),
      ...(actionName === "request_review" && reviewer ? { reviewer } : {}),
    };
    if (
      await runTask(
        task,
        () => request("POST /bots/:id/automation/tasks/:taskId/actions", { params, body: payload }),
        true,
      )
    ) {
      setForm(null);
      setReason("");
      setReviewer("");
    }
  };
  return (
    <details className="automation-item automation-task" data-task-id={task.id} open={open}>
      <summary
        ref={summaryRef}
        onClick={(event) => {
          event.preventDefault();
          onToggle();
        }}
      >
        <span>{task.title}</span>
        <small>
          {name}
          {task.priority !== 0 && ` · Priority ${task.priority}`}
        </small>
      </summary>
      <div className="automation-task-detail">
        <p className="automation-task-meta">
          <span className="automation-task-status">{taskStatusLabel(task.status)}</span>
          <span>{name}</span>
          {task.priority !== 0 && <span>Priority {task.priority}</span>}
        </p>
        <p className="preserve-lines">{task.body || "No additional instructions."}</p>
        {task.blockedReason && (
          <div className="automation-task-callout">
            <strong>Blocked</strong>
            <p>{task.blockedReason}</p>
          </div>
        )}
        {!running &&
          (editing ? (
            <form
              className="automation-form"
              aria-labelledby={`edit-task-${task.id}`}
              onSubmit={fire(async (event) => {
                event.preventDefault();
                setSubmitting(true);
                try {
                  if (
                    await runTask(
                      task,
                      () =>
                        request("PATCH /bots/:id/automation/tasks/:taskId", {
                          params,
                          body: { title, body, priority, assignee: assignee || null },
                        }),
                      false,
                      true,
                    )
                  )
                    setEditing(false);
                } finally {
                  setSubmitting(false);
                }
              })}
            >
              <h4 id={`edit-task-${task.id}`}>Edit task</h4>
              <label>
                Task title
                <Input
                  autoFocus
                  required
                  value={title}
                  maxLength={500}
                  disabled={control.disabled}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label>
                Instructions (optional)
                <textarea
                  value={body}
                  maxLength={20000}
                  rows={3}
                  disabled={control.disabled}
                  onChange={(event) => setBody(event.target.value)}
                />
              </label>
              <label>
                Assigned assistant
                <NativeSelect
                  value={assignee}
                  disabled={control.disabled}
                  onChange={(event) => setAssignee(event.target.value)}
                >
                  <option value="">Unassigned</option>
                  {bots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label>
                Priority
                <Input
                  type="number"
                  min={-100}
                  max={100}
                  value={priority}
                  disabled={control.disabled}
                  onChange={(event) => setPriority(Number(event.target.value))}
                />
              </label>
              <div className="actions">
                <Button
                  type="submit"
                  className="primary"
                  disabled={control.disabled || !title.trim()}
                >
                  {submitting ? "Saving…" : "Save task"}
                </Button>
                <Button
                  disabled={control.disabled}
                  onClick={() => {
                    setEditing(false);
                    requestAnimationFrame(() => editOpener.current?.focus());
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button
              ref={editOpener}
              disabled={control.disabled}
              onClick={() => {
                setTitle(task.title);
                setBody(task.body);
                setPriority(task.priority);
                setAssignee(task.assignee || "");
                setEditing(true);
              }}
            >
              Edit task
            </Button>
          ))}
        {!running && feedback?.source === "edit" && resultNotice}
        <section className="automation-task-dependencies">
          <h5>Dependencies</h5>
          {!task.dependencies.length && <p className="muted">None.</p>}
          {task.dependencies.map((id) => {
            const parent = control.value!.tasks.items.find((item) => item.id === id);
            return (
              <div className="automation-dependency" key={id}>
                <span>{parent ? `${parent.title} · ${taskStatusLabel(parent.status)}` : id}</span>
                {!running && (
                  <Button
                    aria-label={`Remove dependency on ${parent?.title || id}`}
                    disabled={control.disabled}
                    onClick={() =>
                      void runTask(task, () =>
                        request(
                          "PUT /bots/:id/automation/tasks/:taskId/dependencies/:dependencyId",
                          { params: { ...params, dependencyId: id }, body: { remove: true } },
                        ),
                      )
                    }
                  >
                    Remove dependency
                  </Button>
                )}
              </div>
            );
          })}
          {!running && (
            <div className="automation-task-add">
              <label>
                Wait for task
                <NativeSelect
                  value={dependency}
                  disabled={control.disabled}
                  onChange={(event) => setDependency(event.target.value)}
                >
                  <option value="">Choose a task</option>
                  {control
                    .value!.tasks.items.filter(
                      (item) => item.id !== task.id && !task.dependencies.includes(item.id),
                    )
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                </NativeSelect>
              </label>
              <Button
                disabled={control.disabled || !dependency}
                onClick={fire(async () => {
                  if (
                    await runTask(task, () =>
                      request("PUT /bots/:id/automation/tasks/:taskId/dependencies/:dependencyId", {
                        params: { ...params, dependencyId: dependency },
                        body: { remove: false },
                      }),
                    )
                  )
                    setDependency("");
                })}
              >
                Add dependency
              </Button>
            </div>
          )}
          {feedback?.source === "dependency" && resultNotice}
        </section>
        <section className="automation-task-move">
          <h5>Move task</h5>
          {running ? (
            <p>A Hermes worker is running this task. You can change it after the run finishes.</p>
          ) : (
            <>
              <div className="actions">
                <Button
                  className={
                    task.status === "blocked" || task.status === "todo" ? "primary" : undefined
                  }
                  disabled={control.disabled}
                  onClick={() => void action("start")}
                >
                  Start task
                </Button>
                <Button
                  ref={blockOpener}
                  aria-expanded={form === "block"}
                  disabled={control.disabled}
                  onClick={() => {
                    setForm("block");
                    setReason("");
                  }}
                >
                  Block task…
                </Button>
                <Button
                  ref={reviewOpener}
                  aria-expanded={form === "review"}
                  disabled={control.disabled}
                  onClick={() => {
                    setForm("review");
                    setReason("");
                  }}
                >
                  Request review…
                </Button>
              </div>
              {feedback?.source === "move" && resultNotice}
              {form === "block" && (
                <div className="automation-form">
                  <label>
                    What is blocking this task?
                    <Input
                      value={reason}
                      maxLength={2000}
                      onChange={(event) => setReason(event.target.value)}
                      disabled={control.disabled}
                    />
                  </label>
                  <div className="actions">
                    <Button
                      disabled={control.disabled || !reason.trim()}
                      onClick={() => void action("block")}
                    >
                      Block task
                    </Button>
                    <Button disabled={control.disabled} onClick={cancelForm}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
              {form === "review" && (
                <div className="automation-form">
                  <label>
                    Reviewer
                    <NativeSelect
                      value={reviewer}
                      onChange={(event) => setReviewer(event.target.value)}
                      disabled={control.disabled}
                    >
                      <option value="">Choose one</option>
                      {bots.map((bot) => (
                        <option key={bot.id} value={bot.id}>
                          {bot.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  <label>
                    Notes for the reviewer (optional)
                    <Input
                      value={reason}
                      maxLength={2000}
                      onChange={(event) => setReason(event.target.value)}
                      disabled={control.disabled}
                    />
                  </label>
                  <div className="actions">
                    <Button
                      disabled={control.disabled || !reviewer}
                      onClick={() => void action("request_review")}
                    >
                      Request review
                    </Button>
                    <Button disabled={control.disabled} onClick={cancelForm}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
              {!form && (
                <details className="automation-task-note">
                  <summary>Add an optional start note</summary>
                  <label>
                    Start note
                    <Input
                      value={reason}
                      maxLength={2000}
                      onChange={(event) => setReason(event.target.value)}
                      disabled={control.disabled}
                    />
                  </label>
                </details>
              )}
              {task.status === "review" && (
                <p className="muted">
                  The reviewing assistant can request changes through Hermes while it owns the
                  review.
                </p>
              )}
              <p className="muted">
                Hermes checks the task's current state and dependencies before changing it.
              </p>
            </>
          )}
          {running && feedback?.source !== "dependency" && resultNotice}
        </section>
      </div>
    </details>
  );
}
