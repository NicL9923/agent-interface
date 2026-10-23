import { Dialog } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Bootstrap, Bot, Preferences } from "../shared/types";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import type { IconName } from "../components/Icon";
import { NotificationSettings } from "../components/DeviceNotifications";
import type { useDeviceNotifications } from "../components/use-device-notifications";
import type { InstallEvent } from "./use-browser";
import { hermesVersionLabel, revisionDate } from "./hermes-version";
import { addSection, checkSectionName, moveSection, newSectionId, removeSection, renameSection, sectionOf, setFollowing, setSectionBots } from "./preferences-editing";
import type { Section } from "./preferences-editing";
import { usePreferenceEdits, type PreferenceEdit } from "./use-preference-edits";
import "./home.css";
import { FormMessage } from "../components/ui/form-message";

type Page = { kind: "main" } | { kind: "following" } | { kind: "section"; id: string };
type Commit = (edit: (value: Preferences) => Preferences) => void;
const assistants = (count: number) => count === 1 ? "1 assistant" : `${count} assistants`;

/** Account and app settings as grouped rows, opened from the home screen's account button. */
export function PreferencesDialog({ boot, connectionLost, offline, editPreferences, notifications, installEvent, notice, onClose, onSignOut, onComputer, onIntegrations, onUpgrade }: {
  boot: Bootstrap;
  connectionLost: boolean;
  offline: boolean;
  editPreferences(edit: PreferenceEdit): Promise<void>;
  notifications: ReturnType<typeof useDeviceNotifications>;
  installEvent: InstallEvent | null;
  notice: string;
  onClose(): void;
  onSignOut(): Promise<void>;
  onComputer(): void;
  onIntegrations(): void;
  onUpgrade(): void;
}) {
  const [prefs, commit] = usePreferenceEdits(boot.preferences, editPreferences);
  const bots = boot.bots;
  const save = (update: Partial<Preferences>) => commit(value => ({ ...value, ...update }));
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const notify = (update: Partial<NonNullable<Preferences["notifications"]>>) =>
    commit(value => ({ ...value, notifications: { timezone, batchMinutes: 0, ...value.notifications, ...update } }));
  const { version, revisionDate: builtOn } = boot.connection;
  const hermes = revisionDate(builtOn) ? `Hermes released ${revisionDate(builtOn)}` : version ? `Hermes ${hermesVersionLabel(version, undefined)}` : "";
  // Following and each home section open as their own page in the sheet, like a phone's settings.
  const [page, setPage] = useState<Page>({ kind: "main" });
  const section = page.kind === "section" ? prefs.sections.find(item => item.id === page.id) : undefined;
  const shown: Page = page.kind === "section" && !section ? { kind: "main" } : page;
  const body = useRef<HTMLDivElement>(null);
  const opener = useRef<string | null>(null);
  const go = (next: Page) => {
    opener.current = next.kind === "main" ? page.kind === "section" ? `section:${page.id}` : page.kind : null;
    setPage(next);
  };
  const firstPage = useRef(true);
  useEffect(() => {
    if (firstPage.current) { firstPage.current = false; return; }
    if (body.current) body.current.scrollTop = 0;
    // Back on the main page, the row that opened the page keeps focus; a new page starts at its title.
    const row = opener.current && body.current?.querySelector<HTMLElement>(`[data-opens="${CSS.escape(opener.current)}"]`);
    (row || document.getElementById("settings-title"))?.focus();
  }, [shown.kind, section?.id]);
  const title = shown.kind === "following" ? "Following" : shown.kind === "section" ? section!.name : "Settings";
  return (
    <Dialog initialFocus="#settings-title" className="settings-sheet" aria-labelledby="settings-title" onClose={onClose}
      onCancel={event => {
        if (shown.kind === "main") return onClose();
        event.preventDefault();
        go({ kind: "main" });
      }}>
      <header className="sheet-header">
        {shown.kind === "main"
          ? <Button type="button" className="sheet-close" aria-label="Close settings" onClick={onClose}><Icon name="close" /></Button>
          : <Button type="button" className="sheet-close" aria-label="Back to settings" onClick={() => go({ kind: "main" })}><Icon name="back" /></Button>}
        <h2 id="settings-title" tabIndex={-1}>{title}</h2>
      </header>
      <div className="sheet-body" ref={body}>
        {shown.kind === "following" ? <FollowingPage preferences={prefs} bots={bots} commit={commit} />
          : shown.kind === "section" ? <SectionPage key={section!.id} preferences={prefs} bots={bots} section={section!} commit={commit}
            onDeleted={() => go({ kind: "main" })} /> : <>
        <div className="settings-group settings-account">
          <span className="account-avatar" aria-hidden="true">
            {boot.user.picture ? <img src={boot.user.picture} alt="" referrerPolicy="no-referrer" />
              : boot.user.name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase()}
          </span>
          <span className="row-text"><strong>{boot.user.name}</strong><small>{boot.user.email}</small></span>
        </div>

        <div className="settings-group">
          <NavRow icon="upgrade" label="Hermes and updates" onClick={onUpgrade}
            detail={connectionLost ? offline ? "Offline" : "Reconnecting" : hermes ? `Connected · ${hermes}` : "Connected"}
            badge={<span className={`row-status${connectionLost ? " attention" : ""}`} aria-hidden="true" />} />
          <NavRow icon="computer" label="Computer" detail="Shared desktop and terminal" onClick={onComputer} />
          <NavRow icon="plug" label="Integrations" detail="Accounts your assistants can use" onClick={onIntegrations} />
        </div>

        <h3 className="settings-heading">Display</h3>
        <div className="settings-group">
          <label className="settings-row"><span className="row-label">Appearance</span>
            <NativeSelect value={prefs.theme} onChange={event => save({ theme: event.target.value as Preferences["theme"] })}>
              <option value="system">Follow device</option><option value="light">Light</option><option value="dark">Dark</option>
            </NativeSelect></label>
          <Switch label="Advanced details" detail="Reasoning, tool inputs and the model menu" checked={prefs.presentation === "advanced"}
            onChange={checked => save({ presentation: checked ? "advanced" : "simple" })} />
          <label className="settings-row"><span className="row-label">Start page</span>
            <NativeSelect value={prefs.startPage || (prefs.defaultBotId ? "assistant" : "today")}
              onChange={event => save({ startPage: event.target.value as "today" | "assistant" })}>
              <option value="today">Today</option><option value="assistant">Assistant</option>
            </NativeSelect></label>
          <label className="settings-row"><span className="row-label">Open by default</span>
            <NativeSelect value={prefs.defaultBotId || ""} onChange={event => save({ defaultBotId: event.target.value || undefined })}>
              <option value="">First assistant</option>
              {bots.map(bot => <option value={bot.id} key={bot.id}>{bot.name}</option>)}
            </NativeSelect></label>
        </div>

        <h3 className="settings-heading">Notifications</h3>
        <div className="settings-group">
          <div className="settings-row settings-notifications"><NotificationSettings notifications={notifications} title="This device" /></div>
          <label className="settings-row"><span className="row-label">Batching</span>
            <NativeSelect value={prefs.notifications?.batchMinutes || 0} onChange={event => notify({ batchMinutes: Number(event.target.value) })}>
              <option value={0}>As updates arrive</option><option value={5}>Every 5 minutes</option>
              <option value={15}>Every 15 minutes</option><option value={60}>Hourly</option>
            </NativeSelect></label>
          {bots.length > 0 && <NavRow icon="bell" label={`Following ${assistants(bots.filter(bot => prefs.followBots.includes(bot.id)).length)}`}
            detail="All their activity, not only shared tasks" opens="following" onClick={() => go({ kind: "following" })} />}
          <Switch label="Quiet hours" checked={!!prefs.notifications?.quietStart}
            onChange={checked => save({ notifications: { timezone, batchMinutes: prefs.notifications?.batchMinutes || 0,
              ...(checked ? { quietStart: "22:00", quietEnd: "07:00" } : {}) } })} />
          {prefs.notifications?.quietStart && <>
            <label className="settings-row"><span className="row-label">From</span>
              <Input type="time" value={prefs.notifications.quietStart} onChange={event => notify({ quietStart: event.target.value })} /></label>
            <label className="settings-row"><span className="row-label">Until</span>
              <Input type="time" value={prefs.notifications.quietEnd} onChange={event => notify({ quietEnd: event.target.value })} /></label>
          </>}
        </div>
        {prefs.notifications?.quietStart && <p className="settings-footnote">
          {prefs.notifications.timezone}. Other notifications wait until quiet hours end; security alerts arrive right away.
          Decisions and failures skip batching outside quiet hours.</p>}

        <h3 className="settings-heading">Home sections</h3>
        <SectionList preferences={prefs} bots={bots} commit={commit} onOpen={id => go({ kind: "section", id })} />

        <div className="settings-group">
          {installEvent && <Button type="button" className="settings-row" onClick={() => void installEvent.prompt()}>
            <Icon name="download" size={18} /><span className="row-label">Install app</span></Button>}
          <Button type="button" className="settings-row danger" disabled={notifications.busy} onClick={() => void onSignOut()}>
            <span className="row-label">Sign out</span></Button>
        </div>
        <p className="settings-footnote">On iPhone, choose Share, then Add to Home Screen. Install before enabling notifications.</p>
        {notice && <p className="settings-footnote" role="status">{notice}</p>}
        <footer className="settings-footer">
          <span className="brand-mark" aria-hidden="true">w.</span>
          <strong>WildBots</strong>
          {hermes && <small>{hermes}</small>}
        </footer>
        </>}
      </div>
    </Dialog>
  );
}

function NavRow({ icon, label, detail, badge, opens, onClick }: { icon: IconName; label: string; detail?: string; badge?: ReactNode; opens?: string; onClick(): void }) {
  return <Button type="button" className="settings-row" data-opens={opens} onClick={onClick}>
    <span className="row-icon"><Icon name={icon} size={18} />{badge}</span>
    <span className="row-text"><span className="row-label">{label}</span>{detail && <small>{detail}</small>}</span>
    <Icon name="chevron" size={16} className="row-chevron" />
  </Button>;
}

function Switch({ label, detail, checked, onChange }: { label: string; detail?: string; checked: boolean; onChange(checked: boolean): void }) {
  return <label className="settings-row">
    <span className="row-text"><span className="row-label">{label}</span>{detail && <small>{detail}</small>}</span>
    <Input type="checkbox" role="switch" className="switch" checked={checked} onChange={event => onChange(event.target.checked)} />
  </label>;
}

/** One row of a multi-select list: the assistant, and a check on the right. */
function BotChoice({ bot, detail, checked, onChange }: { bot: Bot; detail?: string; checked: boolean; onChange(checked: boolean): void }) {
  return <label className="settings-row bot-choice">
    <Avatar avatar={bot.avatar} size={30} name={bot.name} reducedMotion />
    <span className="row-text"><span className="row-label">{bot.name}</span>{detail && <small>{detail}</small>}</span>
    <Input type="checkbox" className="choice-check" checked={checked} onChange={event => onChange(event.target.checked)} />
  </label>;
}

function FollowingPage({ preferences, bots, commit }: { preferences: Preferences; bots: Bot[]; commit: Commit }) {
  return <>
    <p className="settings-intro">Get a notification for every reply and update from these assistants. Shared tasks already notify the people in them.</p>
    <div className="settings-group" role="group" aria-label="Assistants you follow">
      {bots.map(bot => <BotChoice key={bot.id} bot={bot} checked={preferences.followBots.includes(bot.id)}
        onChange={checked => commit(value => setFollowing(value, bot.id, checked))} />)}
    </div>
  </>;
}

/** The sections on home, in order, with one field to add another. */
function SectionList({ preferences, bots, commit, onOpen }: { preferences: Preferences; bots: Bot[]; commit: Commit; onOpen(id: string): void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const { sections } = preferences;
  const members = (section: Section) => section.botIds.filter(id => bots.some(bot => bot.id === id)).length;
  return <>
    <div className="settings-group">
      {sections.map((section, index) => <div className="settings-row section-row" key={section.id}>
        <Button type="button" className="section-open" data-opens={`section:${section.id}`} onClick={() => onOpen(section.id)}>
          <span className="row-icon"><Icon name="folder" size={18} /></span>
          <span className="row-text"><span className="row-label">{section.name}</span>
            <small>{members(section) ? assistants(members(section)) : "No assistants yet"}</small></span>
          <Icon name="chevron" size={16} className="row-chevron" />
        </Button>
        {sections.length > 1 && <span className="section-order">
          <Button type="button" className="icon-button" aria-label={`Move ${section.name} up`} disabled={index === 0}
            onClick={() => commit(value => moveSection(value, section.id, -1))}><Icon name="send" size={16} /></Button>
          <Button type="button" className="icon-button" aria-label={`Move ${section.name} down`} disabled={index === sections.length - 1}
            onClick={() => commit(value => moveSection(value, section.id, 1))}><Icon name="latest" size={16} /></Button>
        </span>}
      </div>)}
      {/* Add stays available: an empty name explains itself instead of leaving a greyed-out button. */}
      <form className="settings-row section-add" onSubmit={event => {
        event.preventDefault();
        const checked = checkSectionName(preferences, name);
        if ("error" in checked) { setError(checked.error); field.current?.focus(); return; }
        const id = newSectionId();
        commit(value => addSection(value, checked.name, id));
        setName(""); setError("");
      }}>
        <span className="row-icon"><Icon name="plus" size={18} /></span>
        <Input ref={field} aria-label="New section name" aria-invalid={!!error || undefined} aria-describedby={error ? "section-add-error" : undefined}
          maxLength={100} value={name} placeholder="New section, like Kids" onChange={event => { setName(event.target.value); setError(""); }} />
        <Button type="submit" className="primary">Add</Button>
      </form>
    </div>
    <p className="settings-footnote" id={error ? "section-add-error" : undefined} role={error ? "alert" : undefined}>
      {error ? <span className="form-error">{error}</span> : "Group assistants on home. Each assistant can be in one section."}</p>
  </>;
}

/** One section: its name, its assistants as one multi-select, and delete. */
function SectionPage({ preferences, bots, section, commit, onDeleted }: {
  preferences: Preferences; bots: Bot[]; section: Section; commit: Commit; onDeleted(): void;
}) {
  const [name, setName] = useState(section.name);
  const [error, setError] = useState("");
  const changed = name.trim().replace(/\s+/g, " ") !== section.name;
  return <>
    <form className="settings-group settings-row section-add" onSubmit={event => {
      event.preventDefault();
      if (!changed) return;
      const checked = checkSectionName(preferences, name, section.id);
      if ("error" in checked) { setError(checked.error); return; }
      commit(value => renameSection(value, section.id, checked.name));
      setName(checked.name);
    }}>
      <Input aria-label="Section name" aria-invalid={!!error || undefined} maxLength={100} value={name}
        onChange={event => { setName(event.target.value); setError(""); }} />
      {changed && <Button type="submit" className="primary">Rename</Button>}
    </form>
    {error && <FormMessage tone="error" className="settings-footnote">{error}</FormMessage>}
    <h3 className="settings-heading">Assistants in {section.name}</h3>
    <div className="settings-group" role="group" aria-label={`Assistants in ${section.name}`}>
      {bots.map(bot => {
        const elsewhere = sectionOf(preferences, bot.id);
        return <BotChoice key={bot.id} bot={bot} checked={section.botIds.includes(bot.id)}
          detail={elsewhere && elsewhere.id !== section.id ? `In ${elsewhere.name}` : undefined}
          onChange={checked => commit(value => {
            const current = value.sections.find(item => item.id === section.id)?.botIds ?? [];
            return setSectionBots(value, section.id, checked ? [...current, bot.id] : current.filter(id => id !== bot.id));
          })} />;
      })}
    </div>
    <p className="settings-footnote">Choosing an assistant that is in another section moves it here.</p>
    <div className="settings-group">
      <Button type="button" className="settings-row danger" onClick={() => { commit(value => removeSection(value, section.id)); onDeleted(); }}>
        <span className="row-label">Delete section</span></Button>
    </div>
    <p className="settings-footnote">Its assistants stay on home, in the main list.</p>
  </>;
}
