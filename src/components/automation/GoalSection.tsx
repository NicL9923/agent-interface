import { useEffect, useId, useRef, useState } from "react";
import { request } from "../../client-api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { fire } from "../../app/fire";
import type { Controls } from "./use-automation";

export function GoalSection({ control, intentKey }: { control: Controls; intentKey?: string }) {
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
    try {
      const saved = intentKey && localStorage.getItem(intentKey);
      if (saved && /^[a-f0-9-]{36}$/i.test(saved)) return saved;
    } catch {
      /* In-memory retries still share one intent. */
    }
    return crypto.randomUUID();
  });
  const [reviewed, setReviewed] = useState(false);
  const [reviewedNewAttempt, setReviewedNewAttempt] = useState(false);
  const [replacementConfirmed, setReplacementConfirmed] = useState(false);
  const freshIntent = () => {
    setResumeId(crypto.randomUUID());
    if (intentKey)
      try {
        localStorage.removeItem(intentKey);
      } catch {}
  };
  useEffect(() => {
    if (state.resume?.requestId === resumeId && state.resume.status !== "uncertain") freshIntent();
  }, [state.resume?.requestId, state.resume?.status, resumeId, intentKey]);
  const goal = state.goal;
  useEffect(() => {
    if (!returnFocus || editing || clear || control.disabled) return;
    const opener = goal
      ? returnFocus === "clear"
        ? clearOpener.current
        : replaceOpener.current
      : setOpener.current;
    if (opener) {
      opener.focus();
      setReturnFocus(null);
    }
  }, [returnFocus, editing, clear, control.disabled, goal]);
  const statusLabels: Record<string, string> = { active: "Active", paused: "Paused", done: "Done" };
  const receipt = state.resume;
  const receiptVisible = receipt?.status === "uncertain" || receipt?.status === "rejected";
  const resumeDisabled =
    !goal ||
    control.disabled ||
    editing ||
    clear ||
    !["active", "paused"].includes(goal.status) ||
    (goal.status !== "active" &&
      (receipt?.status === "uncertain" || (!!state.interruptionPending && !reviewed)));
  const descriptionIds = [
    state.interruptionPending ? `${goalId}-interruption` : "",
    receipt?.status === "uncertain" ? `${goalId}-receipt` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <section className="automation-section automation-goal">
      <h3>Standing goal</h3>
      {!state.supported ? (
        <p className="capability-note">
          {state.reason || "Goals are unavailable on this Hermes installation."}
        </p>
      ) : (
        <>
          {goal ? (
            <div className="automation-goal-card">
              <p className="automation-goal-title">{goal.title}</p>
              <p className="automation-goal-meta">
                <span
                  className={`automation-goal-status${goal.status === "active" ? " is-active" : ""}`}
                >
                  {Object.hasOwn(statusLabels, goal.status)
                    ? statusLabels[goal.status]
                    : goal.status}
                </span>
                <span>
                  {goal.turnsUsed} of {goal.maxTurns} turns used
                </span>
              </p>
              {goal.pausedReason && (
                <p className="automation-goal-reason">
                  {goal.status === "paused" ? "Paused: " : ""}
                  {goal.pausedReason}
                </p>
              )}
              {receiptVisible && (
                <div
                  id={`${goalId}-receipt`}
                  className={`automation-goal-callout${receipt?.status === "rejected" ? " is-danger" : ""}`}
                >
                  <strong>
                    {receipt?.status === "uncertain" ? "Resume not confirmed" : "Resume rejected"}
                  </strong>
                  <p>
                    {receipt?.message ||
                      (receipt?.status === "uncertain"
                        ? "Hermes could not confirm this goal continuation. Review the conversation before trying again."
                        : "Hermes refused to start this goal. Review its status before resuming.")}
                  </p>
                </div>
              )}
              {state.interruptionPending && (
                <div
                  id={`${goalId}-interruption`}
                  className="automation-confirm automation-goal-callout"
                >
                  <p>
                    Review the interrupted work in this assistant's conversation before resuming.
                  </p>
                  <label className="automation-check">
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(event) => setReviewed(event.target.checked)}
                    />
                    I've reviewed the interrupted work in this conversation.
                  </label>
                </div>
              )}
              {receipt?.status === "uncertain" && (
                <div className="automation-confirm automation-goal-attempt">
                  <p>
                    The previous attempt may have started work. Refresh status and review this
                    assistant's conversation before starting again.
                  </p>
                  <label className="automation-check">
                    <input
                      type="checkbox"
                      checked={reviewedNewAttempt}
                      onChange={(event) => setReviewedNewAttempt(event.target.checked)}
                    />
                    I've reviewed the conversation and want to start a new attempt.
                  </label>
                  <Button
                    className={
                      !control.disabled &&
                      !editing &&
                      !clear &&
                      reviewedNewAttempt &&
                      goal.status === "paused"
                        ? "primary"
                        : undefined
                    }
                    disabled={
                      control.disabled ||
                      editing ||
                      clear ||
                      !reviewedNewAttempt ||
                      goal.status !== "paused"
                    }
                    onClick={fire(async () => {
                      const requestId = crypto.randomUUID();
                      setResumeId(requestId);
                      if (intentKey)
                        try {
                          localStorage.setItem(intentKey, requestId);
                        } catch {}
                      const result = await control.change(
                        () =>
                          request("POST /bots/:id/automation/goal/resume", {
                            params: { id: control.botId },
                            body: { requestId, reviewedInterruption: true },
                          }),
                        freshIntent,
                      );
                      setReviewedNewAttempt(false);
                      if (result && result.goals.resume?.status !== "uncertain") {
                        freshIntent();
                        setReviewed(false);
                      }
                    })}
                  >
                    Start a new attempt
                  </Button>
                </div>
              )}
              <div className="actions automation-goal-actions">
                {goal.status !== "done" && (
                  <Button
                    className={!resumeDisabled ? "primary" : undefined}
                    disabled={resumeDisabled}
                    aria-describedby={descriptionIds || undefined}
                    onClick={fire(async () => {
                      const active = goal.status === "active";
                      if (!active && intentKey)
                        try {
                          localStorage.setItem(intentKey, resumeId);
                        } catch {}
                      const result = await control.change(
                        () =>
                          active
                            ? request("POST /bots/:id/automation/goal/pause", {
                                params: { id: control.botId },
                                body: {},
                              })
                            : request("POST /bots/:id/automation/goal/resume", {
                                params: { id: control.botId },
                                body: {
                                  requestId: resumeId,
                                  ...(state.interruptionPending && reviewed
                                    ? { reviewedInterruption: true }
                                    : {}),
                                },
                              }),
                        active ? undefined : freshIntent,
                      );
                      if (!active && result?.goals.resume?.status !== "uncertain" && result) {
                        freshIntent();
                        setReviewed(false);
                      }
                    })}
                  >
                    {goal.status === "active" ? "Pause goal" : "Resume goal"}
                  </Button>
                )}
                <Button
                  ref={replaceOpener}
                  disabled={control.disabled || editing || clear}
                  onClick={() => {
                    setTitle(goal.title);
                    setMaxTurns(goal.maxTurns);
                    setReplacementConfirmed(false);
                    setEditing(true);
                  }}
                >
                  Replace goal…
                </Button>
                <Button
                  ref={clearOpener}
                  className="danger automation-goal-clear"
                  disabled={control.disabled || editing || clear}
                  onClick={() => setClear(true)}
                >
                  Clear goal…
                </Button>
              </div>
              {clear && (
                <div className="automation-confirm">
                  <p>Clear this standing goal? The conversation stays saved.</p>
                  <div className="actions">
                    <Button
                      autoFocus
                      onClick={() => {
                        setClear(false);
                        setReturnFocus("clear");
                      }}
                    >
                      Keep goal
                    </Button>
                    <Button
                      className="danger"
                      disabled={control.disabled}
                      onClick={fire(async () => {
                        if (
                          await control.change(() =>
                            request("POST /bots/:id/automation/goal/clear", {
                              params: { id: control.botId },
                              body: {},
                            }),
                          )
                        ) {
                          setClear(false);
                          setReturnFocus("clear");
                        }
                      })}
                    >
                      Clear goal
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="muted">
              No standing goal. A goal keeps working across turns until it finishes, pauses, or
              reaches its budget.
            </p>
          )}
          {!editing && !goal && (
            <Button
              ref={setOpener}
              className="primary"
              onClick={() => setEditing(true)}
              disabled={control.disabled}
            >
              Set a goal
            </Button>
          )}
          {editing && (
            <form
              className="automation-form"
              onSubmit={fire(async (event) => {
                event.preventDefault();
                if (goal && !replacementConfirmed) return;
                if (
                  await control.change(() =>
                    request("PUT /bots/:id/automation/goal", {
                      params: { id: control.botId },
                      body: { title, maxTurns },
                    }),
                  )
                ) {
                  setEditing(false);
                  setReturnFocus(goal ? "replace" : "set");
                  freshIntent();
                  setReviewed(false);
                  setReviewedNewAttempt(false);
                }
              })}
            >
              <label>
                Objective
                <textarea
                  autoFocus
                  required
                  maxLength={10000}
                  rows={3}
                  placeholder="What should the assistant work toward?"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  disabled={control.disabled}
                />
              </label>
              <label>
                Continuation turn budget
                <Input
                  required
                  type="number"
                  min={1}
                  max={1000}
                  value={maxTurns}
                  onChange={(event) => setMaxTurns(Number(event.target.value))}
                  disabled={control.disabled}
                />
              </label>
              <p className="muted">
                Saves paused. Resume it when you're ready for the assistant to work.
              </p>
              {goal && (
                <div className="automation-confirm">
                  <p>
                    Replacing this goal resets its progress and removes its native subgoals,
                    completion contracts and verification gates. The conversation stays saved.
                  </p>
                  <label className="automation-check">
                    <input
                      type="checkbox"
                      checked={replacementConfirmed}
                      onChange={(event) => setReplacementConfirmed(event.target.checked)}
                    />
                    Replace the entire standing goal.
                  </label>
                </div>
              )}
              <div className="actions">
                <Button
                  type="submit"
                  className="primary"
                  disabled={control.disabled || !title.trim() || (!!goal && !replacementConfirmed)}
                >
                  {goal ? "Replace with paused goal" : "Save paused goal"}
                </Button>
                <Button
                  disabled={control.disabled}
                  onClick={() => {
                    setEditing(false);
                    setReturnFocus(goal ? "replace" : "set");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
