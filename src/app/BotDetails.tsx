import { useEffect, useId, useRef, useState } from "react";
import type { ActivityState, Bootstrap, Bot, Preferences } from "../shared/types";
import { Avatar } from "../components/Avatar";
import { ArtifactsButton } from "../components/Artifacts";
import { Icon } from "../components/Icon";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import { botSummary } from "./ChatHeader";
import { addSection, checkSectionName, moveBotToSection, sectionOf, setFollowing } from "./preferences-editing";
import type { SavedConversation } from "./storage";
import { usePreferenceEdits, type PreferenceEdit } from "./use-preference-edits";
import "./home.css";

const newSectionValue = "\u0000new";

/**
 * One assistant's card, like a contact in a messaging app: who it is, quick actions,
 * and the per-assistant home and notification choices.
 */
export function BotDetails({ boot, bot, avatarState, conversation, connectionLost, startNewSection, editPreferences, onSettings, onClose }: {
  boot: Bootstrap;
  bot: Bot;
  avatarState: ActivityState;
  /** The open conversation, when it is this assistant's; artifacts come from it. */
  conversation: SavedConversation | null;
  connectionLost: boolean;
  /** Opens with the new section field ready, as from the home menu. */
  startNewSection?: boolean;
  editPreferences(edit: PreferenceEdit): Promise<void>;
  onSettings(bot: Bot): void;
  onClose(): void;
}) {
  const titleId = useId();
  const [prefs, commit] = usePreferenceEdits(boot.preferences, editPreferences);
  const pinned = prefs.favorites.includes(bot.id);
  const following = prefs.followBots.includes(bot.id);
  const section = sectionOf(prefs, bot.id);
  const [creating, setCreating] = useState(!!startNewSection);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const nameField = useRef<HTMLInputElement>(null);
  // Choosing New section later moves focus to its field; on open, the dialog does.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current && creating) nameField.current?.focus();
    opened.current = true;
  }, [creating]);
  const ownConversation = conversation?.botId === bot.id ? conversation : null;
  const create = () => {
    const checked = checkSectionName(prefs, name);
    if ("error" in checked) { setNameError(checked.error); nameField.current?.focus(); return; }
    commit(value => addSection(value, checked.name, bot.id));
    setCreating(false); setName(""); setNameError("");
  };
  return <Dialog className="settings-sheet bot-details" aria-labelledby={titleId} initialFocus={startNewSection ? "[aria-label='New section name']" : `#${CSS.escape(titleId)}`}
    onCancel={onClose} onClose={onClose}>
    <header className="sheet-header">
      <Button className="sheet-close" aria-label="Close details" onClick={onClose}><Icon name="close" /></Button>
    </header>
    <div className="sheet-body">
      <div className="bot-details-hero">
        <Avatar avatar={bot.avatar} state={avatarState === "done" ? "idle" : avatarState} size={112} name={bot.name} botId={bot.id} />
        <h2 id={titleId} tabIndex={-1}>{bot.name}</h2>
        <p>{botSummary(bot)}</p>
        {bot.description && <p className="bot-details-description">{bot.description}</p>}
      </div>
      <div className="bot-details-actions" role="group" aria-label="Quick actions">
        <Button className={`bot-details-action${pinned ? " on" : ""}`} aria-pressed={pinned} onClick={() => commit(value => ({ ...value, favorites: pinned ? value.favorites.filter(id => id !== bot.id) : [...value.favorites, bot.id] }))}>
          <Icon name="pin" filled={pinned} />{pinned ? "Unpin" : "Pin"}
        </Button>
        {ownConversation && <ArtifactsButton key={`${boot.user.id}:${bot.id}`} bot={bot} conversation={ownConversation} unavailable={connectionLost} />}
        <Button className="bot-details-action" onClick={() => onSettings(bot)}>
          <Icon name="gear" />Settings
        </Button>
      </div>
      <div className="settings-group">
        <label className="settings-row">
          <span className="row-text"><span className="row-label">Notify me about all activity</span>
            <small>Every reply and update, not only shared tasks</small></span>
          <Input type="checkbox" role="switch" className="switch" checked={following}
            onChange={event => { const on = event.target.checked; commit(value => setFollowing(value, bot.id, on)); }} />
        </label>
        <label className="settings-row">
          <span className="row-label">Home section</span>
          <NativeSelect value={creating ? newSectionValue : section?.id ?? ""} onChange={event => {
            const value = event.target.value;
            if (value === newSectionValue) { setCreating(true); return; }
            setCreating(false);
            commit(current => moveBotToSection(current, bot.id, value || null));
          }}>
            <option value="">None</option>
            {prefs.sections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            <option value={newSectionValue}>New section…</option>
          </NativeSelect>
        </label>
        {creating && <form className="settings-row section-add" onSubmit={event => { event.preventDefault(); create(); }}>
          <Input ref={nameField} aria-label="New section name" aria-invalid={!!nameError || undefined} maxLength={100}
            value={name} placeholder="Section name, like Kids" onChange={event => { setName(event.target.value); setNameError(""); }} />
          <Button type="submit" className="primary">Add</Button>
        </form>}
      </div>
      {nameError && <p className="settings-footnote form-error" role="alert">{nameError}</p>}
    </div>
  </Dialog>;
}
