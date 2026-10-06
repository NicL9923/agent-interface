import { reasoningLevels, serviceTiers } from "../shared/types";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, write } from "../client-api";
import type { Bootstrap, Bot, BotInput, InferenceSettings, ModelChoice } from "../shared/types";
import { Icon } from "./Icon";
import { ModelSelector } from "./ModelSelector";

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
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Answers for a previous assistant must not land on the one now shown.
  const current = useRef(bot.id);
  current.current = bot.id;
  // A model-only save resends the assistant's other fields, so it needs the real instructions.
  const unavailable = !bootstrap.capabilities.botConfiguration.supported || typeof bot.instructions !== "string";
  const blocked = disabled || unavailable;
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) {
        setOpen(false);
        if (event instanceof KeyboardEvent) trigger.current?.focus();
      }
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => { document.removeEventListener("keydown", close); document.removeEventListener("pointerdown", close); };
  }, [open]);
  useEffect(() => { setOpen(false); setBusy(false); setError(""); setConfirm(null); setSettingsBusy(false); }, [bot.id]);
  useEffect(() => { if (blocked) { setOpen(false); setConfirm(null); } }, [blocked]);
  useEffect(() => { if (open) root.current?.querySelector<HTMLInputElement>("input[type=search]")?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setSettings(undefined); setSettingsError("");
    void api<InferenceSettings>(`/bots/${encodeURIComponent(bot.id)}/inference`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setSettings(value); })
      .catch(error => { if (!controller.signal.aborted) setSettingsError(error.message); });
    return () => controller.abort();
  }, [open, bot.id]);
  async function changeSettings(update: Partial<InferenceSettings>) {
    if (blocked || settingsBusy || busy) return;
    const target = bot.id;
    setSettingsBusy(true); setSettingsError("");
    try {
      const value = await write<InferenceSettings>(`/bots/${encodeURIComponent(target)}/inference`, update, "PATCH");
      if (current.current === target) setSettings(value);
    } catch (error) { if (current.current === target) setSettingsError((error as Error).message); }
    finally { if (current.current === target) setSettingsBusy(false); }
  }
  async function save(choice: ModelChoice, confirmed = false) {
    if (blocked || busy || settingsBusy) return;
    const target = bot.id;
    const input: BotInput = {
      name: bot.name, description: bot.description || "", instructions: bot.instructions || "",
      model: choice.model, provider: choice.provider || undefined, shared: bot.shared,
      enabledMcpServers: bot.enabledMcpServers || [], confirmModel: confirmed,
    };
    setBusy(true); setError("");
    try {
      await write(`/bots/${encodeURIComponent(target)}`, input, "PATCH");
      onSaved();
      if (current.current !== target) return;
      setConfirm(null); setOpen(false); trigger.current?.focus();
    } catch (e) {
      if (current.current !== target) return;
      setError((e as Error).message);
      setConfirm(e instanceof ApiError && e.confirmRequired ? choice : null);
    } finally { if (current.current === target) setBusy(false); }
  }
  const label = bot.provider ? `${bot.provider} / ${bot.model}` : bot.model;
  return <div className="composer-model" ref={root}>
    <button type="button" ref={trigger} className="composer-tool" aria-haspopup="dialog" aria-expanded={open}
      aria-label={`Model: ${label}`} disabled={blocked}
      title={unavailable ? bootstrap.capabilities.botConfiguration.reason || "Change this model in assistant settings." : label}
      onClick={() => setOpen(value => !value)}>
      <Icon name="robot" size={18} /><span className="tool-label composer-model-name">{bot.model}</span>
    </button>
    {open && <div className="model-popover" role="dialog" aria-label="Choose a model">
      <ModelSelector inline value={{ provider: bot.provider || "", model: bot.model }} profile={bot.id}
        favorites={bootstrap.preferences.modelFavorites || []} disabled={busy || settingsBusy}
        onChange={choice => void save(choice)} onFavoritesSaved={onSaved} />
      <div className="inference-controls" aria-busy={settingsBusy}>
        {settings ? <>
          <label>Reasoning<select value={settings.reasoning} disabled={busy || settingsBusy}
            onChange={event => void changeSettings({ reasoning: event.target.value as InferenceSettings["reasoning"] })}>
            {reasoningLevels.map(value => <option key={value} value={value}>{value === "none" ? "Off" : value.charAt(0).toUpperCase() + value.slice(1)}</option>)}
          </select></label>
          <label>Speed<select value={settings.speed} disabled={busy || settingsBusy}
            onChange={event => void changeSettings({ speed: event.target.value as InferenceSettings["speed"] })}>
            {serviceTiers.map(value => <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>)}
          </select></label>
          <small className="muted">Applies to this conversation. Available levels and speeds depend on the model.</small>
        </> : !settingsError && <span role="status" className="muted">Loading reasoning and speed…</span>}
        {settingsBusy && <span role="status"><Icon name="spinner" className="spin" size={14} /> Saving…</span>}
        {settingsError && <p role="alert" className="form-error">{settingsError}</p>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {confirm && <div className="actions">
        <button type="button" className="primary" disabled={busy || settingsBusy} onClick={() => void save(confirm, true)}>Confirm this model</button>
        <button type="button" onClick={() => { setConfirm(null); setError(""); }}>Cancel</button>
      </div>}
    </div>}
  </div>;
}
