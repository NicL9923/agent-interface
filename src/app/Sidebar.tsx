import { useRef, useState } from "react";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../components/ui/context-menu";
import type { ActivityState, Bootstrap, Bot } from "../shared/types";
import { Avatar, stateLabels } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { useMinute } from "../components/When";
import { formatListDate } from "../time";
import type { View } from "./view";
import "./home.css";

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase() || "?";

/** Home: pinned assistants up top, then everyone else with their latest message. */
export function Sidebar({ boot, botId, view, state, connectionLost, offline, mobile, open, onSelectBot, onView, onNewBot, onSettings, onPin, onBotSettings }: {
  boot: Bootstrap;
  botId: string;
  view: View;
  state: ActivityState;
  connectionLost: boolean;
  offline: boolean;
  mobile: boolean;
  open: boolean;
  onSelectBot(id: string): void;
  onView(view: View): void;
  onNewBot(): void;
  onSettings(): void;
  onPin(bot: Bot): void;
  onBotSettings(bot: Bot): void;
}) {
  const prefs = boot.preferences;
  const pinned = prefs.favorites.map(id => boot.bots.find(bot => bot.id === id)).filter((bot): bot is Bot => !!bot);
  const unpinned = boot.bots.filter(bot => !prefs.favorites.includes(bot.id));
  const sections = prefs.sections.map(section => ({ ...section, bots: unpinned.filter(bot => section.botIds.includes(bot.id)) }))
    .filter(section => section.bots.length);
  const rest = unpinned.filter(bot => !prefs.sections.some(section => section.botIds.includes(bot.id)));
  const activity = (bot: Bot): ActivityState => connectionLost ? "disconnected" : bot.id === botId ? state : bot.activity;
  const current = (bot: Bot) => bot.id === botId && view === "conversation";
  const row = (bot: Bot) => {
    const botState = activity(bot);
    const working = !connectionLost && botState !== "idle" && botState !== "done";
    return <li key={bot.id}>
      <BotMenu bot={bot} pinned={prefs.favorites.includes(bot.id)} onPin={() => onPin(bot)} onSettings={() => onBotSettings(bot)}>
        <Button className={`bot-item bot-row${current(bot) ? " selected" : ""}`} aria-current={current(bot) ? "page" : undefined}
          onClick={() => onSelectBot(bot.id)}>
          <Avatar avatar={bot.avatar} state={botState === "done" ? "idle" : botState} size={mobile ? 52 : 44} name={bot.name} reducedMotion />
          <span className="bot-row-text">
            <span className="bot-row-top"><strong>{bot.name}</strong>
              {bot.lastMessage?.at && <ListDate value={bot.lastMessage.at} />}</span>
            <small className={working ? `bot-activity state-${botState}` : undefined}>
              {working ? stateLabels[botState] : bot.lastMessage?.text || (bot.shared ? "Shared assistant" : "Personal assistant")}
            </small>
          </span>
        </Button>
      </BotMenu>
    </li>;
  };
  const status = connectionLost ? offline ? "offline" : "reconnecting" : "connected";
  return (
    <aside id="assistant-navigation" className={`bot-rail home${open ? " open" : ""}`} aria-label="Assistants" inert={mobile && !open}>
      <header className="home-bar">
        <Button className="home-account" aria-label="Settings" title="Settings" onClick={onSettings}>
          {boot.user.picture ? <img src={boot.user.picture} alt="" referrerPolicy="no-referrer" /> : initials(boot.user.name)}
          <span className={`home-status home-status-${status}`} aria-hidden="true" />
        </Button>
        {connectionLost && <span className="home-sync" role="status">
          <Icon name="spinner" size={16} className={offline ? undefined : "spin"} />{offline ? "Offline" : "Reconnecting"}</span>}
        <span className="home-bar-actions">
          <Button className="home-round" aria-label="Search & saved" aria-pressed={view === "find"} onClick={() => onView("find")}>
            <Icon name="search" />
          </Button>
          <Button className="home-round" aria-label="New assistant" onClick={onNewBot}><Icon name="plus" /></Button>
        </span>
      </header>
      <div className="home-scroll">
        {pinned.length > 0 && <ul className="home-pinned" aria-label="Pinned assistants">
          {pinned.map(bot => {
            const botState = activity(bot);
            const showActivity = botState !== "idle" && botState !== "done";
            return <li key={bot.id}>
              <BotMenu bot={bot} pinned onPin={() => onPin(bot)} onSettings={() => onBotSettings(bot)}>
                <Button className={`bot-item pinned-bot${current(bot) ? " selected" : ""}`} aria-current={current(bot) ? "page" : undefined}
                  onClick={() => onSelectBot(bot.id)}>
                  <span className="pinned-avatar">
                    <Avatar avatar={bot.avatar} state={botState === "done" ? "idle" : botState} size={mobile ? 92 : 60} name={bot.name} reducedMotion />
                    <span className="pin-badge" aria-hidden="true"><Icon name="pin" size={mobile ? 13 : 11} /></span>
                  </span>
                  <span className="pinned-copy">
                    <span className="pinned-name">{bot.name}</span>
                    <small className={`pinned-activity${showActivity ? ` bot-activity state-${botState}` : ""}`}>
                      {showActivity ? stateLabels[botState] : null}
                    </small>
                  </span>
                </Button>
              </BotMenu>
            </li>;
          })}
        </ul>}
        <nav className="home-links" aria-label="Household">
          {([["today", "Today"], ["groups", "Group chats"]] as const).map(([item, label]) => (
            <Button key={item} aria-current={view === item ? "page" : undefined} onClick={() => onView(item)}>
              <Icon name={item} size={16} /> {label}
            </Button>
          ))}
        </nav>
        {sections.map(section => <section className="bot-section" key={section.id} aria-label={section.name}>
          <h2>{section.name}</h2>
          <ul className="home-list">{section.bots.map(row)}</ul>
        </section>)}
        {rest.length > 0 && <section className="bot-section" aria-label={sections.length || pinned.length ? "More assistants" : "Your assistants"}>
          {sections.length > 0 && <h2>More assistants</h2>}
          <ul className="home-list">{rest.map(row)}</ul>
        </section>}
        {!boot.bots.length && <div className="home-empty">
          <p className="muted">No assistants are available from Hermes yet.</p>
          <Button className="primary" onClick={onNewBot}>Create an assistant</Button>
        </div>}
      </div>
    </aside>
  );
}

// Owns the minute clock, so only the dates re-render as time passes.
function ListDate({ value }: { value: string }) {
  useMinute();
  return <time dateTime={value}>{formatListDate(value)}</time>;
}

function BotMenu({ bot, pinned, onPin, onSettings, children }: {
  bot: Bot; pinned: boolean; onPin(): void; onSettings(): void; children: ReactElement;
}) {
  const trigger = useRef<HTMLDivElement>(null);
  const [keyboardAnchor, setKeyboardAnchor] = useState(false);
  const suppressTouchClick = useRef(false);
  return <ContextMenu onOpenChange={(open, details) => {
    if (open && details.event.type.startsWith("touch")) suppressTouchClick.current = true;
  }}>
    <ContextMenuTrigger ref={trigger} render={children}
      onContextMenu={event => setKeyboardAnchor(!event.clientX && !event.clientY)}
      // Browsers may report the menu key without coordinates; anchor that menu to its row.
      onKeyDown={event => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      }}
      onTouchStart={() => { suppressTouchClick.current = false; setKeyboardAnchor(false); }}
      onClickCapture={event => {
        if (!suppressTouchClick.current) return;
        event.preventDefault(); event.stopPropagation(); suppressTouchClick.current = false;
      }} />
    <ContextMenuContent className="bot-menu" aria-label={bot.name} finalFocus={trigger}
      positionerProps={{ collisionPadding: 12, ...(keyboardAnchor ? { anchor: trigger } : {}) }}>
      <ContextMenuItem onClick={onPin}><Icon name="pin" size={16} />{pinned ? "Unpin" : "Pin to top"}</ContextMenuItem>
      <ContextMenuItem onClick={onSettings}><Icon name="gear" size={16} />Assistant settings</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>;
}
