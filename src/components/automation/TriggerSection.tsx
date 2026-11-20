import { useEffect, useId, useRef, useState } from "react";
import { request } from "../../client-api";
import { routeUrl } from "../../shared/api";
import { useResource, type Resource } from "../../app/use-resource";
import type { Routine } from "../../shared/types";
import type { EventSubscription, TriggerInput } from "../../shared/automation";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { fire } from "../../app/fire";
import { taskFeedbackStyle } from "./TaskSection";
import type { Controls } from "./use-automation";

export function likelyCreatedTrigger(
  knownIds: string[],
  draftId: string,
  items: EventSubscription[],
) {
  return knownIds.includes(draftId) ? undefined : items.find((item) => item.id === draftId);
}

export function TriggerSection({
  control,
  botId,
  shared,
}: {
  control: Controls;
  botId: string;
  shared?: Resource<Routine[]>;
}) {
  const state = control.value!.triggers;
  const canManage = control.value!.canManageTriggers === true;
  const own = useResource(state.supported && !shared ? routeUrl("GET /routines", {}) : null, {
    load: (_, signal) => request("GET /routines", { signal }),
  });
  const routineList = shared ?? own;
  const routines = routineList.data?.filter((row) => row.botId === botId) ?? [];
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EventSubscription>();
  const [draft, setDraft] = useState<TriggerInput>({
    id: "",
    description: "",
    events: [],
    routineId: "",
  });
  const [events, setEvents] = useState("");
  const [secret, setSecret] = useState<{ id: string; url: string; secret: string }>();
  const [reveal, setReveal] = useState(false);
  const [seen, setSeen] = useState(false);
  const [copyResult, setCopyResult] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState("");
  const [feedback, setFeedback] = useState<
    Record<string, { message: string; kind: "saved" | "refused" | "uncertain" }>
  >({});
  const [announcement, setAnnouncement] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [attempt, setAttempt] = useState<{
    knownIds: string[];
    payload: TriggerInput;
    refreshCount: number;
  }>();
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
  const likely =
    reviewed && attempt
      ? likelyCreatedTrigger(attempt.knownIds, attempt.payload.id, state.items)
      : undefined;
  const unconfirmed = !!attempt && control.uncertain;
  const stale = editing && state.items.find((item) => item.id === editing.id);
  const staleMessage =
    editing &&
    (!stale
      ? "This trigger is no longer in Hermes."
      : stale.revision !== editing.revision
        ? "This trigger changed. Close this editor and review its current settings before editing again."
        : "");
  useEffect(() => {
    if (!focus) return;
    const target =
      focus === "secret"
        ? secretHeading.current
        : focus === "create-opener"
          ? createOpener.current
          : focus === "create-feedback"
            ? section.current?.querySelector<HTMLElement>("form .automation-trigger-feedback")
            : focus.startsWith("edit-opener:")
              ? Array.from(
                  section.current?.querySelectorAll<HTMLElement>("[data-trigger-id]") ?? [],
                )
                  .find((row) => row.dataset.triggerId === focus.slice(12))
                  ?.querySelector<HTMLElement>(".trigger-edit-opener")
              : (Array.from(
                  section.current?.querySelectorAll<HTMLElement>("[data-trigger-id]") ?? [],
                )
                  .find((row) => row.dataset.triggerId === focus)
                  ?.querySelector<HTMLElement>(".automation-trigger-feedback") ??
                Array.from(
                  section.current?.querySelectorAll<HTMLElement>(".automation-trigger-removed") ??
                    [],
                ).find((row) => row.dataset.triggerId === focus));
    if (focus === "secret") {
      secretPanel.current?.scrollIntoView?.({ block: "start" });
      target?.focus({ preventScroll: true });
    } else target?.focus();
    setFocus("");
  }, [focus, control.value, secret]);
  useEffect(() => {
    const phase = unconfirmed
      ? "unconfirmed"
      : likely
        ? `match:${likely.id}`
        : reviewed
          ? "missing"
          : "";
    if (!creating || !phase || !createMessage.current) return;
    const key = `${attempt?.refreshCount}:${control.refreshCount}:${phase}`;
    if (focusedPhase.current === key) return;
    focusedPhase.current = key;
    createMessage.current.focus();
    setAnnouncement(createMessage.current.textContent || "");
  }, [creating, unconfirmed, likely, reviewed, attempt, control.refreshCount]);
  const publish = (
    triggerId: string,
    message: string,
    kind: "saved" | "refused" | "uncertain" = "saved",
  ) => {
    setFeedback((previous) => ({ ...previous, [triggerId]: { message, kind } }));
    setAnnouncement(message);
    setFocus(triggerId);
  };
  useEffect(() => {
    if (!staleMessage) return;
    const target = section.current?.querySelector<HTMLElement>("form .automation-trigger-feedback");
    target?.focus();
    setAnnouncement(staleMessage);
  }, [staleMessage]);
  const clearFeedback = (triggerId: string) => {
    if (feedback[triggerId]?.message === announcement) setAnnouncement("");
    setFeedback((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([key]) => key !== triggerId)),
    );
  };
  const clearCreateRefusal = () => {
    if (createRefusal?.message === announcement) setAnnouncement("");
    setCreateRefusal(undefined);
  };
  const run = async (triggerId: string, send: () => Promise<unknown>, success: string) => {
    const result = await control.changeTask(send);
    const message = !result
      ? "Not confirmed. Use Refresh status at the top of Work."
      : result.kind === "refused"
        ? `${result.message}${result.refreshed === false ? "" : " Status refreshed."}`
        : success;
    publish(triggerId, message, !result ? "uncertain" : result.kind);
    return result?.kind === "saved";
  };
  const copy = async (kind: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyResult((previous) => ({ ...previous, [kind]: "Copied." }));
      if (kind === "secret") setSeen(true);
    } catch {
      setCopyResult((previous) => ({ ...previous, [kind]: "Couldn't copy. Try again." }));
    }
  };
  const form = (edit?: EventSubscription) => (
    <form
      className="automation-form"
      aria-labelledby={`${id}-heading`}
      onSubmit={fire(async (event) => {
        event.preventDefault();
        if (control.disabled || likely || staleMessage) return;
        const payload =
          reviewed && attempt
            ? attempt.payload
            : {
                ...draft,
                events: events
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean),
              };
        if (!edit) clearCreateRefusal();
        if (!edit)
          setAttempt({
            knownIds: state.items.map((item) => item.id),
            payload,
            refreshCount: control.refreshCount,
          });
        setSubmitting(true);
        let created: { subscription: EventSubscription; secret?: string } | undefined;
        const result = await control.changeTask(async () => {
          if (edit)
            return request("PUT /bots/:id/automation/triggers/:triggerId", {
              params: { id: botId, triggerId: edit.id },
              body: {
                description: payload.description,
                events: payload.events,
                routineId: payload.routineId,
                revision: edit.revision,
              },
            });
          created = await request("POST /bots/:id/automation/triggers", {
            params: { id: botId },
            body: payload,
          });
          return created;
        });
        setSubmitting(false);
        if (created?.secret) {
          setAttempt(undefined);
          setCreating(false);
          setSecret({
            id: created.subscription.id,
            url: created.subscription.url,
            secret: created.secret,
          });
          setReveal(false);
          setSeen(false);
          setCopyResult({});
          setAnnouncement(`${created.subscription.id} was created. Save its signing secret now.`);
          setFocus("secret");
          return;
        }
        if (!result) {
          if (edit)
            publish(edit.id, "Not confirmed. Use Refresh status at the top of Work.", "uncertain");
          return;
        }
        if (result.kind === "refused") {
          const message = `${result.message}${result.refreshed === false ? "" : " Status refreshed."}`;
          if (edit) {
            const refreshed = result.overview.triggers.items.find((item) => item.id === edit.id);
            if (!refreshed || refreshed.revision !== edit.revision) clearFeedback(edit.id);
            else publish(edit.id, message, "refused");
          } else {
            setAttempt(undefined);
            setCreateRefusal({ id: payload.id, message });
            setAnnouncement(message);
            setFocus("create-feedback");
          }
          return;
        }
        setAttempt(undefined);
        if (edit) {
          setEditing(undefined);
          publish(edit.id, "Saved in Hermes.");
        }
      })}
    >
      <h4 id={`${id}-heading`}>{edit ? "Edit trigger" : "New event trigger"}</h4>
      {edit ? (
        <p>Trigger ID: {edit.id}</p>
      ) : (
        <div className="automation-trigger-field">
          <label htmlFor={`${id}-trigger-id`}>Trigger ID</label>
          <Input
            id={`${id}-trigger-id`}
            autoFocus
            required
            pattern="[a-z0-9][a-z0-9_-]{0,79}"
            maxLength={80}
            aria-describedby={`${id}-id-hint`}
            value={draft.id}
            disabled={control.disabled || !!likely || reviewed}
            onChange={(event) => {
              clearCreateRefusal();
              setDraft({ ...draft, id: event.target.value });
            }}
          />
          <p id={`${id}-id-hint`} className="muted">
            Use lowercase letters, numbers, underscores or hyphens. Start with a letter or number,
            up to 80 characters.
          </p>
        </div>
      )}
      <div className="automation-trigger-field">
        <label htmlFor={`${id}-description`}>Description (optional)</label>
        <textarea
          id={`${id}-description`}
          autoFocus={!!edit}
          rows={2}
          maxLength={1000}
          value={draft.description}
          disabled={control.disabled || !!likely || reviewed}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </div>
      <div className="automation-trigger-field">
        <label htmlFor={`${id}-events`}>Event names</label>
        <Input
          id={`${id}-events`}
          required
          aria-describedby={`${id}-events-hint`}
          value={events}
          disabled={control.disabled || !!likely || reviewed}
          onChange={(event) => setEvents(event.target.value)}
          placeholder="issue.created, issue.closed"
        />
        <p id={`${id}-events-hint`} className="muted">
          Choose 1 to 20 event names, separated by commas. Each name can contain 1 to 100 letters,
          digits, _, ., *, : or -.
        </p>
      </div>
      <label>
        Routine
        <NativeSelect
          required
          value={draft.routineId}
          disabled={control.disabled || !!likely || reviewed}
          onChange={(event) => setDraft({ ...draft, routineId: event.target.value })}
        >
          <option value="">Choose a routine</option>
          {routines.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
              {row.enabled ? "" : " (paused)"}
            </option>
          ))}
        </NativeSelect>
      </label>
      <p className="muted">
        {!edit && "New triggers start disabled. "}The selected routine must also be enabled to run.
      </p>
      {staleMessage && (
        <p className="automation-trigger-feedback form-error" tabIndex={-1}>
          {staleMessage}
        </p>
      )}
      {edit && !staleMessage && feedback[edit.id] && (
        <p
          className={`automation-trigger-feedback ${taskFeedbackStyle(feedback[edit.id])}`}
          tabIndex={-1}
        >
          {feedback[edit.id].message}
        </p>
      )}
      {!edit && (unconfirmed || reviewed) && (
        <p
          ref={createMessage}
          className={`automation-trigger-feedback ${unconfirmed || likely ? "automation-trigger-callout" : "form-notice"}`}
          tabIndex={-1}
        >
          {unconfirmed
            ? "Not confirmed. Hermes may have created this trigger. Use Refresh status at the top of Work before trying again."
            : likely
              ? `${likely.id} is now in Hermes. This request probably created it, but this app never received its signing secret. To get a secret, delete ${likely.id} and create it again.`
              : "No trigger with this ID is in Hermes. Create trigger sends the same request again."}
        </p>
      )}
      {!edit && createRefusal?.id === draft.id && (
        <p className="automation-trigger-feedback form-error" tabIndex={-1}>
          {createRefusal.message}
        </p>
      )}
      {!edit && <p className="muted">Finish or cancel this new trigger before editing another.</p>}
      <div className="actions">
        {likely ? (
          <Button
            className="primary"
            onClick={() => {
              setCreating(false);
              setAttempt(undefined);
              publish(
                likely.id,
                `${likely.id} is now in Hermes. This app never received its signing secret.`,
              );
            }}
          >
            Close
          </Button>
        ) : (
          <Button
            type="submit"
            className="primary"
            disabled={
              control.disabled || !!staleMessage || !draft.id || !draft.routineId || !events.trim()
            }
          >
            {submitting
              ? edit
                ? "Saving…"
                : "Creating…"
              : edit
                ? "Save trigger"
                : "Create trigger"}
          </Button>
        )}
        {!likely && (
          <Button
            disabled={submitting}
            onClick={() => {
              if (edit) {
                setEditing(undefined);
                setFocus(`edit-opener:${edit.id}`);
              } else {
                clearCreateRefusal();
                setCreating(false);
                setAttempt(undefined);
                setFocus("create-opener");
              }
            }}
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
  return (
    <section className="automation-section automation-triggers" ref={section}>
      <h3>Event triggers</h3>
      <p
        className="sr-only"
        role="status"
        aria-label="Trigger result"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
      {Object.entries(feedback)
        .filter(
          ([triggerId]) =>
            !state.items.some((item) => item.id === triggerId) &&
            (!creating || triggerId !== draft.id) &&
            !(staleMessage && triggerId === editing?.id),
        )
        .map(([triggerId, message]) => (
          <p
            key={triggerId}
            data-trigger-id={triggerId}
            className={`automation-trigger-feedback automation-trigger-removed ${taskFeedbackStyle(message)}`}
            tabIndex={-1}
          >
            {message.message}
          </p>
        ))}
      {!state.supported ? (
        <p className="capability-note">
          {state.reason || "Event triggers are unavailable on this Hermes installation."}
        </p>
      ) : (
        <>
          <p className="muted">
            Run an existing routine when a service sends Hermes a matching event.
          </p>
          {!canManage && (
            <p className="capability-note">
              Only an integration administrator can change event triggers.
            </p>
          )}
          {!state.platformEnabled && (
            <p className="capability-note">
              The installer must enable Hermes's webhook channel before events can arrive.
            </p>
          )}
          {routineList.loading && <p role="status">Loading routines…</p>}
          {routineList.error && (
            <div>
              <p className="form-error" role="alert">
                Couldn't load routines: {routineList.error}
              </p>
              <Button onClick={() => void routineList.reload()}>Retry routines</Button>
            </div>
          )}
          {!state.items.length && <p>No event triggers yet.</p>}
          {state.items.map((trigger) => {
            const routine = routines.find((row) => row.id === trigger.routineId);
            const missing = !routineList.loading && !routineList.error && !routine;
            return (
              <article className="automation-item" data-trigger-id={trigger.id} key={trigger.id}>
                <h4>{trigger.description || trigger.id}</h4>
                <span className="automation-trigger-status">
                  {trigger.enabled ? "Enabled" : "Disabled"}
                </span>
                <p>Events: {trigger.events.join(", ") || "All events"}</p>
                <p>
                  {routineList.loading
                    ? "Routine: loading…"
                    : routineList.error
                      ? `Routine ID: ${trigger.routineId}`
                      : routine
                        ? `Routine: ${routine.name}${routine.enabled ? "" : " · Paused"}`
                        : `Routine: ${trigger.routineId} · Not found`}
                </p>
                <p className="automation-trigger-label">Webhook URL</p>
                <code className="automation-url">{trigger.url}</code>
                {canManage &&
                  (editing?.id === trigger.id ? (
                    form(editing)
                  ) : (
                    <>
                      <div className="actions">
                        <Button
                          disabled={
                            control.disabled ||
                            (!trigger.enabled &&
                              (!state.platformEnabled ||
                                missing ||
                                routineList.loading ||
                                !!routineList.error))
                          }
                          onClick={() =>
                            void run(
                              trigger.id,
                              () =>
                                request("PATCH /bots/:id/automation/triggers/:triggerId", {
                                  params: { id: botId, triggerId: trigger.id },
                                  body: { enabled: !trigger.enabled, revision: trigger.revision },
                                }),
                              trigger.enabled ? "Disabled." : "Enabled.",
                            )
                          }
                        >
                          {trigger.enabled ? "Disable trigger" : "Enable trigger"}
                        </Button>
                        <Button
                          className="trigger-edit-opener"
                          disabled={control.disabled || creating}
                          onClick={() => {
                            clearFeedback(trigger.id);
                            setEditing(trigger);
                            setDraft({
                              id: trigger.id,
                              description: trigger.description,
                              events: trigger.events,
                              routineId: trigger.routineId,
                            });
                            setEvents(trigger.events.join(", "));
                          }}
                        >
                          Edit trigger
                        </Button>
                        <Button
                          disabled={control.disabled}
                          onClick={() => {
                            clearFeedback(trigger.id);
                            setDeleting(trigger.id);
                          }}
                        >
                          Delete trigger…
                        </Button>
                      </div>
                      {!trigger.enabled && !state.platformEnabled && (
                        <p className="muted">
                          Can't enable until the installer turns on Hermes's webhook channel.
                        </p>
                      )}
                      {!trigger.enabled && missing && (
                        <p className="muted">
                          {creating
                            ? "Its routine is no longer available. Finish or cancel the new trigger, then edit this trigger to choose another routine."
                            : "Its routine is no longer available. Edit the trigger to choose another routine before enabling it."}
                        </p>
                      )}
                      {!trigger.enabled && routineList.loading && (
                        <p className="muted">Routines are still loading.</p>
                      )}
                      {!trigger.enabled && routineList.error && (
                        <p className="muted">
                          Routines couldn't load. Retry routines before enabling this trigger.
                        </p>
                      )}
                      {deleting === trigger.id && (
                        <div className="automation-confirm">
                          <p>
                            {trigger.description || trigger.id} will be removed. Its routine stays
                            saved.
                          </p>
                          <div className="actions">
                            <Button
                              className="danger"
                              disabled={control.disabled}
                              onClick={fire(async () => {
                                if (
                                  await run(
                                    trigger.id,
                                    () =>
                                      request("DELETE /bots/:id/automation/triggers/:triggerId", {
                                        params: { id: botId, triggerId: trigger.id },
                                        body: { revision: trigger.revision },
                                      }),
                                    `Deleted ${trigger.id}.`,
                                  )
                                )
                                  setDeleting("");
                              })}
                            >
                              Delete trigger
                            </Button>
                            <Button onClick={() => setDeleting("")}>Keep trigger</Button>
                          </div>
                        </div>
                      )}
                      {feedback[trigger.id] && (
                        <p
                          className={`automation-trigger-feedback ${taskFeedbackStyle(feedback[trigger.id])}`}
                          tabIndex={-1}
                        >
                          {feedback[trigger.id].message}
                        </p>
                      )}
                    </>
                  ))}
              </article>
            );
          })}
          {editing && !stale && form(editing)}
          {secret && (
            <div className="automation-secret" ref={secretPanel}>
              <h4 ref={secretHeading} tabIndex={-1}>
                Save this signing secret now
              </h4>
              <p>{secret.id} was created and starts disabled.</p>
              <p>
                Hermes shows it once. Configure the sending service with this URL and secret.
                Leaving Automation or reloading the page clears it from this screen.
              </p>
              <div className="automation-secret-field">
                <p>Webhook URL</p>
                <code className="automation-secret-value">{secret.url}</code>
                {typeof navigator.clipboard?.writeText === "function" && (
                  <div>
                    <Button onClick={() => void copy("url", secret.url)}>Copy URL</Button>{" "}
                    <span role="status">{copyResult.url}</span>
                  </div>
                )}
              </div>
              <div className="automation-secret-field">
                <p>Signing secret</p>
                {reveal ? (
                  <code className="automation-secret-value">{secret.secret}</code>
                ) : (
                  <p className="muted">Hidden</p>
                )}
                <div className="actions">
                  <Button
                    onClick={() => {
                      setReveal(!reveal);
                      setSeen(true);
                    }}
                  >
                    {reveal ? "Hide secret" : "Show secret"}
                  </Button>
                  {typeof navigator.clipboard?.writeText === "function" && (
                    <Button onClick={() => void copy("secret", secret.secret)}>Copy secret</Button>
                  )}
                  <span role="status">{copyResult.secret}</span>
                </div>
              </div>
              {!seen && <p className="muted">Copy or show the secret first.</p>}
              <div className="actions">
                <Button
                  disabled={!seen}
                  onClick={() => {
                    const triggerId = secret.id;
                    setSecret(undefined);
                    setReveal(false);
                    setSeen(false);
                    publish(
                      triggerId,
                      state.items.some((item) => item.id === triggerId)
                        ? "Saved in Hermes."
                        : `${triggerId} was created. Refresh status to see its current settings.`,
                    );
                  }}
                >
                  I've saved it
                </Button>
              </div>
            </div>
          )}
          {canManage &&
            !secret &&
            !editing &&
            (creating ? (
              form()
            ) : (
              <Button
                ref={createOpener}
                disabled={
                  control.disabled || routineList.loading || !!routineList.error || !routines.length
                }
                aria-describedby={
                  !routineList.loading && !routineList.error && !routines.length
                    ? `${id}-routine-hint`
                    : undefined
                }
                onClick={() => {
                  setEditing(undefined);
                  setDraft({
                    id: "",
                    description: "",
                    events: [],
                    routineId: routines[0]?.id || "",
                  });
                  setEvents("");
                  setAttempt(undefined);
                  setCreating(true);
                }}
              >
                New event trigger
              </Button>
            ))}
          {!routines.length && !routineList.loading && !routineList.error && (
            <p id={`${id}-routine-hint`} className="muted">
              Add a routine above first.
            </p>
          )}
        </>
      )}
    </section>
  );
}
