import { reasoningLevels, serviceTiers } from "../shared/types";
import { useEffect, useRef, useState } from "react";
import { ApiError, request } from "../client-api";
import type { Bootstrap, Bot, BotInput, InferenceSettings, ModelChoice } from "../shared/types";
import { Icon } from "./Icon";
import { ModelSelector } from "./ModelSelector";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Button } from "./ui/button";
import { Segmented, type SegmentOption } from "./ui/segmented";
import { FormMessage } from "./ui/form-message";

const reasoningNames: Record<InferenceSettings["reasoning"], [string, string?]> = {
  none: ["Off"], minimal: ["Min", "Minimal"], low: ["Low"], medium: ["Med", "Medium"],
  high: ["High"], xhigh: ["XHigh", "Extra high"], max: ["Max"], ultra: ["Ultra"],
};
const reasoningOptions: SegmentOption<InferenceSettings["reasoning"]>[] = reasoningLevels.map(value => ({ value, label: reasoningNames[value][0], name: reasoningNames[value][1] }));
const speedOptions: SegmentOption<InferenceSettings["speed"]>[] = serviceTiers.map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }));

/** Advanced mode's quick model switch. Saves through the same assistant update as settings. */
export function ComposerModelPicker({ bot, bootstrap, disabled, onSaved }: {
  bot: Bot;
  bootstrap: Bootstrap;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<InferenceSettings>();
  const [settingsError, setSettingsError] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [confirm, setConfirm] = useState<ModelChoice | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Answers for a previous assistant must not land on the one now shown.
  const current = useRef(bot.id);
  current.current = bot.id;
  // A model-only save resends the assistant's other fields, so it needs the real instructions.
  const unavailable = !bootstrap.capabilities.botConfiguration.supported;
  const blocked = disabled || unavailable;
  useEffect(() => { setOpen(false); setBusy(false); setError(""); setConfirm(null); setSettingsBusy(false); }, [bot.id]);
  useEffect(() => { if (blocked) { setOpen(false); setConfirm(null); } }, [blocked]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setSettings(undefined); setSettingsError("");
    void request("GET /bots/:id/inference", { params: { id: bot.id }, signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setSettings(value); })
      .catch(error => { if (!controller.signal.aborted) setSettingsError(error.message); });
    return () => controller.abort();
  }, [open, bot.id]);
  async function changeSettings(update: Partial<InferenceSettings>) {
    if (blocked || settingsBusy || busy) return;
    const target = bot.id;
    setSettingsBusy(true); setSettingsError("");
    try {
      const value = await request("PATCH /bots/:id/inference", { params: { id: target }, body: update });
      if (current.current === target) setSettings(value);
    } catch (error) { if (current.current === target) setSettingsError((error as Error).message); }
    finally { if (current.current === target) setSettingsBusy(false); }
  }
  async function save(choice: ModelChoice, confirmed = false) {
    if (blocked || busy || settingsBusy) return;
    const target = bot.id;
    setBusy(true); setError("");
    try {
      const detail=await request("GET /bots/:id", { params: { id: target } });
      if(current.current!==target)return;
      if(typeof detail.instructions!=="string")throw new Error("Assistant settings could not be loaded. Try again before changing the model.");
      const input: BotInput = {
        name: detail.name, description: detail.description || "", instructions: detail.instructions || "",
        model: choice.model, provider: choice.provider || undefined, shared: detail.shared,
        enabledMcpServers: detail.enabledMcpServers || [], confirmModel: confirmed,
      };
      await request("PATCH /bots/:id", { params: { id: target }, body: input });
      onSaved();
      if (current.current !== target) return;
      setConfirm(null); setOpen(false);
    } catch (e) {
      if (current.current !== target) return;
      setError((e as Error).message);
      setConfirm(e instanceof ApiError && e.confirmRequired ? choice : null);
    } finally { if (current.current === target) setBusy(false); }
  }
  const label = bot.provider ? `${bot.provider} / ${bot.model}` : bot.model;
  return <Popover open={open} onOpenChange={setOpen}>
    <div className="composer-model">
      <PopoverTrigger render={<Button ref={trigger} className="composer-tool"
        aria-label={`Model: ${label}`} disabled={blocked}
        title={unavailable ? bootstrap.capabilities.botConfiguration.reason || "Change this model in assistant settings." : label} />}>
        <Icon name="robot" size={18} /><span className="tool-label composer-model-name">{bot.model}</span>
      </PopoverTrigger>
      <PopoverContent className="model-popover" aria-label="Choose a model" side="top" align="start" sideOffset={10}
        positionerProps={{ collisionPadding: 12, anchor: () => trigger.current?.closest<HTMLElement>(".composer") || trigger.current }}>
        <ModelSelector inline value={{ provider: bot.provider || "", model: bot.model }} profile={bot.id}
          favorites={bootstrap.preferences.modelFavorites || []} disabled={busy || settingsBusy}
          onChange={choice => void save(choice)} onFavoritesSaved={onSaved} />
        <div className="inference-controls" aria-busy={settingsBusy}>
          {settings ? <>
            <Segmented label="Reasoning" value={settings.reasoning} options={reasoningOptions} busy={busy || settingsBusy}
              onChange={reasoning => void changeSettings({ reasoning })} />
            <Segmented label="Speed" value={settings.speed} options={speedOptions} busy={busy || settingsBusy}
              onChange={speed => void changeSettings({ speed })} />
            <small className="muted">Applies to this conversation. Available levels and speeds depend on the model.</small>
          </> : !settingsError && <span role="status" className="muted">Loading reasoning and speed…</span>}
          {settingsBusy && <span role="status"><Icon name="spinner" className="spin" size={14} /> Saving…</span>}
          {settingsError && <FormMessage tone="error">{settingsError}</FormMessage>}
        </div>
        {error && <FormMessage tone="error">{error}</FormMessage>}
        {confirm && <div className="actions">
          <Button className="primary" disabled={busy || settingsBusy} onClick={() => void save(confirm, true)}>Confirm this model</Button>
          <Button onClick={() => { setConfirm(null); setError(""); }}>Cancel</Button>
        </div>}
      </PopoverContent>
    </div>
  </Popover>;
}
