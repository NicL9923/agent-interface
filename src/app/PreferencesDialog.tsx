import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Bootstrap, Bot, Preferences } from "../shared/types";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import type { IconName } from "../components/Icon";
import { NotificationSettings } from "../components/DeviceNotifications";
import type { useDeviceNotifications } from "../components/use-device-notifications";
import type { InstallEvent } from "./use-browser";
import "./home.css";

/** Account and app settings as grouped rows, opened from the home screen's account button. */
export function PreferencesDialog({ boot, connectionLost, offline, savePreferences, notifications, installEvent, notice, onClose, onSignOut, onComputer, onIntegrations, onUpgrade }: {
  boot: Bootstrap;
  connectionLost: boolean;
  offline: boolean;
  savePreferences(value: Preferences): Promise<void>;
  notifications: ReturnType<typeof useDeviceNotifications>;
  installEvent: InstallEvent | null;
  notice: string;
  onClose(): void;
  onSignOut(): Promise<void>;
  onComputer(): void;
  onIntegrations(): void;
  onUpgrade(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    // Start at the title, so the close button is not pre-selected.
    element?.querySelector<HTMLElement>("#settings-title")?.focus();
    return () => {
      element?.close();
      if (previous?.isConnected && !previous.closest("[inert]")) previous.focus();
    };
  }, []);
  const prefs = boot.preferences;
  const bots = boot.bots;
  const save = (update: Partial<Preferences>) => void savePreferences({ ...prefs, ...update });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const notify = (update: Partial<NonNullable<Preferences["notifications"]>>) =>
    save({ notifications: { timezone, batchMinutes: 0, ...prefs.notifications, ...update } });
  const version = boot.connection.version;
  return (
    <dialog ref={dialog} className="settings-sheet" aria-labelledby="settings-title" onCancel={onClose} onClose={onClose}>
      <header className="sheet-header">
        <button type="button" className="sheet-close" aria-label="Close settings" onClick={onClose}><Icon name="close" /></button>
        <h2 id="settings-title" tabIndex={-1}>Settings</h2>
      </header>
      <div className="sheet-body">
        <div className="settings-group settings-account">
          <span className="account-avatar" aria-hidden="true">
            {boot.user.picture ? <img src={boot.user.picture} alt="" referrerPolicy="no-referrer" />
              : boot.user.name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase()}
          </span>
          <span className="row-text"><strong>{boot.user.name}</strong><small>{boot.user.email}</small></span>
        </div>

        <div className="settings-group">
          <NavRow icon="upgrade" label="Hermes and updates" onClick={onUpgrade}
            detail={connectionLost ? offline ? "Offline" : "Reconnecting" : version ? `Connected · ${version}` : "Connected"}
            badge={<span className={`row-status${connectionLost ? " attention" : ""}`} aria-hidden="true" />} />
          <NavRow icon="computer" label="Computer" detail="Shared desktop and terminal" onClick={onComputer} />
          <NavRow icon="plug" label="Integrations" detail="Accounts your assistants can use" onClick={onIntegrations} />
        </div>

        <h3 className="settings-heading">Display</h3>
        <div className="settings-group">
          <label className="settings-row"><span className="row-label">Appearance</span>
            <select value={prefs.theme} onChange={event => save({ theme: event.target.value as Preferences["theme"] })}>
              <option value="system">Follow device</option><option value="light">Light</option><option value="dark">Dark</option>
            </select></label>
          <Switch label="Advanced details" detail="Reasoning, tool inputs and the model menu" checked={prefs.presentation === "advanced"}
            onChange={checked => save({ presentation: checked ? "advanced" : "simple" })} />
          <label className="settings-row"><span className="row-label">Start page</span>
            <select value={prefs.startPage || (prefs.defaultBotId ? "assistant" : "today")}
              onChange={event => save({ startPage: event.target.value as "today" | "assistant" })}>
              <option value="today">Today</option><option value="assistant">Assistant</option>
            </select></label>
          <label className="settings-row"><span className="row-label">Open by default</span>
            <select value={prefs.defaultBotId || ""} onChange={event => save({ defaultBotId: event.target.value || undefined })}>
              <option value="">First assistant</option>
              {bots.map(bot => <option value={bot.id} key={bot.id}>{bot.name}</option>)}
            </select></label>
        </div>

        <h3 className="settings-heading">Notifications</h3>
        <div className="settings-group">
          <div className="settings-row settings-notifications"><NotificationSettings notifications={notifications} title="This device" /></div>
          <label className="settings-row"><span className="row-label">Batching</span>
            <select value={prefs.notifications?.batchMinutes || 0} onChange={event => notify({ batchMinutes: Number(event.target.value) })}>
              <option value={0}>As updates arrive</option><option value={5}>Every 5 minutes</option>
              <option value={15}>Every 15 minutes</option><option value={60}>Hourly</option>
            </select></label>
          <Switch label="Quiet hours" checked={!!prefs.notifications?.quietStart}
            onChange={checked => save({ notifications: { timezone, batchMinutes: prefs.notifications?.batchMinutes || 0,
              ...(checked ? { quietStart: "22:00", quietEnd: "07:00" } : {}) } })} />
          {prefs.notifications?.quietStart && <>
            <label className="settings-row"><span className="row-label">From</span>
              <input type="time" value={prefs.notifications.quietStart} onChange={event => notify({ quietStart: event.target.value })} /></label>
            <label className="settings-row"><span className="row-label">Until</span>
              <input type="time" value={prefs.notifications.quietEnd} onChange={event => notify({ quietEnd: event.target.value })} /></label>
          </>}
        </div>
        {prefs.notifications?.quietStart && <p className="settings-footnote">
          {prefs.notifications.timezone}. Other notifications wait until quiet hours end; security alerts arrive right away.
          Decisions and failures skip batching outside quiet hours.</p>}

        {bots.length > 0 && <>
          <h3 className="settings-heading">Follow all activity</h3>
          <div className="settings-group">
            {bots.map(bot => <Switch key={bot.id} label={bot.name} checked={prefs.followBots.includes(bot.id)}
              icon={<Avatar avatar={bot.avatar} size={28} name={bot.name} reducedMotion />}
              onChange={checked => save({ followBots: checked ? [...prefs.followBots, bot.id] : prefs.followBots.filter(id => id !== bot.id) })} />)}
          </div>
          <p className="settings-footnote">Shared-task notifications already go to participants. Follow an assistant to receive all their activity.</p>
        </>}

        <h3 className="settings-heading">Home sections</h3>
        <SectionEditor preferences={prefs} bots={bots} save={savePreferences} />

        <div className="settings-group">
          {installEvent && <button type="button" className="settings-row" onClick={() => void installEvent.prompt()}>
            <Icon name="download" size={18} /><span className="row-label">Install app</span></button>}
          <button type="button" className="settings-row danger" disabled={notifications.busy} onClick={() => void onSignOut()}>
            <span className="row-label">Sign out</span></button>
        </div>
        <p className="settings-footnote">On iPhone, choose Share, then Add to Home Screen. Install before enabling notifications.</p>
        {notice && <p className="settings-footnote" role="status">{notice}</p>}
        <footer className="settings-footer">
          <span className="brand-mark" aria-hidden="true">w.</span>
          <strong>WildBots</strong>
          {version && <small>Hermes {version}</small>}
        </footer>
      </div>
    </dialog>
  );
}

function NavRow({ icon, label, detail, badge, onClick }: { icon: IconName; label: string; detail?: string; badge?: ReactNode; onClick(): void }) {
  return <button type="button" className="settings-row" onClick={onClick}>
    <span className="row-icon"><Icon name={icon} size={18} />{badge}</span>
    <span className="row-text"><span className="row-label">{label}</span>{detail && <small>{detail}</small>}</span>
    <Icon name="chevron" size={16} className="row-chevron" />
  </button>;
}

function Switch({ label, detail, checked, icon, onChange }: { label: string; detail?: string; checked: boolean; icon?: ReactNode; onChange(checked: boolean): void }) {
  return <label className="settings-row">
    {icon}
    <span className="row-text"><span className="row-label">{label}</span>{detail && <small>{detail}</small>}</span>
    <input type="checkbox" role="switch" className="switch" checked={checked} onChange={event => onChange(event.target.checked)} />
  </label>;
}

function SectionEditor({ preferences, bots, save }: { preferences: Preferences; bots: Bot[]; save(value: Preferences): Promise<void> }) {
  const [name, setName] = useState("");
  const update = (sections: Preferences["sections"]) => void save({ ...preferences, sections });
  return <>
    {preferences.sections.map(section => <div className="settings-group" key={section.id}>
      <div className="settings-row section-title">
        <span className="row-label">{section.name}</span>
        <button type="button" className="icon-button" aria-label={`Remove section ${section.name}`}
          onClick={() => update(preferences.sections.filter(item => item.id !== section.id))}><Icon name="close" size={16} /></button>
      </div>
      {bots.map(bot => <Switch key={bot.id} label={bot.name} checked={section.botIds.includes(bot.id)}
        icon={<Avatar avatar={bot.avatar} size={28} name={bot.name} reducedMotion />}
        onChange={checked => update(preferences.sections.map(item => item.id === section.id
          ? { ...item, botIds: checked ? [...item.botIds, bot.id] : item.botIds.filter(id => id !== bot.id) } : item))} />)}
    </div>)}
    <form className="settings-group settings-row section-add" onSubmit={event => {
      event.preventDefault();
      if (!name.trim()) return;
      update([...preferences.sections, { id: crypto.randomUUID(), name: name.trim(), botIds: [] }]);
      setName("");
    }}>
      <input aria-label="New section name" value={name} onChange={event => setName(event.target.value)} placeholder="New section, like Around the house" />
      <button type="submit" disabled={!name.trim()}>Add</button>
    </form>
  </>;
}
