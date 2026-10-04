import { useEffect, useRef, useState } from "react";
import type { Bot, Preferences } from "../shared/types";
import { Icon } from "../components/Icon";
import { NotificationSettings } from "../components/DeviceNotifications";
import type { useDeviceNotifications } from "../components/use-device-notifications";
import type { InstallEvent } from "./use-browser";
export function PreferencesDialog({ prefs, bots, savePreferences, notifications, mobile, installEvent, notice, onClose, onSignOut }: {
  prefs: Preferences;
  bots: Bot[];
  savePreferences(value: Preferences): Promise<void>;
  notifications: ReturnType<typeof useDeviceNotifications>;
  mobile: boolean;
  installEvent: InstallEvent | null;
  notice: string;
  onClose(): void;
  onSignOut(): Promise<void>;
}) {
  const preferencesDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = preferencesDialog.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (mobile) document.querySelector<HTMLButtonElement>("[aria-label='Open assistants']")?.focus();
    };
  }, [mobile]);
  return (
    <dialog
      ref={preferencesDialog}
      className="preferences-panel"
      aria-labelledby="preferences-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <header>
        <h2 id="preferences-title">Your preferences</h2>
        <button
          className="icon-button"
          aria-label="Close preferences"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <label>
        Appearance
        <select
          value={prefs.theme}
          onChange={(e) =>
            void savePreferences({
              ...prefs,
              theme: e.target.value as Preferences["theme"],
            })
          }
        >
          <option value="system">Follow device</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <label>
        Presentation
        <select
          value={prefs.presentation}
          onChange={(e) =>
            void savePreferences({
              ...prefs,
              presentation: e.target.value as Preferences["presentation"],
            })
          }
        >
          <option value="simple">Simple</option>
          <option value="advanced">Advanced</option>
        </select>
      </label>
      <label>Start page<select value={prefs.startPage || (prefs.defaultBotId?'assistant':'today')} onChange={e=>void savePreferences({...prefs,startPage:e.target.value as 'today'|'assistant'})}><option value="today">Today</option><option value="assistant">Assistant</option></select></label>
      <label>Notification batching<select value={prefs.notifications?.batchMinutes||0} onChange={e=>void savePreferences({...prefs,notifications:{timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,...prefs.notifications,batchMinutes:Number(e.target.value)}})}><option value={0}>As updates arrive</option><option value={5}>Every 5 minutes</option><option value={15}>Every 15 minutes</option><option value={60}>Hourly</option></select></label>
      <label><input type="checkbox" checked={!!prefs.notifications?.quietStart} onChange={e=>void savePreferences({...prefs,notifications:{timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,batchMinutes:prefs.notifications?.batchMinutes||0,...(e.target.checked?{quietStart:'22:00',quietEnd:'07:00'}:{})}})} /> Quiet hours</label>
      {prefs.notifications?.quietStart && <div className="quiet-hours"><label>From<input type="time" value={prefs.notifications.quietStart} onChange={e=>void savePreferences({...prefs,notifications:{...prefs.notifications!,quietStart:e.target.value}})} /></label><label>Until<input type="time" value={prefs.notifications.quietEnd} onChange={e=>void savePreferences({...prefs,notifications:{...prefs.notifications!,quietEnd:e.target.value}})} /></label><small>{prefs.notifications.timezone}. Other notifications wait until quiet hours end; security alerts arrive right away. Decisions and failures skip batching outside quiet hours.</small></div>}
      <label>
        Open by default
        <select
          value={prefs.defaultBotId || ""}
          onChange={(e) =>
            void savePreferences({
              ...prefs,
              defaultBotId: e.target.value || undefined,
            })
          }
        >
          <option value="">First assistant</option>
          {bots.map((bot) => (
            <option value={bot.id} key={bot.id}>
              {bot.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>Follow all activity</legend>
        <p className="muted">
          Shared-task notifications already go to participants. Follow an
          assistant to receive all their activity.
        </p>
        {bots.map((bot) => (
          <label className="checkbox-label" key={bot.id}>
            <input
              type="checkbox"
              checked={prefs.followBots.includes(bot.id)}
              onChange={(e) =>
                void savePreferences({
                  ...prefs,
                  followBots: e.target.checked
                    ? [...prefs.followBots, bot.id]
                    : prefs.followBots.filter((id) => id !== bot.id),
                })
              }
            />
            {bot.name}
          </label>
        ))}
      </fieldset>
      <SectionEditor
        preferences={prefs}
        bots={bots}
        save={savePreferences}
      />
      <NotificationSettings notifications={notifications} />
      <div className="actions">
        <button
          disabled={notifications.busy}
          onClick={() => void onSignOut()}
        >
          Sign out
        </button>
        {installEvent && (
          <button onClick={() => void installEvent.prompt()}>
            Install app
          </button>
        )}
      </div>
      <p className="muted">
        On iPhone, choose Share, then Add to Home Screen. Install before
        enabling notifications.
      </p>
      {notice && <p role="status">{notice}</p>}
    </dialog>
  );
}
function SectionEditor({
  preferences,
  bots,
  save,
}: {
  preferences: Preferences;
  bots: Bot[];
  save: (v: Preferences) => Promise<void>;
}) {
  const [name, setName] = useState("");
  return (
    <fieldset>
      <legend>Assistant sections</legend>
      {preferences.sections.map((section) => (
        <div className="section-editor" key={section.id}>
          <div className="actions">
            <strong>{section.name}</strong>
            <button
              className="icon-button"
              aria-label={`Remove section ${section.name}`}
              onClick={() =>
                void save({
                  ...preferences,
                  sections: preferences.sections.filter(
                    (s) => s.id !== section.id,
                  ),
                })
              }
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          {bots.map((bot) => (
            <label className="checkbox-label" key={bot.id}>
              <input
                type="checkbox"
                checked={section.botIds.includes(bot.id)}
                onChange={(e) =>
                  void save({
                    ...preferences,
                    sections: preferences.sections.map((s) =>
                      s.id === section.id
                        ? {
                            ...s,
                            botIds: e.target.checked
                              ? [...s.botIds, bot.id]
                              : s.botIds.filter((id) => id !== bot.id),
                          }
                        : s,
                    ),
                  })
                }
              />
              {bot.name}
            </label>
          ))}
        </div>
      ))}
      <div className="actions">
        <input
          aria-label="New section name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Section name"
        />
        <button
          disabled={!name.trim()}
          onClick={() => {
            void save({
              ...preferences,
              sections: [
                ...preferences.sections,
                { id: crypto.randomUUID(), name: name.trim(), botIds: [] },
              ],
            });
            setName("");
          }}
        >
          Add
        </button>
      </div>
    </fieldset>
  );
}
