import { useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { Icon } from "../../components/Icon";
import { ModelSelector } from "../../components/ModelSelector";
import { SettingsConfirmation } from "../../components/SettingsConfirmation";
import { interactiveReplyInstructions } from "../../shared/reply-cards";
import type { Bootstrap, Bot, BotInput } from "../../shared/types";

export function DescriptionField({
  form,
  setForm,
}: {
  form: BotInput;
  setForm: (form: BotInput) => void;
}) {
  return (
    <label htmlFor="assistant-description">
      <span id="assistant-description-label">Description</span>
      <Textarea
        id="assistant-description"
        aria-labelledby="assistant-description-label"
        rows={2}
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
      />
    </label>
  );
}

export function SharingField({
  form,
  setForm,
}: {
  form: BotInput;
  setForm: (form: BotInput) => void;
}) {
  return (
    <>
      <label className="checkbox-label">
        <Input
          type="checkbox"
          checked={form.shared}
          onChange={(e) => setForm({ ...form, shared: e.target.checked })}
        />{" "}
        Shared with your household
      </label>
      <p className="muted">
        {form.shared
          ? "This assistant has one shared model. Provider and model changes are visible to both people."
          : "Only you see a personal assistant in WildBots. Anyone with Hermes dashboard access can still reach its memory and logins."}
      </p>
    </>
  );
}

/** Instructions and model, shared by creation's second step and the Behavior section. */
export function BehaviorFields({
  form,
  setForm,
  busy,
  profile,
  bootstrap,
  onModelChange,
  onFavoritesSaved,
}: {
  form: BotInput;
  setForm: (form: BotInput) => void;
  busy: boolean;
  profile: string | undefined;
  bootstrap: Bootstrap;
  onModelChange: () => void;
  onFavoritesSaved: () => void;
}) {
  return (
    <>
      <label htmlFor="assistant-instructions">
        <span id="assistant-instructions-label">Instructions</span>
        <Textarea
          id="assistant-instructions"
          aria-labelledby="assistant-instructions-label"
          rows={7}
          value={form.instructions}
          onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          placeholder="How should this assistant help?"
        />
      </label>
      <div className="interactive-replies-setting">
        <Button
          type="button"
          disabled={busy || form.instructions.includes(interactiveReplyInstructions)}
          onClick={() =>
            setForm({
              ...form,
              instructions: `${form.instructions.trim()}\n\n${interactiveReplyInstructions}`.trim(),
            })
          }
        >
          {form.instructions.includes(interactiveReplyInstructions)
            ? "Interactive replies enabled"
            : "Enable interactive replies"}
        </Button>
        <p className="muted">
          Adds instructions for checklists, itineraries and calendar proposals. Save changes to
          apply them.
        </p>
      </div>
      <ModelSelector
        value={{ provider: form.provider || "", model: form.model }}
        profile={profile}
        favorites={bootstrap.preferences.modelFavorites || []}
        disabled={busy || !bootstrap.capabilities.botConfiguration.supported}
        onChange={({ provider, model }) => {
          setForm({ ...form, provider, model });
          onModelChange();
        }}
        onFavoritesSaved={onFavoritesSaved}
      />
    </>
  );
}

export function DeleteBot({
  bot,
  busy,
  supported,
  remove,
}: {
  bot: Bot;
  busy: boolean;
  supported: boolean;
  remove: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={trigger}
        className="danger"
        disabled={busy || !supported}
        onClick={() => setConfirm(true)}
      >
        Delete assistant
      </Button>
      {confirm && (
        <SettingsConfirmation
          title={`Delete ${bot.name}?`}
          detail="This deletes the assistant in Hermes and removes its settings from WildBots."
          confirmLabel="Yes, delete"
          cancelLabel="Keep assistant"
          danger
          busy={busy}
          fallbackFocus={() =>
            trigger.current && !trigger.current.disabled
              ? trigger.current
              : document.getElementById("assistant-settings-title")
          }
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            remove();
          }}
        />
      )}
    </>
  );
}

export function SaveProgress({ state, label }: { state?: "saving" | "saved"; label: string }) {
  return state === "saving" ? (
    <>
      <Icon name="spinner" className="spin" size={16} />
      Saving…
    </>
  ) : state === "saved" ? (
    <>
      <Icon name="check" size={16} />
      Saved
    </>
  ) : (
    <>{label}</>
  );
}

/** Lean roster rows cannot initialize a writable form. */
