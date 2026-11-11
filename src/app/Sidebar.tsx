import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "../components/ui/button";
import type { ActivityState, Bot } from "../shared/types";
import type { GroupRoom } from "../shared/collaboration";
import { Avatar, stateLabels } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { useMinute } from "../components/When";
import { formatListDate } from "../time";
import type { View } from "./view";
import type { AppUpdate } from "./use-browser";
import { UpdateNotice } from "./UpdateNotice";
import { BotMenu } from "./BotMenu";
import { prefetchFirstPage } from "./conversation-page";
import { NewMenu } from "./NewMenu";
import { memberNames, roomFaces, roomPreview, type PendingGroup } from "./home-rooms";
import { isUnread, type ReadThrough } from "./unread";
import { glanceAtAvatar, reactAvatar } from "../components/avatar-attention";
import { homeSeason } from "./season";
import { SeasonalAmbience } from "./SeasonalAmbience";
import { AccountMenu, initials } from "./AccountMenu";
import { mainBot } from "../shared/main-assistant";
import type { HomeSource } from "./saved-roster";
import "./home.css";

/** Group chats on home: the rooms in order, what is open, and how to make or finish one. */
export type HomeGroups = {
  rooms: GroupRoom[];
  /** The room open in the main pane. */
  roomId: string;
  /** False when Hermes cannot host groups at all, which hides the choice to make one. */
  canCreate: boolean;
  /** Why making one is not possible right now, when it is not. */
  hint?: string;
  /** A saved creation whose outcome is unknown. */
  pending: PendingGroup | null;
  /** The rooms are this device's saved copy, from before the group catalog loaded: no latest message is known. */
  saved?: boolean;
  onSelect(id: string): void;
  onCreate(): void;
};

/** Home without group chats, for a household whose Hermes cannot host them. */
export const noGroups: HomeGroups = { rooms: [], roomId: "", canCreate: false, pending: null, onSelect: () => {}, onCreate: () => {} };


/**
 * Home: pinned assistants up top, then everyone else with their latest message.
 * Memoized so typing and streamed replies do not redraw every row and live avatar.
 */
export const Sidebar = memo(function Sidebar({ boot, saved = false, botId, shownBotId, readThrough, groups = noGroups, view, state, connectionLost, offline, mobile, open, update, onSelectBot, onView, onNewBot, onSettings, onUsage, onSignOut, onPin, onBotSettings, onMoveToSection, onNewSection, onChooseMain, onDismissMainSuggestion }: {
  boot: HomeSource;
  /**
   * `boot` is this device's saved copy of home, drawn before bootstrap answers (see saved-roster.ts),
   * which carries no unread mark, activity or latest message. Rows open chats, which wait for
   * bootstrap; nothing that needs the server can be used.
   */
  saved?: boolean;
  botId: string;
  /** The chat on screen now, which is never marked unread. */
  shownBotId?: string;
  readThrough: ReadThrough;
  /** Group chats listed beside the assistants. Without any, home shows assistants alone. */
  groups?: HomeGroups;
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
  onUsage(): void;
  onSignOut(): void;
  onPin(bot: Bot): void;
  onBotSettings(bot: Bot): void;
  onMoveToSection(bot: Bot, sectionId: string | null): void;
  onNewSection(bot: Bot): void;
  /** Opens the main assistant picker. Without it, home never suggests choosing one. */
  onChooseMain?(): void;
  onDismissMainSuggestion?(): void;
}) {
  const prefs = boot.preferences;
  // The main assistant leads home, above the pinned ones, and appears nowhere else on it.
  const main = mainBot(prefs, boot.bots);
  const others = boot.bots.filter(bot => bot !== main);
  const pinned = prefs.favorites.map(id => others.find(bot => bot.id === id)).filter((bot): bot is Bot => !!bot);
  const unpinned = others.filter(bot => !prefs.favorites.includes(bot.id));
  const suggestMain = !main && !prefs.mainSuggestionDismissed && !!onChooseMain && boot.bots.length > 0;
  const sections = prefs.sections.map(section => ({ ...section, bots: unpinned.filter(bot => section.botIds.includes(bot.id)) }))
    .filter(section => section.bots.length);
  const rest = unpinned.filter(bot => !prefs.sections.some(section => section.botIds.includes(bot.id)));
  const activity = (bot: Bot): ActivityState => connectionLost ? "disconnected" : bot.id === botId ? state : bot.activity;
  const current = (bot: Bot) => bot.id === botId && view === "conversation";
  const unread = (bot: Bot) => isUnread(bot, shownBotId, readThrough);
  // A pinned assistant that finishes its work hops, and the other pinned ones look over at it.
  const before = useRef(new Map<string, ActivityState>());
  const pinnedStates = JSON.stringify(pinned.map(bot => [bot.id, activity(bot)]));
  useEffect(() => {
    const seen = before.current, next = new Map<string, ActivityState>();
    for (const [id, now] of JSON.parse(pinnedStates) as [string, ActivityState][]) {
      next.set(id, now);
      const was = seen.get(id);
      if ((was === "working" || was === "thinking") && (now === "done" || now === "idle")) {
        reactAvatar(id, "cheer");
        glanceAtAvatar(id);
      }
    }
    before.current = next;
  }, [pinnedStates]);
  // The date is read again every hour, so a season starts without a reload.
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setToday(new Date()), 3_600_000);
    return () => clearInterval(timer);
  }, []);
  const season = homeSeason(today, pinned);
  // Pointing at, pressing or focusing a row reads its chat before the click opens it.
  const intent = (bot: Bot) => {
    // Before bootstrap no read may start here: the account it would be made for is not yet known.
    const prefetch = () => { if (!saved && !current(bot)) prefetchFirstPage(bot.id); };
    return { onPointerEnter: prefetch, onPointerDown: prefetch, onFocus: prefetch };
  };
  const row = (bot: Bot) => {
    const botState = activity(bot);
    const working = !connectionLost && botState !== "idle" && botState !== "done";
    return <li key={bot.id}>
      <BotMenu bot={bot} preferences={prefs} disabled={saved} onPin={() => onPin(bot)} onSettings={() => onBotSettings(bot)}
        onMove={sectionId => onMoveToSection(bot, sectionId)} onNewSection={() => onNewSection(bot)}>
        <Button className={`bot-item bot-row${current(bot) ? " selected" : ""}${unread(bot) ? " unread" : ""}`} aria-current={current(bot) ? "page" : undefined}
          {...intent(bot)} onClick={() => onSelectBot(bot.id)}>
          <span className="home-row-avatar" aria-hidden="true" data-morph={bot.id}><Avatar avatar={bot.avatar} state={botState === "done" || botState === "blocked" ? "idle" : botState} size={mobile ? 52 : 44} name={bot.name} reducedMotion /></span>
          <span className="bot-row-text">
            <span className="bot-row-top"><span className="bot-row-name"><strong>{bot.name}</strong></span>
              {(unread(bot) || bot.lastMessage?.at) && <span className="bot-row-meta">
                {unread(bot) && <UnreadMark />}{bot.lastMessage?.at && <ListDate value={bot.lastMessage.at} />}
              </span>}</span>
            <small className={working ? `bot-activity state-${botState}` : undefined}>
              {working ? stateLabels[botState] : bot.lastMessage?.text || (bot.shared ? "Shared assistant" : "Personal assistant")}
            </small>
          </span>
        </Button>
      </BotMenu>
    </li>;
  };
  // Group chats sit in the same list as the assistants outside any section, so the list is named for both.
  const chatsName = groups.rooms.length || groups.pending ? "chats" : "assistants";
  const roomRow = (room: GroupRoom) => {
    const open = view === "group" && groups.roomId === room.room_id;
    return <li key={room.room_id}>
      <Button className={`bot-item bot-row room-row${open ? " selected" : ""}`} aria-current={open ? "page" : undefined} onClick={() => groups.onSelect(room.room_id)}>
        <RoomFaces room={room} bots={boot.bots} cluster={mobile ? 52 : 44} />
        <span className="bot-row-text">
          <span className="bot-row-top"><span className="bot-row-name"><strong>{room.name}</strong></span>
            {!groups.saved && room.latest?.at && <span className="bot-row-meta"><ListDate value={room.latest.at} /></span>}</span>
          {groups.saved
            ? <small>Group chat with {memberNames(room)}</small>
            : <small><span className="sr-only">Group chat with {memberNames(room)}. </span>{roomPreview(room)}</small>}
        </span>
      </Button>
    </li>;
  };
  const finishRow = groups.pending && <li key="finish-group">
    <Button className="bot-item bot-row room-row room-pending" onClick={groups.onCreate}>
      <span className="home-row-avatar room-faces" aria-hidden="true" style={{ width: mobile ? 52 : 44, height: mobile ? 52 : 44 }}>
        <span className="room-face room-face-icon"><Icon name="groups" size={20} /></span></span>
      <span className="bot-row-text">
        <span className="bot-row-top"><span className="bot-row-name"><strong>Finish creating group</strong></span></span>
        <small>{groups.pending.name} · {groups.pending.botIds.length} assistants. The saved request will be checked with Hermes.</small>
      </span>
    </Button>
  </li>;
  const chatRows = rest.length > 0 || groups.rooms.length > 0 || !!finishRow;
  const status = saved || connectionLost ? offline ? "offline" : "reconnecting" : "connected";
  return (
    <aside id="assistant-navigation" className={`bot-rail home${open ? " open" : ""}`} aria-label="Assistants" inert={mobile && !open} data-season={season ?? undefined}>
      {season && <SeasonalAmbience season={season} />}
      <header className="home-bar">
        <AccountMenu user={boot.user} status={status} disabled={saved} onUsage={onUsage} onSettings={onSettings} onSignOut={onSignOut} />
        {/* Seen here; the app's one connection live region announces it. The saved home says it is not live
            yet, and says so plainly when the first bootstrap failed. */}
        {(saved || connectionLost) && <span className="home-sync">
          <Icon name="spinner" size={16} className={offline || saved && connectionLost ? undefined : "spin"} />
          {offline ? "Offline" : !saved ? "Reconnecting" : connectionLost ? "Can't connect" : "Connecting"}</span>}
        <span className="home-bar-actions">
          <Button className="home-round" aria-label="Search & saved" aria-pressed={view === "find"} disabled={saved} onClick={() => onView("find")}>
            <Icon name="search" />
          </Button>
          <NewMenu canGroup={groups.canCreate} groupHint={groups.hint} disabled={saved} onNewBot={onNewBot} onNewGroup={groups.onCreate} />
        </span>
      </header>
      {!saved && <UpdateNotice update={update} />}
      <div className="home-scroll">
        {main && (() => {
          const botState = activity(main);
          const working = !connectionLost && botState !== "idle" && botState !== "done";
          return <div className="home-main" role="group" aria-label="Main assistant">
            <BotMenu bot={main} preferences={prefs} disabled={saved} onPin={() => onPin(main)} onSettings={() => onBotSettings(main)}
              onMove={sectionId => onMoveToSection(main, sectionId)} onNewSection={() => onNewSection(main)}>
              <Button className={`bot-item main-bot${current(main) ? " selected" : ""}${unread(main) ? " unread" : ""}`} aria-current={current(main) ? "page" : undefined}
                {...intent(main)} onClick={() => onSelectBot(main.id)}>
                <span className="pinned-avatar" aria-hidden="true" data-morph={main.id} data-glance-target={main.id}>
                  <Avatar avatar={main.avatar} state={botState === "done" || botState === "blocked" ? "idle" : botState} size={mobile ? 64 : 52} name={main.name} botId={main.id} offline={offline} aware={!mobile} />
                </span>
                <span className="bot-row-text">
                  <span className="bot-row-top"><span className="bot-row-name"><strong>{main.name}</strong><span className="main-chip">Main</span></span>
                    {(unread(main) || main.lastMessage?.at) && <span className="bot-row-meta">
                      {unread(main) && <UnreadMark />}{main.lastMessage?.at && <ListDate value={main.lastMessage.at} />}
                    </span>}</span>
                  <small className={working ? `bot-activity state-${botState}` : undefined}>
                    {working ? offline ? "Offline" : stateLabels[botState] : main.lastMessage?.text || "Your main assistant"}
                  </small>
                </span>
              </Button>
            </BotMenu>
          </div>;
        })()}
        {suggestMain && <section className="home-main-suggestion" aria-label="Main assistant">
          <p><strong>Choose a main assistant:</strong> it checks in on what's coming up and hands work to your other assistants.</p>
          <span className="home-main-suggestion-actions">
            <Button className="primary" disabled={saved} onClick={onChooseMain}>Choose</Button>
            <Button disabled={saved} onClick={onDismissMainSuggestion}>Not now</Button>
          </span>
        </section>}
        {pinned.length > 0 && <ul className="home-pinned" aria-label="Pinned assistants">
          {pinned.map(bot => {
            const botState = activity(bot);
            const showActivity = botState !== "idle" && botState !== "done";
            return <li key={bot.id}>
              <BotMenu bot={bot} preferences={prefs} disabled={saved} onPin={() => onPin(bot)} onSettings={() => onBotSettings(bot)}
                onMove={sectionId => onMoveToSection(bot, sectionId)} onNewSection={() => onNewSection(bot)}>
                <Button className={`bot-item pinned-bot${current(bot) ? " selected" : ""}${unread(bot) ? " unread" : ""}`} aria-current={current(bot) ? "page" : undefined}
                  {...intent(bot)} onClick={() => onSelectBot(bot.id)}>
                  <span className="pinned-avatar" aria-hidden="true" data-morph={bot.id} data-glance-target={bot.id}>
                    {/* Pinned assistants are few and featured, so they stay alive and notice the pointer; the system Reduce Motion setting still applies. */}
                    <Avatar avatar={bot.avatar} state={botState === "done" || botState === "blocked" ? "idle" : botState} size={mobile ? 92 : 60} name={bot.name} botId={bot.id} offline={offline} aware={!mobile} />
                  </span>
                  <span className="pinned-copy">
                    <span className="pinned-name">{unread(bot) && <UnreadMark />}{bot.name}</span>
                    <small className={`pinned-activity${showActivity ? ` bot-activity state-${botState}` : ""}`}>
                      {showActivity ? offline ? "Offline" : stateLabels[botState] : null}
                    </small>
                  </span>
                </Button>
              </BotMenu>
            </li>;
          })}
        </ul>}
        <nav className="home-links" aria-label="Household">
          <Button aria-current={view === "today" ? "page" : undefined} onClick={() => onView("today")}>
            <Icon name="today" size={16} /> Today
          </Button>
        </nav>
        {sections.map(section => <section className="bot-section" key={section.id} aria-label={section.name}>
          <h2>{section.name}</h2>
          <ul className="home-list">{section.bots.map(row)}</ul>
        </section>)}
        {chatRows && <section className="bot-section" aria-label={sections.length || pinned.length ? `More ${chatsName}` : `Your ${chatsName}`}>
          {sections.length > 0 && <h2>More {chatsName}</h2>}
          <ul className="home-list">{finishRow}{rest.map(row)}{groups.rooms.map(roomRow)}</ul>
        </section>}
        {!saved && !boot.bots.length && <div className="home-empty">
          <h2>No assistants yet</h2>
          <p className="muted">Create one to help your household plan, remember and get things done.</p>
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

/**
 * A group's members as overlapping faces in the space one assistant's avatar takes, so rows line up.
 * Two faces sit on a diagonal, three in a triangle; a member this person cannot see shows an initial.
 */
function RoomFaces({ room, bots, cluster }: { room: GroupRoom; bots: Bot[]; cluster: number }) {
  const faces = roomFaces(room, bots);
  const size = Math.round(cluster * (faces.length === 2 ? 0.68 : 0.56));
  return <span className={`home-row-avatar room-faces faces-${faces.length}`} aria-hidden="true" style={{ width: cluster, height: cluster, "--face": `${size}px` } as CSSProperties}>
    {faces.map(({ member, bot }) => <span className="room-face" key={member.member_id}>
      {bot ? <Avatar avatar={bot.avatar} size={size} name={bot.name} reducedMotion /> : <span className="room-face-initial">{initials(member.display_name || member.profile)}</span>}
    </span>)}
  </span>;
}
