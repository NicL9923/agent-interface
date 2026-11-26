import { routeUrl } from "../shared/api";
import { useEffect, useState } from "react";
import { pollWhileVisible, request } from "../client-api";
import { useAction } from "../app/use-action";
import { useResource } from "../app/use-resource";
import { AttentionCard } from "../app/AttentionCard";
import { FormMessage } from "./ui/form-message";
import { Avatar, stateLabels } from "./Avatar";
import { EmailDraftCard } from "./EmailDraftCard";
import { Icon } from "./Icon";
import { When } from "./When";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { eventHeadline } from "../shared/event-copy";
import { CONFIRMATION_KIND_LABELS, type ActionConfirmation } from "../shared/confirmations";
import { mainBot } from "../shared/main-assistant";
import { eventGoogleCalendarUrl } from "../shared/reply-cards";
import { TASK_STATUS_LABELS, type NativeTask } from "../shared/tasks";
import type { Bootstrap } from "../shared/types";
import type { TodayItem, TodayLearningProposal } from "../shared/experience";
import "./experience.css";

function attentionCopy(item: TodayItem) {
  if (item.error)
    return { title: item.error, reason: "Disconnected", action: "Reconnect", failed: true };
  const approval = item.approvals.find((value) => value.status === "pending");
  if (approval)
    return { title: approval.title, reason: "Approval", action: "Review", failed: false };
  const question = item.attention[0];
  if (question)
    return {
      title: question.title,
      reason:
        question.kind === "clarify"
          ? "Question"
          : question.kind === "secure"
            ? "Secure request"
            : question.kind === "computer"
              ? "Computer"
              : question.kind === "terminal"
                ? "Terminal"
                : question.kind === "connection"
                  ? "Connection"
                  : "Needs your help",
      action: question.kind === "clarify" ? "Answer" : "Review",
      failed: false,
    };
  const failed = item.activity.state === "failed" || item.activity.state === "interrupted";
  return {
    title: item.activity.detail || stateLabels[item.activity.state],
    reason: stateLabels[item.activity.state],
    action: failed ? "View error" : "Review",
    failed,
  };
}

/** How soon Today asks again while an assistant's read had not finished when the server answered. */
export const TODAY_RECHECK_MS = 2_000;

function ConfirmationTriageCard({
  item,
  onDone,
  onOpen,
  onError,
}: {
  item: ActionConfirmation;
  onDone: () => void;
  onOpen: (botId: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  async function decide(decision: "approved" | "declined") {
    if (busy) return;
    setBusy(true);
    onError("");
    try {
      await request("POST /bots/:id/confirmations/:confirmationId", {
        params: { id: item.botId, confirmationId: item.id },
        body: { decision, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save decision.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="today-triage-card">
      <div className="today-triage-top">
        <span className="today-pill attention">{CONFIRMATION_KIND_LABELS[item.kind]}</span>
        <small>{item.botName || item.botId}</small>
      </div>
      <strong>{item.title}</strong>
      <p className="today-triage-summary">{item.summary}</p>
      {(item.target || item.fields.length > 0) && (
        <dl className="today-triage-fields">
          {item.target && (
            <div>
              <dt>Target</dt>
              <dd>{item.target}</dd>
            </div>
          )}
          {(() => {
            const seen = new Map<string, number>();
            return item.fields.map((field) => {
              const base = `${field.label}\0${field.value}`;
              const count = (seen.get(base) ?? 0) + 1;
              seen.set(base, count);
              return (
                <div key={count === 1 ? base : `${base}#${count}`}>
                  <dt>{field.label}</dt>
                  <dd>{field.value}</dd>
                </div>
              );
            });
          })()}
        </dl>
      )}
      <div className="today-triage-controls">
        <Input
          value={note}
          placeholder="Optional note…"
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="today-triage-buttons">
          <Button className="primary" disabled={busy} onClick={() => void decide("approved")}>
            Approve
          </Button>
          <Button disabled={busy} onClick={() => void decide("declined")}>
            Decline
          </Button>
          <Button disabled={busy} onClick={() => onOpen(item.botId)}>
            Open chat
          </Button>
        </div>
      </div>
    </article>
  );
}

function LearningProposalCard({
  item,
  onDone,
  onError,
}: {
  item: TodayLearningProposal;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function decide(action: "approve" | "reject") {
    if (busy) return;
    setBusy(true);
    onError("");
    try {
      await request(
        action === "approve"
          ? "POST /bots/:id/learning/proposals/:revisionId/approve"
          : "POST /bots/:id/learning/proposals/:revisionId/reject",
        { params: { id: item.botId, revisionId: item.revision.id } },
      );
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not review proposal.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="today-triage-card">
      <div className="today-triage-top">
        <span className="today-pill">
          {item.revision.target === "memory" ? "Memory update" : "Skill update"}
        </span>
        <small>
          {item.botName} · {item.revision.name}
        </small>
      </div>
      <strong>{item.revision.next.title || item.revision.name}</strong>
      {item.revision.reason && <p className="today-triage-summary">{item.revision.reason}</p>}
      <p className="today-triage-preview">{item.revision.next.text.slice(0, 260)}</p>
      <div className="today-triage-buttons">
        <Button className="primary" disabled={busy} onClick={() => void decide("approve")}>
          Approve
        </Button>
        <Button disabled={busy} onClick={() => void decide("reject")}>
          Reject
        </Button>
      </div>
    </article>
  );
}

function TaskCard({
  task,
  onDone,
  onOpen,
  onError,
}: {
  task: NativeTask;
  onDone: () => void;
  onOpen: (botId: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [askingChanges, setAskingChanges] = useState(false);
  const [feedback, setFeedback] = useState("");

  async function update(patch: { status: NativeTask["status"]; feedback?: string }) {
    if (busy) return;
    setBusy(true);
    onError("");
    try {
      await request("PATCH /tasks/:id", {
        params: { id: task.id },
        body: patch,
      });
      setAskingChanges(false);
      setFeedback("");
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not update task.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`today-triage-card today-task-card status-${task.status}`}>
      <div className="today-triage-top">
        <span className={`today-pill status-${task.status}`}>
          {TASK_STATUS_LABELS[task.status]}
        </span>
        <small>
          {task.botName || task.botId} · <When value={task.updatedAt} inline />
        </small>
      </div>
      <strong>{task.title}</strong>
      {task.summary && <p className="today-triage-summary">{task.summary}</p>}
      {!task.summary && task.notes && <p className="today-triage-summary">{task.notes}</p>}
      {askingChanges && (
        <div className="today-triage-controls">
          <Input
            placeholder="What needs changes?"
            value={feedback}
            disabled={busy}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <div className="today-triage-buttons">
            <Button
              className="primary"
              disabled={busy || !feedback.trim()}
              onClick={() => void update({ status: "working", feedback: feedback.trim() })}
            >
              Send back
            </Button>
            <Button disabled={busy} onClick={() => setAskingChanges(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {!askingChanges && (
        <div className="today-triage-buttons">
          <Button
            className={task.status === "ready_for_review" ? "primary" : undefined}
            disabled={busy}
            onClick={() => void update({ status: "done" })}
          >
            <Icon name="check" size={15} /> Mark done
          </Button>
          {task.status === "ready_for_review" && (
            <Button disabled={busy} onClick={() => setAskingChanges(true)}>
              Request changes
            </Button>
          )}
          <Button disabled={busy} onClick={() => onOpen(task.botId)}>
            Open chat
          </Button>
        </div>
      )}
    </article>
  );
}

export function TodayPanel({
  bootstrap,
  onOpen,
  onOutputs,
  onBrainDump,
}: {
  bootstrap: Bootstrap;
  onOpen: (botId: string, routineId?: string) => void;
  onOutputs?: () => void;
  onBrainDump?: () => void;
}) {
  // A 304 keeps generatedAt, so record when this client last confirmed the overview.
  const [checkedAt, setCheckedAt] = useState("");
  const [triageError, setTriageError] = useState("");
  const [expandedQuestion, setExpandedQuestion] = useState<string | null>(null);
  const [addingTask, setAddingTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskNotes, setTaskNotes] = useState("");
  const [taskBotId, setTaskBotId] = useState(
    () => bootstrap.preferences.mainBotId || bootstrap.bots[0]?.id || "",
  );
  const [creatingTask, setCreatingTask] = useState(false);
  const today = useResource(routeUrl("GET /today", {}), {
    load: (_, signal) => request("GET /today", { query: { pending: "1" }, signal }),
    deps: [bootstrap.user.id],
    pollMs: 30_000,
    onData: () => setCheckedAt(new Date().toISOString()),
  });
  const { data: overview, loading } = today;
  const seen = useAction();
  const error = triageError || seen.error || today.error;
  const items = overview?.items || [];
  const confirmations = overview?.confirmations || [];
  const learningProposals = overview?.learningProposals || [];
  const tasks = overview?.tasks || [];
  const readyDrafts = overview?.readyDrafts || [];
  const morningBrief = overview?.morningBrief;
  const main = mainBot(bootstrap.preferences, bootstrap.bots);
  const attention = items.filter(
    (item) =>
      item.error ||
      item.approvals.some((approval) => approval.status === "pending") ||
      item.attention.length ||
      ["blocked", "interrupted", "failed"].includes(item.activity.state),
  );
  const totalNeedsYou = attention.length + confirmations.length + learningProposals.length;
  const active = items.filter(
    (item) => !item.error && ["thinking", "working", "waiting"].includes(item.activity.state),
  );
  const working = active.filter((item) => !attention.some((other) => other.botId === item.botId));
  const completed = overview?.events.filter((event) => event.kind === "completed") || [];
  const bot = (id: string) => bootstrap.bots.find((value) => value.id === id);
  const avatar = (id: string, name: string) => (
    <span className="today-avatar" aria-hidden="true">
      <Avatar avatar={bot(id)?.avatar} name={name} state="idle" size={36} reducedMotion />
    </span>
  );
  const caughtUp = () =>
    overview &&
    seen.run(async () => {
      await request("PUT /today/seen", {
        body: { seenAt: overview.generatedAt, frontier: overview.frontier },
      });
      await today.reload();
    });
  const files = items.filter((item) => item.files.length);
  // The server answers without an assistant whose read is slow and lists it as unchecked; that read goes on, so Today asks again soon.
  const pending = items.filter((item) => item.pending);
  const unchecked =
    overview?.unavailableBots.filter(
      (id) => !items.some((item) => item.botId === id && (item.error || item.pending)),
    ) || [];
  const reload = today.reload;
  // Until none is pending: an answer that is still pending can come back unchanged, as a 304 that keeps this overview.
  const waiting = !!overview?.items.some((item) => item.pending);
  useEffect(() => {
    if (!waiting) return;
    return pollWhileVisible(() => void reload(), TODAY_RECHECK_MS);
  }, [waiting, reload]);

  async function submitNewTask(event: React.FormEvent) {
    event.preventDefault();
    const target = taskBotId || bootstrap.bots[0]?.id;
    if (!target || !taskTitle.trim() || creatingTask) return;
    setCreatingTask(true);
    setTriageError("");
    try {
      await request("POST /tasks", {
        body: {
          botId: target,
          title: taskTitle.trim(),
          ...(taskNotes.trim() ? { notes: taskNotes.trim() } : {}),
        },
      });
      setTaskTitle("");
      setTaskNotes("");
      setAddingTask(false);
      await today.reload();
    } catch (err) {
      setTriageError(err instanceof Error ? err.message : "Could not create task.");
    } finally {
      setCreatingTask(false);
    }
  }

  return (
    <div className="today-panel">
      <div className="today-content">
        <div className="today-status">
          <p
            className="muted today-timestamp"
            role={overview ? undefined : "status"}
            title="Updates every 30 seconds"
          >
            {overview ? (
              <>
                Checked <When value={checkedAt || overview.generatedAt} inline />
              </>
            ) : loading ? (
              "Checking your assistants..."
            ) : (
              "Today is unavailable right now."
            )}
          </p>
          <div className="today-status-actions">
            {main && onBrainDump && (
              <button type="button" onClick={onBrainDump}>
                <Icon name="sparkle" size={16} />
                Brain dump
              </button>
            )}
            {onOutputs && (
              <button type="button" onClick={onOutputs}>
                <Icon name="file-text" size={16} />
                Outputs
              </button>
            )}
            <button type="button" disabled={loading} onClick={() => void today.reload()}>
              <Icon name="refresh" size={16} />
              Refresh
            </button>
          </div>
        </div>
        {error && (
          <FormMessage tone="error">{error} Loaded results may be out of date.</FormMessage>
        )}
        {overview && (
          <>
            <div className="today-summary" role="group" aria-label="Household activity">
              {!totalNeedsYou && (
                <span className="today-clear">
                  <Icon name="check" size={18} />
                  {overview.unavailableBots.length
                    ? "No requests in checked assistants"
                    : "All clear"}
                </span>
              )}
              {!!totalNeedsYou && (
                <span>
                  <strong>{totalNeedsYou}</strong> need you
                </span>
              )}
              <span>
                <strong>{working.length}</strong> at work
              </span>
              {!!tasks.length && (
                <span>
                  <strong>{tasks.length}</strong> open tasks
                </span>
              )}
              <span>
                <strong>{completed.length}</strong> finished
              </span>
            </div>

            {morningBrief && (
              <section className="today-section today-brief" aria-labelledby="today-brief-title">
                <div className="today-section-heading">
                  <h3 id="today-brief-title">Morning brief</h3>
                  <button type="button" onClick={() => onOpen(morningBrief.botId)}>
                    Open {morningBrief.botName}
                  </button>
                </div>
                <article className="today-triage-card">
                  <div className="today-triage-top">
                    <span className="today-pill">{morningBrief.botName}</span>
                    <small>
                      <When value={morningBrief.createdAt} inline />
                    </small>
                  </div>
                  <p className="today-brief-body">
                    {morningBrief.text.replace(/```agent-ui[\s\S]*?```/g, "").trim()}
                  </p>
                  {morningBrief.cards
                    .filter((card) => card.type === "email")
                    .map((card) => (
                      <div className="today-inline-draft" key={card.id}>
                        <EmailDraftCard card={card} />
                      </div>
                    ))}
                </article>
              </section>
            )}

            {!!totalNeedsYou && (
              <section
                className="today-section today-attention"
                aria-labelledby="today-attention-title"
              >
                <h3 id="today-attention-title">
                  Needs your attention <span>{totalNeedsYou}</span>
                </h3>
                {confirmations.length > 0 && (
                  <div className="today-triage-stack">
                    {confirmations.map((item) => (
                      <ConfirmationTriageCard
                        key={item.id}
                        item={item}
                        onDone={() => void today.reload()}
                        onOpen={(id) => onOpen(id)}
                        onError={setTriageError}
                      />
                    ))}
                  </div>
                )}
                {!!attention.length && (
                  <div className="today-attention-list">
                    {attention.map((item) => {
                      const copy = attentionCopy(item);
                      const clarify = item.attention.find((req) => req.kind === "clarify");
                      const isExpanded =
                        clarify && expandedQuestion === `${item.botId}:${clarify.id}`;
                      return (
                        <div key={item.botId} className="today-attention-entry">
                          <button
                            className="today-row"
                            type="button"
                            onClick={() =>
                              clarify
                                ? setExpandedQuestion(
                                    isExpanded ? null : `${item.botId}:${clarify.id}`,
                                  )
                                : onOpen(item.botId)
                            }
                          >
                            {avatar(item.botId, item.botName)}
                            <span className="today-row-copy">
                              <strong>{copy.title}</strong>
                              <small>
                                {item.botName} ·{" "}
                                <span
                                  className={copy.failed ? "today-reason failed" : "today-reason"}
                                >
                                  {copy.reason}
                                </span>
                              </small>
                            </span>
                            <span className="today-row-action">
                              {clarify ? (isExpanded ? "Hide" : "Answer inline") : copy.action}
                            </span>
                          </button>
                          {isExpanded && clarify && (
                            <div className="today-inline-question">
                              <AttentionCard
                                request={clarify}
                                botId={item.botId}
                                report={(message) => {
                                  setTriageError(message);
                                  if (!message) void today.reload();
                                }}
                              />
                              <div className="today-inline-question-footer">
                                <Button onClick={() => onOpen(item.botId)}>
                                  Open {item.botName}
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {learningProposals.length > 0 && (
                  <div className="today-triage-stack">
                    {learningProposals.map((item) => (
                      <LearningProposalCard
                        key={`${item.botId}:${item.revision.id}`}
                        item={item}
                        onDone={() => void today.reload()}
                        onError={setTriageError}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {(tasks.length > 0 || addingTask || bootstrap.bots.length > 0) && (
              <section className="today-section" aria-labelledby="today-tasks-title">
                <div className="today-section-heading">
                  <h3 id="today-tasks-title">
                    Tasks {tasks.length > 0 && <span>{tasks.length}</span>}
                  </h3>
                  {bootstrap.bots.length > 0 && (
                    <button type="button" onClick={() => setAddingTask((open) => !open)}>
                      {addingTask ? "Cancel" : "+ New task"}
                    </button>
                  )}
                </div>
                {addingTask && (
                  <form className="today-task-form" onSubmit={(event) => void submitNewTask(event)}>
                    <Input
                      placeholder="Task title"
                      value={taskTitle}
                      maxLength={200}
                      onChange={(event) => setTaskTitle(event.target.value)}
                    />
                    <div className="today-task-form-row">
                      <NativeSelect
                        aria-label="Assign assistant"
                        value={taskBotId}
                        onChange={(event) => setTaskBotId(event.target.value)}
                      >
                        {bootstrap.bots.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.name}
                          </option>
                        ))}
                      </NativeSelect>
                      <Input
                        placeholder="Notes (optional)"
                        value={taskNotes}
                        onChange={(event) => setTaskNotes(event.target.value)}
                      />
                      <Button
                        type="submit"
                        className="primary"
                        disabled={creatingTask || !taskTitle.trim()}
                      >
                        Add
                      </Button>
                    </div>
                  </form>
                )}
                {tasks.length > 0 && (
                  <div className="today-triage-stack">
                    {tasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onDone={() => void today.reload()}
                        onOpen={(id) => onOpen(id)}
                        onError={setTriageError}
                      />
                    ))}
                  </div>
                )}
                {!tasks.length && !addingTask && (
                  <p className="today-empty">
                    No open tasks. Assistants add background tasks here for your sign-off.
                  </p>
                )}
              </section>
            )}

            {readyDrafts.length > 0 && (
              <section className="today-section" aria-labelledby="today-drafts-title">
                <h3 id="today-drafts-title">
                  Ready to review <span>{readyDrafts.length}</span>
                </h3>
                <div className="today-triage-stack">
                  {readyDrafts.map((entry) => (
                    <article
                      className="today-triage-card"
                      key={`${entry.botId}:${entry.messageId}:${entry.card.id}`}
                    >
                      <div className="today-triage-top">
                        <span className="today-pill">
                          {entry.card.type === "email" ? "Email draft" : "Calendar event"}
                        </span>
                        <small>{entry.botName}</small>
                      </div>
                      {entry.card.type === "email" ? (
                        <EmailDraftCard card={entry.card} />
                      ) : (
                        <div className="today-event-draft">
                          <strong>{entry.card.title}</strong>
                          <p className="muted">
                            {entry.card.start}
                            {entry.card.location ? ` · ${entry.card.location}` : ""}
                          </p>
                          <div className="today-triage-buttons">
                            <a
                              className="button primary"
                              href={eventGoogleCalendarUrl(entry.card)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open in Calendar
                            </a>
                            <Button onClick={() => onOpen(entry.botId)}>Open chat</Button>
                          </div>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            )}

            <section className="today-section" aria-labelledby="today-recap-title">
              <div className="today-section-heading">
                <h3 id="today-recap-title">Since you were away</h3>
                <button type="button" disabled={seen.busy} onClick={() => void caughtUp()}>
                  {overview.hasMore ? "Mark this page caught up" : "Mark caught up"}
                </button>
              </div>
              <p className="today-section-note">
                Since <When value={overview.since} inline />
              </p>
              {!overview.events.length && (
                <p className="today-empty">You're caught up. New results will appear here.</p>
              )}
              {overview.events.map((event) => {
                const name = bot(event.botId)?.name || "Assistant";
                return (
                  <button
                    className="today-row"
                    type="button"
                    key={event.id}
                    onClick={() =>
                      event.routineId ? onOpen(event.botId, event.routineId) : onOpen(event.botId)
                    }
                  >
                    {avatar(event.botId, name)}
                    <span className="today-row-copy">
                      <strong>{eventHeadline(event)}</strong>
                      <small>
                        {name} · <When value={event.occurredAt} />
                      </small>
                    </span>
                    <Icon name="chevron" size={16} />
                  </button>
                );
              })}
              {overview.hasMore && (
                <p className="today-section-note today-more">
                  More results are waiting. Mark this page caught up to see them.
                </p>
              )}
            </section>
            {(!!working.length || !!overview.upcoming?.length) && (
              <section className="today-section" aria-labelledby="today-next-title">
                <h3 id="today-next-title">Up next</h3>
                {working.map((item) => (
                  <button
                    className="today-row"
                    type="button"
                    key={item.botId}
                    onClick={() => onOpen(item.botId)}
                  >
                    {avatar(item.botId, item.botName)}
                    <span className="today-row-copy">
                      <strong>{item.activity.detail || item.botName}</strong>
                      <small>
                        {item.activity.detail && <>{item.botName} · </>}
                        {stateLabels[item.activity.state]}
                      </small>
                    </span>
                    <Icon name="chevron" size={16} />
                  </button>
                ))}
                {overview.upcoming?.map((row) => {
                  const name = bot(row.botId)?.name || "Assistant";
                  return (
                    <button
                      className="today-row"
                      type="button"
                      key={row.id}
                      onClick={() => onOpen(row.botId, row.id)}
                    >
                      {avatar(row.botId, name)}
                      <span className="today-row-copy">
                        <strong>{row.name}</strong>
                        <small>
                          {name} · Scheduled
                          {row.nextRunAt && (
                            <>
                              {" "}
                              · <When value={row.nextRunAt} />
                            </>
                          )}
                        </small>
                      </span>
                      <Icon name="chevron" size={16} />
                    </button>
                  );
                })}
              </section>
            )}
            {!!files.length && (
              <section className="today-section" aria-labelledby="today-files-title">
                <div className="today-section-heading">
                  <h3 id="today-files-title">Recent files</h3>
                  {onOutputs && (
                    <button type="button" onClick={onOutputs}>
                      Browse all outputs
                    </button>
                  )}
                </div>
                {files.map((item) => (
                  <button
                    className="today-row"
                    type="button"
                    key={item.botId}
                    onClick={() => onOpen(item.botId)}
                  >
                    {avatar(item.botId, item.botName)}
                    <span className="today-row-copy">
                      <span className="today-file-list">
                        {item.files.slice(-3).map((file) => (
                          <span className="today-file" key={file.id}>
                            <Icon name="file" size={14} />
                            {file.name}
                          </span>
                        ))}
                      </span>
                      <small>{item.botName}</small>
                    </span>
                    <Icon name="chevron" size={16} />
                  </button>
                ))}
              </section>
            )}
            {pending.length > 0 && (
              <p role="status" className="capability-note">
                Still checking {pending.map((item) => item.botName).join(", ")}.
              </p>
            )}
            {unchecked.length > 0 && (
              <p role="status" className="capability-note">
                Couldn't check {unchecked.length} assistant{unchecked.length === 1 ? "" : "s"}.
                Their current activity is unknown.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
