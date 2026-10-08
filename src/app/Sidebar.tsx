import { useEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
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
  const [menu, setMenu] = useState<{ bot: Bot; x: number; y: number } | null>(null);
  const prefs = boot.preferences;
  const pinned = prefs.favorites.map(id => boot.bots.find(bot => bot.id === id)).filter((bot): bot is Bot => !!bot);
  const unpinned = boot.bots.filter(bot => !prefs.favorites.includes(bot.id));
  const sections = prefs.sections.map(section => ({ ...section, bots: unpinned.filter(bot => section.botIds.includes(bot.id)) }))
    .filter(section => section.bots.length);
  const rest = unpinned.filter(bot => !prefs.sections.some(section => section.botIds.includes(bot.id)));
  const activity = (bot: Bot): ActivityState => connectionLost ? "disconnected" : bot.id === botId ? state : bot.activity;
  const current = (bot: Bot) => bot.id === botId && view === "conversation";
  // Long-press on touch and the context menu elsewhere offer Pin and Settings.
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean; x: number; y: number } | null>(null);
  useEffect(() => () => { if (press.current) clearTimeout(press.current.timer); }, []);
  const cancelPress = () => { if (press.current && !press.current.fired) { clearTimeout(press.current.timer); press.current = null; } };
  const menuProps = (bot: Bot) => ({
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      // The keyboard's menu key reports no pointer position; open beside the row instead.
      const rect = event.currentTarget.getBoundingClientRect();
      const keyboard = !event.clientX && !event.clientY;
      setMenu({ bot, x: keyboard ? rect.left + 24 : event.clientX, y: keyboard ? rect.bottom - 8 : event.clientY });
    },
    onPointerDown: (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      const { clientX: x, clientY: y } = event;
      cancelPress();
      const state = { x, y, fired: false, timer: setTimeout(() => { state.fired = true; setMenu({ bot, x, y }); }, 500) };
      press.current = state;
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    // Scrolling the list is not a long-press, however slowly the finger drifts.
    onPointerMove: (event: PointerEvent) => {
      if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) cancelPress();
    },
    onClickCapture: (event: MouseEvent) => { if (press.current?.fired) { event.preventDefault(); event.stopPropagation(); press.current = null; } },
  });
  const row = (bot: Bot) => {
    const botState = activity(bot);
    const working = !connectionLost && botState !== "idle" && botState !== "done";
    return <li key={bot.id}>
      <button type="button" className={`bot-item bot-row${current(bot) ? " selected" : ""}`} aria-current={current(bot) ? "page" : undefined}
        onClick={() => onSelectBot(bot.id)} {...menuProps(bot)}>
        <Avatar avatar={bot.avatar} state={botState === "done" ? "idle" : botState} size={mobile ? 52 : 44} name={bot.name} reducedMotion />
        <span className="bot-row-text">
          <span className="bot-row-top"><strong>{bot.name}</strong>
            {bot.lastMessage?.at && <ListDate value={bot.lastMessage.at} />}</span>
          <small className={working ? `bot-activity state-${botState}` : undefined}>
            {working ? stateLabels[botState] : bot.lastMessage?.text || (bot.shared ? "Shared assistant" : "Personal assistant")}
          </small>
        </span>
      </button>
    </li>;
  };
  const status = connectionLost ? offline ? "offline" : "reconnecting" : "connected";
  return (
    <aside id="assistant-navigation" className={`bot-rail home${open ? " open" : ""}`} aria-label="Assistants" inert={mobile && !open}>
      <header className="home-bar">
        <button type="button" className="home-account" aria-label="Settings" title="Settings" onClick={onSettings}>
          {boot.user.picture ? <img src={boot.user.picture} alt="" referrerPolicy="no-referrer" /> : initials(boot.user.name)}
          <span className={`home-status home-status-${status}`} aria-hidden="true" />
        </button>
        {connectionLost && <span className="home-sync" role="status">
          <Icon name="spinner" size={16} className={offline ? undefined : "spin"} />{offline ? "Offline" : "Reconnecting"}</span>}
        <span className="home-bar-actions">
          <button type="button" className="home-round" aria-label="Search & saved" aria-pressed={view === "find"} onClick={() => onView("find")}>
            <Icon name="search" />
          </button>
          <button type="button" className="home-round" aria-label="New assistant" onClick={onNewBot}><Icon name="plus" /></button>
        </span>
      </header>
      <div className="home-scroll">
        {pinned.length > 0 && <ul className="home-pinned" aria-label="Pinned assistants">
          {pinned.map(bot => {
            const botState = activity(bot);
            return <li key={bot.id}>
              <button type="button" className={`bot-item pinned-bot${current(bot) ? " selected" : ""}`} aria-current={current(bot) ? "page" : undefined}
                onClick={() => onSelectBot(bot.id)} {...menuProps(bot)}>
                <span className="pinned-avatar">
                  <Avatar avatar={bot.avatar} state={botState === "done" ? "idle" : botState} size={mobile ? 92 : 60} name={bot.name} reducedMotion />
                  <span className="pin-badge" aria-hidden="true"><Icon name="pin" size={mobile ? 13 : 11} /></span>
                </span>
                <span className="pinned-name">{bot.name}</span>
              </button>
            </li>;
          })}
        </ul>}
        <nav className="home-links" aria-label="Household">
          {([["today", "Today"], ["groups", "Group chats"]] as const).map(([item, label]) => (
            <button key={item} type="button" aria-current={view === item ? "page" : undefined} onClick={() => onView(item)}>
              <Icon name={item} size={16} /> {label}
            </button>
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
          <button type="button" className="primary" onClick={onNewBot}>Create an assistant</button>
        </div>}
      </div>
      {menu && <BotMenu bot={menu.bot} x={menu.x} y={menu.y} pinned={prefs.favorites.includes(menu.bot.id)}
        onPin={() => onPin(menu.bot)} onSettings={() => onBotSettings(menu.bot)} onClose={() => setMenu(null)} />}
    </aside>
  );
}

// Owns the minute clock, so only the dates re-render as time passes.
function ListDate({ value }: { value: string }) {
  useMinute();
  return <time dateTime={value}>{formatListDate(value)}</time>;
}

function BotMenu({ bot, x, y, pinned, onPin, onSettings, onClose }: {
  bot: Bot; x: number; y: number; pinned: boolean; onPin(): void; onSettings(): void; onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onClose);
  dismiss.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    menu.current?.querySelector("button")?.focus();
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menu.current?.contains(event.target as Node)) dismiss.current();
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => { document.removeEventListener("keydown", close); document.removeEventListener("pointerdown", close); previous?.focus(); };
  }, []);
  const left = Math.min(Math.max(x, 12), window.innerWidth - 212);
  const top = Math.min(Math.max(y, 12), window.innerHeight - 124);
  const choose = (action: () => void) => () => { onClose(); action(); };
  return <div ref={menu} className="bot-menu" role="menu" aria-label={bot.name} style={{ left, top }}>
    <button type="button" role="menuitem" onClick={choose(onPin)}><Icon name="pin" size={16} />{pinned ? "Unpin" : "Pin to top"}</button>
    <button type="button" role="menuitem" onClick={choose(onSettings)}><Icon name="gear" size={16} />Assistant settings</button>
  </div>;
}
