import { useEffect, useRef } from "react";
import type { ActivityState, Bootstrap, Bot } from "../shared/types";
import { Avatar, stateLabels } from "../components/Avatar";
import { Icon } from "../components/Icon";
import type { View } from "./view";
export function Sidebar({ boot, botId, view, state, connectionLost, offline, mobile, open, onClose, onSelectBot, onView, onNewBot, onComputer, onPreferences, onIntegrations, onUpgrade }: {
  boot: Bootstrap;
  botId: string;
  view: View;
  state: ActivityState;
  connectionLost: boolean;
  offline: boolean;
  mobile: boolean;
  open: boolean;
  onClose(): void;
  onSelectBot(id: string): void;
  onView(view: View): void;
  onNewBot(): void;
  onComputer(): void;
  onPreferences(): void;
  onIntegrations(): void;
  onUpgrade(): void;
}) {
  const rail = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!mobile || !open || !rail.current) return;
    const drawer = rail.current;
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => Array.from(drawer.querySelectorAll<HTMLElement>(
      "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex='0']",
    )).filter((element) => element.getClientRects().length > 0);
    controls()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        const items = controls();
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    drawer.addEventListener("keydown", keydown);
    return () => {
      drawer.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [mobile, open]);
  const prefs = boot.preferences;
  const allBots = boot.bots;
  const ordered = [...allBots].sort(
    (a, b) =>
      Number(prefs.favorites.includes(b.id)) -
      Number(prefs.favorites.includes(a.id)),
  );
  const renderBot = (bot: Bot) => {
    const botState = connectionLost
      ? "disconnected"
      : bot.id === botId
        ? state
        : bot.activity;
    // The rail says what each assistant is doing in words, not only through motion.
    const reportsActivity = !connectionLost && botState !== "idle" && botState !== "done";
    return (
      <button
        className={`bot-item ${bot.id === botId && view === "conversation" ? "selected" : ""}`}
        key={bot.id}
        aria-current={bot.id === botId && view === "conversation" ? "page" : undefined}
        onClick={() => onSelectBot(bot.id)}
      >
        <Avatar avatar={bot.avatar} state={botState === "done" ? "idle" : botState} size={40} name={bot.name} />
        <span>
          <strong>{bot.name}</strong>
          <small className={reportsActivity ? `bot-activity state-${botState}` : undefined}>
            {reportsActivity
              ? stateLabels[botState]
              : bot.shared
                ? "Shared assistant"
                : "Personal assistant"}
          </small>
        </span>
        {prefs.favorites.includes(bot.id) && (
          <span className="favorite-star" role="img" aria-label="Favorite">
            <Icon name="star" size={15} filled />
          </span>
        )}
      </button>
    );
  };
  return (
    <>
      <aside
        ref={rail}
        id="assistant-navigation"
        className={`bot-rail ${open ? "open" : ""}`}
        aria-label="Assistants"
        role={mobile ? "dialog" : undefined}
        aria-modal={mobile && open ? true : undefined}
        inert={mobile && !open}
      >
        <div className="rail-brand">
          <span className="brand-mark" aria-hidden="true">a.</span>
          <strong>Agent Interface</strong>
          <button
            className="mobile-only icon-button"
            aria-label="Close assistants"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="household-label">
          <span className="online-dot" />
          {boot.user.name}'s home
        </div>
        <nav className="rail-nav" aria-label="Household">
          {([
            ["today", "Today"],
            ["groups", "Group chats"],
            ["find", "Search & saved"],
          ] as const).map(([item, label]) => (
            <button key={item} type="button" aria-current={view === item ? "page" : undefined}
              onClick={() => onView(item)}>
              <Icon name={item === "find" ? "search" : item} size={18} /> {label}
            </button>
          ))}
        </nav>
        <div className="rail-scroll">
          {prefs.sections.map((section) => (
            <section className="bot-section" key={section.id}>
              <h2>{section.name}</h2>
              {ordered
                .filter((bot) => section.botIds.includes(bot.id))
                .map(renderBot)}
            </section>
          ))}
          <section className="bot-section">
            <h2>
              {prefs.sections.length ? "More assistants" : "Your assistants"}
            </h2>
            {ordered
              .filter(
                (bot) =>
                  !prefs.sections.some((section) =>
                    section.botIds.includes(bot.id),
                  ),
              )
              .map(renderBot)}
            {!allBots.length && (
              <p className="muted rail-empty">
                No assistants are available from Hermes yet.
              </p>
            )}
          </section>
        </div>
        <button className="new-bot" onClick={onNewBot}>
          <Icon name="plus" size={18} /> New assistant
        </button>
        <div className="rail-footer">
          <button onClick={onComputer}>
            <Icon name="computer" size={18} /> Computer
          </button>
          <button onClick={onPreferences}>
            <Icon name="sliders" size={18} /> Preferences
          </button>
          <button onClick={onIntegrations}><Icon name="plug" size={18} /> Integrations</button>
          <button className={`connection connection-button ${connectionLost ? "attention" : ""}`}
            aria-label="Hermes connection and updates" onClick={onUpgrade}>
            <span className="connection-dot" aria-hidden="true" />
            {connectionLost ? offline ? "Offline" : "Reconnecting" : "Connected to Hermes"}
            <Icon name="chevron" size={16} className="connection-chevron" />
          </button>
        </div>
      </aside>
      {open && (
        <button
          className="rail-scrim"
          aria-label="Close assistants"
          onClick={onClose}
        />
      )}
    </>
  );
}
