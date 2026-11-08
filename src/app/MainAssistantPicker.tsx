import { useId, useState } from "react";
import type { Bootstrap, Bot, Preferences } from "../shared/types";
import { mainEligible, mainIneligibleReason } from "../shared/main-assistant";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { FormMessage } from "../components/ui/form-message";
import "./home.css";
import "./shell.css";

/**
 * Choosing a main assistant. Only your own personal assistants can be one; each other assistant
 * says why it can't, and a shared or ownerless one offers Make it personal, which opens its settings.
 */
export function MainAssistantPicker({ boot, onChoose, onMakePersonal, onClose }: {
  boot: Bootstrap;
  onChoose(botId: string): Promise<Preferences>;
  onMakePersonal(bot: Bot): void;
  onClose(): void;
}) {
  const titleId = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const eligible = boot.bots.filter(bot => mainEligible(bot, boot.user.id));
  const others = boot.bots.filter(bot => !mainEligible(bot, boot.user.id));
  const choose = (bot: Bot) => {
    setBusy(bot.id); setError("");
    void onChoose(bot.id).then(onClose, (cause: unknown) => setError(cause instanceof Error ? cause.message : "That didn't save. Try again."))
      .finally(() => setBusy(null));
  };
  const row = (bot: Bot, action: React.ReactNode, note?: string) => <li key={bot.id} className="main-picker-row">
    <Avatar avatar={bot.avatar} size={40} name={bot.name} reducedMotion />
    <span className="row-text"><strong>{bot.name}</strong><small>{note ?? bot.description ?? "Your personal assistant"}</small></span>
    {action}
  </li>;
  return <Dialog className="settings-sheet main-picker" aria-labelledby={titleId} initialFocus={`#${CSS.escape(titleId)}`} onCancel={onClose} onClose={onClose}>
    <header className="sheet-header">
      <h2 id={titleId} tabIndex={-1}>Choose a main assistant</h2>
      <Button className="sheet-close" aria-label="Close" onClick={onClose}><Icon name="close" /></Button>
    </header>
    <div className="sheet-body">
      <p className="muted">Your main assistant leads your home, checks in on what's coming up if you turn that on, and hands work to your other assistants. It must be one of your own personal assistants, so its check-ins stay private to you.</p>
      {eligible.length > 0
        ? <ul className="main-picker-list" aria-label="Your personal assistants">{eligible.map(bot => row(bot,
          <Button className="primary" disabled={!!busy} onClick={() => choose(bot)}>{busy === bot.id ? "Saving…" : "Make main"}</Button>))}</ul>
        : <p>You don't have a personal assistant yet. Make one of these personal, or create a new personal assistant.</p>}
      {others.length > 0 && <>
        <h3 className="settings-heading">Other assistants</h3>
        <ul className="main-picker-list" aria-label="Other assistants">{others.map(bot => row(bot,
          <Button onClick={() => { onClose(); onMakePersonal(bot); }}>Make it personal</Button>, mainIneligibleReason(bot, boot.user.id)))}</ul>
      </>}
      {error && <FormMessage tone="error" className="settings-footnote">{error}</FormMessage>}
    </div>
  </Dialog>;
}
