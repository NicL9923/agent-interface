import { useEffect, useId, useRef, useState } from "react";
import { request } from "../../client-api";
import type { Bootstrap, Routine } from "../../shared/types";
import { routineRoomChoices, type GroupCatalog } from "../../shared/collaboration";
import type { useAction } from "../use-action";
import { useResource } from "../use-resource";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { RoutineEnhancements, RoutineSchedulePreview } from "../../components/RoutineEnhancements";
import { AdvancedRoutineFields } from "../../components/AdvancedRoutineFields";
import { routinePresets } from "../../shared/routine-presets";
import { runsHidden, withRunsShown } from "../../shared/routine-runs";
import { checkInFrequencyLabel, scheduleMinutes } from "../../shared/main-assistant";
import { usePreferenceEdits, type PreferenceEdit } from "../use-preference-edits";

export function RoutineManager({
  onOpenRoutine,
  botId,
  routines,
  reload,
  bootstrap,
  actions,
  editPreferences,
  advanced,
}: {
  onOpenRoutine?: (botId: string, routineId: string) => void;
  editPreferences?: (edit: PreferenceEdit) => Promise<void>;
  /** Advanced presentation shows per-routine overrides; Simple keeps them as saved. */
  advanced: boolean;
  botId: string;
  routines: Routine[];
  reload: () => Promise<void>;
  bootstrap: Bootstrap;
  /** The settings sheet's own action, so its error banner and busy state cover routines too. */
  actions: ReturnType<typeof useAction>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  // Showing runs in chat is this person's view of the conversation, not part of the routine.
  const [preferences, commitPreferences] = usePreferenceEdits(
    bootstrap.preferences,
    editPreferences ?? (async () => {}),
  );
  const editor = useRef<HTMLFormElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  function focusRoutine(id: string) {
    const button = editButtons.current.get(id);
    button?.scrollIntoView({ block: "nearest" });
    button?.focus({ preventScroll: true });
  }
  const editorId = useId();
  const [focusEditor, setFocusEditor] = useState(false);
  useEffect(() => {
    if (!focusEditor) return;
    editor.current?.scrollIntoView({ block: "start" });
    nameInput.current?.focus({ preventScroll: true });
    setFocusEditor(false);
  }, [focusEditor]);
  const [form, setForm] = useState<Omit<Routine, "id">>({
    botId,
    name: "",
    prompt: "",
    schedule: "",
    enabled: true,
    recipientIds: [],
    roomIds: [],
    contextFrom: ["self"],
  });
  const { busy } = actions;
  const [deleteId, setDeleteId] = useState("");
  const [previewedSchedule, setPreviewedSchedule] = useState("");
  const supported = bootstrap.capabilities.routines.supported;
  // Only its owner can receive a private assistant's results.
  const bot = bootstrap.bots.find((b) => b.id === botId);
  const recipients =
    bot && !bot.shared && bot.ownerId
      ? bootstrap.household.filter((user) => user.id === bot.ownerId)
      : bootstrap.household;
  const action = (work: () => Promise<unknown>) =>
    actions.run(async () => {
      await work();
      await reload();
    });
  // Group chats a routine can post in. A routine whose rooms the server could not read has no roomIds,
  // and so does a form while the catalog loads: neither shows nor sends rooms, so a save never drops one.
  const groups = useResource<GroupCatalog>(supported ? "/groups" : null);
  const roomChoices = routineRoomChoices(groups.data, bot, bootstrap.bots);
  const roomNames = (ids: string[] = []) =>
    ids
      .map((id) => groups.data?.rooms.find((room) => room.room_id === id)?.name)
      .filter(Boolean)
      .join(", ");
  const roomsShown =
    !!groups.data?.routineDelivery &&
    form.roomIds !== undefined &&
    (roomChoices.length > 0 || form.roomIds.length > 0);
  return (
    <div className="routine-manager">
      <p className="muted">
        Routines keep working when you are away. Choose notification recipients explicitly.
      </p>
      <h3>Routine recipes</h3>
      <div className="routine-presets" aria-label="Routine recipes">
        {routinePresets.map((preset) => (
          <Button
            type="button"
            className="routine-preset"
            key={preset.id}
            disabled={busy || !supported}
            onClick={() => {
              setEditing(null);
              setPreviewedSchedule("");
              setFocusEditor(true);
              setForm({
                botId,
                name: preset.name,
                prompt: preset.prompt,
                schedule: preset.schedule,
                enabled: false,
                recipientIds: [bootstrap.user.id],
                roomIds: [],
                contextFrom: ["self"],
              });
            }}
          >
            <strong>{preset.name}</strong>
            <small>{preset.description}</small>
          </Button>
        ))}
      </div>
      {routines.length > 0 && <h3>Saved routines</h3>}
      {routines.map((routine) =>
        routine.managed === "check-in" ? (
          // A member's check-ins: only their switch in the assistant's details changes them.
          <article className="routine-card routine-managed" key={routine.id}>
            <h4>{routine.name}</h4>
            <dl className="routine-meta">
              <div>
                <dt>Schedule</dt>
                <dd>
                  {(() => {
                    const hours = Math.round(scheduleMinutes(routine.schedule) / 60);
                    return Number.isFinite(hours) && hours > 0 ? (
                      checkInFrequencyLabel(hours)
                    ) : (
                      <code>{routine.schedule}</code>
                    );
                  })()}
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <span className="routine-status">Active</span>
                </dd>
              </div>
            </dl>
            <p className="muted">
              Check-ins for your main assistant. Change how often, or turn them off, in{" "}
              {bootstrap.bots.find((bot) => bot.id === botId)?.name ?? "its"} details.
            </p>
          </article>
        ) : (
          <article className="routine-card" key={routine.id}>
            <h4>{routine.name}</h4>
            <dl className="routine-meta">
              <div>
                <dt>Schedule</dt>
                <dd>
                  <code>{routine.schedule}</code>
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <span className={routine.enabled ? "routine-status" : "routine-status paused"}>
                    {routine.enabled ? "Active" : "Paused"}
                  </span>
                </dd>
              </div>
              {roomNames(routine.roomIds) && (
                <div>
                  <dt>Posts in</dt>
                  <dd>{roomNames(routine.roomIds)}</dd>
                </div>
              )}
            </dl>
            <p className="routine-prompt">{routine.prompt}</p>
            <RoutineEnhancements
              key={`${bootstrap.user.id}:${routine.id}`}
              routine={routine}
              userId={bootstrap.user.id}
              disabled={busy || !supported}
              onOpenResults={onOpenRoutine ? () => onOpenRoutine(botId, routine.id) : undefined}
            />
            {editPreferences && (
              <label className="checkbox-label routine-chat-toggle">
                <Input
                  type="checkbox"
                  checked={!runsHidden(preferences, botId, routine.id)}
                  onChange={(event) => {
                    const shown = event.target.checked;
                    commitPreferences((value) => withRunsShown(value, botId, routine.id, shown));
                  }}
                />
                <span>
                  Show runs in chat
                  <small className="muted">
                    Each run appears in{" "}
                    {bootstrap.bots.find((bot) => bot.id === botId)?.name ?? "this assistant"}'s
                    conversation for you.
                  </small>
                </span>
              </label>
            )}
            <div className="actions routine-management-actions">
              <Button
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    request("PUT /routines/:id", {
                      params: { id: routine.id },
                      body: {
                        ...routine,
                        enabled: !routine.enabled,
                        recipientIds: routine.recipientIds || [],
                        // Pausing leaves where it posts alone.
                        roomIds: undefined,
                      },
                    }),
                  )
                }
              >
                {routine.enabled ? "Pause" : "Resume"}
              </Button>
              <Button
                ref={(node) => {
                  if (node) editButtons.current.set(routine.id, node);
                  else editButtons.current.delete(routine.id);
                }}
                onClick={() => {
                  setEditing(routine.id);
                  setFocusEditor(true);
                  setPreviewedSchedule("");
                  setForm(routine);
                }}
              >
                Edit
              </Button>
              {deleteId === routine.id ? (
                <>
                  <Button
                    className="danger"
                    onClick={() =>
                      void action(() =>
                        request("DELETE /routines/:id", { params: { id: routine.id } }),
                      )
                    }
                  >
                    Confirm delete
                  </Button>
                  <Button onClick={() => setDeleteId("")}>Cancel</Button>
                </>
              ) : (
                <Button className="danger" onClick={() => setDeleteId(routine.id)}>
                  Delete
                </Button>
              )}
            </div>
          </article>
        ),
      )}
      <form
        ref={editor}
        aria-labelledby={`${editorId}-heading`}
        onSubmit={(e) => {
          e.preventDefault();
          if (previewedSchedule !== form.schedule) {
            actions.setError("Preview the schedule before saving this routine.");
            return;
          }
          if (form.noAgent && !form.script?.trim()) {
            actions.setError("Script-only routines require a profile script.");
            return;
          }
          if (!form.prompt.trim() && !form.script?.trim() && !form.skills?.length) {
            actions.setError("Add instructions, a skill, or a profile script.");
            return;
          }
          void action(async () => {
            const body = {
              ...form,
              recipientIds: (form.recipientIds || []).filter((id) =>
                recipients.some((user) => user.id === id),
              ),
              roomIds: roomsShown
                ? form.roomIds!.filter((id) => roomChoices.some((room) => room.room_id === id))
                : undefined,
            };
            await (editing
              ? request("PUT /routines/:id", { params: { id: editing }, body })
              : request("POST /routines", { body }));
            if (editing) focusRoutine(editing);
            setEditing(null);
            setPreviewedSchedule("");
            setForm({
              botId,
              name: "",
              prompt: "",
              schedule: "",
              enabled: true,
              recipientIds: [],
              roomIds: [],
              contextFrom: ["self"],
            });
          });
        }}
      >
        <h3 id={`${editorId}-heading`}>{editing ? "Edit routine" : "New routine"}</h3>
        <label>
          Name
          <Input
            ref={nameInput}
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label>
          Instructions
          <Textarea
            required={!form.noAgent && !form.script?.trim() && !form.skills?.length}
            rows={4}
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          />
        </label>
        <label>
          Schedule
          <Input
            required
            value={form.schedule}
            onChange={(e) => setForm({ ...form, schedule: e.target.value })}
            className="routine-schedule"
            placeholder="Hermes schedule expression"
          />
        </label>
        <RoutineSchedulePreview
          key={`schedule-${editing || "new"}`}
          botId={botId}
          schedule={form.schedule}
          onReady={setPreviewedSchedule}
        />
        {advanced && (
          <AdvancedRoutineFields
            key={`advanced-${editing ?? "new"}`}
            value={form}
            onChange={setForm}
            routines={routines}
            editing={editing}
          />
        )}
        <label className="checkbox-label">
          <Input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />{" "}
          Enabled
        </label>
        <fieldset>
          <legend>Notify these household members</legend>
          {recipients.map((user) => (
            <label className="checkbox-label" key={user.id}>
              <Input
                type="checkbox"
                checked={form.recipientIds?.includes(user.id) || false}
                onChange={(e) =>
                  setForm({
                    ...form,
                    recipientIds: e.target.checked
                      ? [...(form.recipientIds || []), user.id]
                      : (form.recipientIds || []).filter((id) => id !== user.id),
                  })
                }
              />
              {user.name}
            </label>
          ))}
        </fieldset>
        <p className="muted">
          No selected recipients means no completion notification. Routine results remain in the
          assistant conversation.
        </p>
        {roomsShown && (
          <>
            <fieldset>
              <legend>Also post results in these group chats</legend>
              {roomChoices.map((room) => (
                <label className="checkbox-label" key={room.room_id}>
                  <Input
                    type="checkbox"
                    checked={form.roomIds!.includes(room.room_id)}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        roomIds: event.target.checked
                          ? [...form.roomIds!, room.room_id]
                          : form.roomIds!.filter((id) => id !== room.room_id),
                      })
                    }
                  />
                  {room.name}
                </label>
              ))}
            </fieldset>
            <p className="muted">
              Results appear in the group as a message from this routine. Assistants answer it only
              when it @mentions them.
            </p>
          </>
        )}
        <div className="actions">
          <Button
            type="submit"
            className="primary"
            disabled={
              busy || !supported || previewedSchedule !== form.schedule || !form.schedule.trim()
            }
          >
            {busy ? "Saving…" : editing ? "Save routine" : "Add routine"}
          </Button>
          {editing && (
            <Button
              type="button"
              onClick={() => {
                focusRoutine(editing);
                setEditing(null);
                setPreviewedSchedule("");
                setForm({
                  botId,
                  name: "",
                  prompt: "",
                  schedule: "",
                  enabled: true,
                  recipientIds: [],
                  roomIds: [],
                  contextFrom: ["self"],
                });
              }}
            >
              Cancel edit
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
