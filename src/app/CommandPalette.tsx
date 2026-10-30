import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ActivityState, Bootstrap, Bot, Preferences } from "../shared/types";
import { Avatar, stateLabels } from "../components/Avatar";
import { Icon, type IconName } from "../components/Icon";
import { Dialog } from "../components/ui/dialog";
import { rankItems, step, type PaletteItem } from "./palette";
import { formatCombo, shortcuts } from "./shortcuts";
import { isUnread, type ReadThrough } from "./unread";
import type { View } from "./view";
import "./shell.css";

type Command = PaletteItem & { icon: ReactNode; detail?: string; hint?: string; checked?: boolean; run(): void };

/** Pinned assistants first, in pin order, then everyone else as Hermes lists them. */
export function paletteBots(boot: Bootstrap) {
  const pinned = boot.preferences.favorites.map(id => boot.bots.find(bot => bot.id === id)).filter((bot): bot is Bot => !!bot);
  return [...pinned, ...boot.bots.filter(bot => !pinned.includes(bot))];
}

const themes: [Preferences["theme"], string][] = [["light", "Light"], ["dark", "Dark"], ["system", "Follow device"]];

export function CommandPalette({ boot, botId, shownBotId, readThrough, connectionLost, onClose, onSelectBot, onView, onSearch, onSettings, onNewBot, onTheme, onShortcuts, onFind }: {
  boot: Bootstrap;
  botId: string;
  shownBotId?: string;
  readThrough: ReadThrough;
  connectionLost: boolean;
  onClose(): void;
  onSelectBot(id: string): void;
  onView(view: View): void;
  onSearch(query: string): void;
  onSettings(destination?: { kind: "following" } | { kind: "section"; id: string } | { kind: "signout" }): void;
  onNewBot(): void;
  onTheme(theme: Preferences["theme"]): void;
  onShortcuts(): void;
  /** Find in the open chat, when one is open. */
  onFind?(): void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pins = boot.preferences.favorites;
  const commands = useMemo<Command[]>(() => {
    const icon = (name: IconName) => <span className="palette-icon"><Icon name={name} size={18} /></span>;
    const bots = paletteBots(boot).map((bot): Command => {
      const activity: ActivityState = connectionLost ? "disconnected" : bot.activity;
      const working = !connectionLost && activity !== "idle" && activity !== "done";
      const unread = isUnread(bot, shownBotId, readThrough);
      const pin = pins.indexOf(bot.id);
      return {
        id: `bot:${bot.id}`, group: "Assistants", label: bot.name, keywords: bot.description ? [bot.description] : undefined,
        icon: <span className="palette-avatar"><Avatar avatar={bot.avatar} state={activity === "done" ? "idle" : activity} size={30} name={bot.name} reducedMotion />
          {unread && <span className="unread-mark" />}</span>,
        detail: working ? stateLabels[activity] : unread ? "Unread" : bot.id === botId ? "Open now" : undefined,
        hint: pin >= 0 && pin < 9 ? formatCombo({ ...shortcuts.pinned, key: String(pin + 1) }) : undefined,
        run: () => onSelectBot(bot.id),
      };
    });
    return [
      ...bots,
      { id: "view:today", group: "Go to", label: "Today", keywords: ["home", "schedule"], icon: icon("today"), run: () => onView("today") },
      { id: "view:groups", group: "Go to", label: "Group chats", keywords: ["rooms", "discussion"], icon: icon("groups"), run: () => onView("groups") },
      { id: "view:find", group: "Go to", label: "Search & saved", keywords: ["find", "saved items", "automations"], icon: icon("search"), run: () => onView("find") },
      ...onFind ? [{ id: "action:find", group: "Actions", label: "Find in chat", keywords: ["search this chat"], icon: icon("search"), hint: formatCombo(shortcuts.find), run: onFind }] : [],
      { id: "action:new", group: "Actions", label: "New assistant", keywords: ["create", "add"], icon: icon("plus"), run: onNewBot },
      { id: "action:settings", group: "Actions", label: "Settings", keywords: ["preferences", "account", "notifications"], icon: icon("gear"), run: onSettings },
      { id: "settings:following", group: "Settings", label: "Following", icon: icon("gear"), run: () => onSettings({ kind: "following" }) },
      ...boot.preferences.sections.map(section => ({ id: `settings:section:${section.id}`, group: "Settings", label: `Home section: ${section.name}`, icon: icon("gear"), run: () => onSettings({ kind: "section", id: section.id }) })),
      { id: "settings:signout", group: "Settings", label: "Sign out", icon: icon("gear"), run: () => onSettings({ kind: "signout" }) },
      { id: "action:shortcuts", group: "Actions", label: "Keyboard shortcuts", keywords: ["keys", "help"], icon: icon("keyboard"), hint: formatCombo(shortcuts.help), run: onShortcuts },
      ...themes.map(([theme, name]): Command => ({
        id: `theme:${theme}`, group: "Appearance", label: `Appearance: ${name}`, keywords: [name, "theme", `${name} mode`],
        icon: icon(theme === "dark" ? "sparkle" : theme === "light" ? "sun" : "computer"),
        checked: (boot.preferences.theme || "system") === theme, run: () => onTheme(theme),
      })),
      { id: "search", group: "Search", label: "", trailing: true, icon: icon("search"), run: () => onSearch(query.trim()) },
    ];
  }, [boot, botId, shownBotId, readThrough, connectionLost, pins, query, onSelectBot, onView, onNewBot, onSettings, onShortcuts, onTheme, onSearch, onFind]);
  const searching = !!query.trim();
  const results = useMemo(() => rankItems(query, commands), [query, commands]);
  useEffect(() => setActive(0), [query]);
  const current = results[Math.min(active, results.length - 1)];
  const optionId = (command: Command) => `${listId}-${command.id.replace(/[^\w-]/g, "_")}`;
  useEffect(() => {
    if (current) document.getElementById(optionId(current))?.scrollIntoView?.({ block: "nearest" });
  }, [current?.id]);
  const choose = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };
  const option = (command: Command, index: number) => {
    const label = command.trailing ? `Search messages for "${query.trim()}"` : command.label;
    return <div key={command.id} id={optionId(command)} role="option" aria-selected={index === active}
      className={`palette-option${index === active ? " active" : ""}`}
      onPointerMove={() => { if (index !== active) setActive(index); }}
      onPointerDown={event => event.preventDefault()}
      onClick={() => choose(command)}>
      {command.icon}
      <span className="palette-copy"><span className="palette-label">{label}</span>
        {command.detail && <small>{command.detail}</small>}</span>
      {searching && !command.trailing && <small className="palette-group">{command.group}</small>}
      {command.checked && <Icon name="check" size={16} className="palette-check" />}
      {command.checked && <span className="sr-only">, current</span>}
      {command.hint && <kbd aria-hidden="true">{command.hint}</kbd>}
    </div>;
  };
  // Unfiltered, the list keeps its groups; filtered, it is one ranked list naming each group.
  let index = 0;
  const groups = searching ? null : results.reduce<{ name: string; items: Command[] }[]>((all, command) => {
    const last = all.at(-1);
    if (last?.name === command.group) last.items.push(command); else all.push({ name: command.group, items: [command] });
    return all;
  }, []);
  return <Dialog className="command-palette" aria-label="Command palette" initialFocus={() => input.current}
    onCancel={onClose} onClose={onClose}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="palette-search">
      <Icon name="search" size={18} />
      <input ref={input} role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={current ? optionId(current) : undefined} aria-label="Search assistants and actions"
        placeholder="Search assistants and actions" value={query} maxLength={200} autoComplete="off" spellCheck={false}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive(value => step(value, event.key === "ArrowDown" ? 1 : -1, results.length));
          } else if (event.key === "Home" && event.ctrlKey || event.key === "PageUp") { event.preventDefault(); setActive(0); }
          else if (event.key === "End" && event.ctrlKey || event.key === "PageDown") { event.preventDefault(); setActive(results.length - 1); }
          else if (event.key === "Enter") { event.preventDefault(); choose(current); }
          // The same shortcut that opened the palette closes it.
          else if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onClose(); }
        }} />
      <kbd className="palette-escape" aria-hidden="true">Esc</kbd>
    </div>
    <div ref={list} id={listId} role="listbox" aria-label="Results" className="palette-list">
      {groups ? groups.map(group => <div key={group.name} role="group" aria-label={group.name}>
        <div className="palette-heading" aria-hidden="true">{group.name}</div>
        {group.items.map(command => option(command, index++))}
      </div>) : results.map((command, position) => option(command, position))}
    </div>
    <p className="sr-only" role="status">{searching ? `${results.length - 1 > 0 ? results.length - 1 : "No"} ${results.length - 1 === 1 ? "match" : "matches"}` : ""}</p>
    <footer className="palette-footer" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></footer>
  </Dialog>;
}
