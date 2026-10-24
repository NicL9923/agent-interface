import { memo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuRadioGroup, ContextMenuRadioItem, ContextMenuSeparator, ContextMenuSubmenu, ContextMenuSubmenuContent, ContextMenuSubmenuTrigger, ContextMenuTrigger } from "../components/ui/context-menu";
import type { ActivityState, Bootstrap, Bot, Preferences } from "../shared/types";
import { Avatar, stateLabels } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { useMinute } from "../components/When";
import { formatListDate } from "../time";
import type { View } from "./view";
import type { AppUpdate } from "./use-browser";
import { UpdateNotice } from "./UpdateNotice";
import { sectionOf } from "./preferences-editing";
import { isUnread, type ReadThrough } from "./unread";
import "./home.css";

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase() || "?";

/**
 * Home: pinned assistants up top, then everyone else with their latest message.
 * Memoized so typing and streamed replies do not redraw every row and live avatar.
 */
export const Sidebar = memo(function Sidebar({ boot, botId, shownBotId, readThrough, view, state, connectionLost, offline, mobile, open, update, onSelectBot, onView, onNewBot, onSettings, onPin, onBotSettings, onMoveToSection, onNewSection }: {
  boot: Bootstrap;
  botId: string;
  /** The chat on screen now, which is never marked unread. */
  shownBotId?: string;
  readThrough: ReadThrough;
  view: View;
  state: ActivityState;
  connectionLost: boolean;
  offline: boolean;
  mobile: boolean;
  open: boolean;
  update: AppUpdate | null;
  onSelectBot(id: string): void;
  onView(view: View): void;
  onNewBot(): void;
  onSettings(): void;
  onPin(bot: Bot): void;
  onBotSettings(bot: Bot): void;
  onMoveToSection(bot: Bot, sectionId: string | null): void;
  onNewSection(bot: Bot): void;
}) {
  const prefs = boot.preferences;
  const pinned = prefs.favorites.map(id => boot.bots.find(bot => bot.id === id)).filter((bot): bot is Bot => !!bot);
  const unpinned = boot.bots.filter(bot => !prefs.favorites.includes(bot.id));
  const sections = prefs.sections.map(section => ({ ...section, bots: unpinned.filter(bot => section.botIds.includes(bot.id)) }))
    .filter(section => section.bots.length);
  const rest = unpinned.filter(bot => !prefs.sections.some(section => section.botIds.includes(bot.id)));
  const activity = (bot: Bot): ActivityState => connectionLost ? "disconnected" : bot.id === botId ? state : bot.activity;
  const current = (bot: Bot) => bot.id === botId && view === "conversation";
  const unread = (bot: Bot) => isUnread(bot, shownBotId, readThrough);
  const row = (bot: Bot) => {
    const botState = activity(bot);
    const working = !connectionLost && botState !== "idle" && botState !== "done";
    return <li key={bot.id}>
      <BotMenu bot={bot} preferences={prefs} onPin={() => onPin(bot)} onSettings={() => onBotSettings(bot)}
        onMove={sectionId => onMoveToSection(bot, sectionId)} onNewSection={() => onNewSection(bot)}>
        <Button className={`bot-item bot-row${current(bot) ? " selected" : ""}${unread(bot) ? " unread" : ""}`} aria-current={current(bot) ? "page" : undefined}
          onClick={() => onSelectBot(bot.id)}>
          <Avatar avatar={bot.avatar} state={botState === "done" ? "idle" : botState} size={mobile ? 52 : 44} name={bot.name} reducedMotion />
          <span className="bot-row-text">
            <span className="bot-row-top"><strong>{bot.name}</strong>
              {unread(bot) && <UnreadMark />}
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
      <UpdateNotice update={update} />
      <div className="home-scroll">
        {pinned.length > 0 && <ul className="home-pinned" aria-label="Pinned assistants">
          {pinned.map(bot => {
            const botState = activity(bot);
            const showActivity = botState !== "idle" && botState !== "done";
            return <li key={bot.id}>
              <BotMenu bot={bot} preferences={prefs} onPin={() => onPin(bot)} onSettings={() => onBotSettings(bot)}
                onMove={sectionId => onMoveToSection(bot, sectionId)} onNewSection={() => onNewSection(bot)}>
                <Button className={`bot-item pinned-bot${current(bot) ? " selected" : ""}${unread(bot) ? " unread" : ""}`} aria-current={current(bot) ? "page" : undefined}
                  onClick={() => onSelectBot(bot.id)}>
                  <span className="pinned-avatar">
                    {/* Pinned assistants are few and featured, so they stay alive; the system Reduce Motion setting still applies. */}
                    <Avatar avatar={bot.avatar} state={botState === "done" ? "idle" : botState} size={mobile ? 92 : 60} name={bot.name} botId={bot.id} />
                    <span className="pin-badge" aria-hidden="true"><Icon name="pin" size={mobile ? 13 : 11} /></span>
                  </span>
                  <span className="pinned-copy">
                    <span className="pinned-name">{unread(bot) && <UnreadMark />}{bot.name}</span>
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
});

/** A dot for sight and a word for screen readers, which read it with the row's name. */
function UnreadMark() {
  return <span className="unread-mark"><span className="sr-only">Unread</span></span>;
}

// Owns the minute clock, so only the dates re-render as time passes.
function ListDate({ value }: { value: string }) {
  useMinute();
  return <time dateTime={value}>{formatListDate(value)}</time>;
}

function BotMenu({ bot, preferences, onPin, onSettings, onMove, onNewSection, children }: {
  bot: Bot; preferences: Preferences; onPin(): void; onSettings(): void; onMove(sectionId: string | null): void; onNewSection(): void; children: ReactElement;
}) {
  const pinned = preferences.favorites.includes(bot.id);
  const current = sectionOf(preferences, bot.id)?.id ?? "";
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
      <ContextMenuSubmenu>
        <ContextMenuSubmenuTrigger><Icon name="folder" size={16} />Move to section<Icon name="chevron" size={14} className="bot-menu-more" /></ContextMenuSubmenuTrigger>
        <ContextMenuSubmenuContent className="bot-menu" aria-label="Home section">
          <ContextMenuRadioGroup value={current} onValueChange={value => onMove(value ? String(value) : null)}>
            <ContextMenuRadioItem value="">None</ContextMenuRadioItem>
            {preferences.sections.map(section => <ContextMenuRadioItem key={section.id} value={section.id}>{section.name}</ContextMenuRadioItem>)}
          </ContextMenuRadioGroup>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onNewSection}><Icon name="plus" size={16} />New section…</ContextMenuItem>
        </ContextMenuSubmenuContent>
      </ContextMenuSubmenu>
      <ContextMenuItem onClick={onSettings}><Icon name="gear" size={16} />Assistant settings</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>;
}
