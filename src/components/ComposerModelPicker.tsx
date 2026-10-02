import { useEffect, useRef, useState } from "react";
import { ApiError, write } from "../client-api";
import type { Bootstrap, Bot, BotInput, ModelChoice } from "../shared/types";
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
  useEffect(() => { setOpen(false); setBusy(false); setError(""); setConfirm(null); }, [bot.id]);
  useEffect(() => { if (blocked) { setOpen(false); setConfirm(null); } }, [blocked]);
  useEffect(() => { if (open) root.current?.querySelector<HTMLInputElement>("input[type=search]")?.focus(); }, [open]);
  async function save(choice: ModelChoice, confirmed = false) {
    if (blocked) return;
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
      <Icon name="model" size={18} /><span className="tool-label composer-model-name">{bot.model}</span>
    </button>
    {open && <div className="model-popover" role="dialog" aria-label="Choose a model">
      <ModelSelector inline value={{ provider: bot.provider || "", model: bot.model }} profile={bot.id}
        favorites={bootstrap.preferences.modelFavorites || []} disabled={busy}
        onChange={choice => void save(choice)} onFavoritesSaved={onSaved} />
      {bot.shared && <p className="muted">Shared assistant: the model changes for your whole household.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {confirm && <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void save(confirm, true)}>Confirm this model</button>
        <button type="button" onClick={() => { setConfirm(null); setError(""); }}>Cancel</button>
      </div>}
    </div>}
  </div>;
}
