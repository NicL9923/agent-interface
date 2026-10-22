import type { ActivityState, Bot } from "../shared/types";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import type { View } from "./view";
const titles: Record<Exclude<View, "conversation">, [string, string]> = {
  find: ["Search & saved", "Past answers, saved items and automations"],
  groups: ["Group chats", "Two to six assistants in one conversation"],
  today: ["Today", "Your assistants, at a glance"],
};
export function botSummary(bot: Bot) {
  const sharing = bot.shared ? "Shared with your household" : bot.ownerId ? "Your personal assistant" : "Personal, visible to the household";
  return `${sharing} · ${bot.provider ? `${bot.provider} / ` : ""}${bot.model}`;
}
/**
 * Like a messaging app: a lone back button on phones, and the assistant itself as the
 * one control that opens its details, where pinning, artifacts and settings live.
 */
export function ChatHeader({ view, selected, avatarState, railOpen, onOpenRail, onDetails }: {
  view: View;
  selected?: Bot;
  avatarState: ActivityState;
  railOpen: boolean;
  onOpenRail(): void;
  onDetails(bot: Bot): void;
}) {
  const identity = view === "conversation" && selected;
  return (
    <header className={`chat-header${identity ? " chat-header-identity" : ""}`}>
      <button
        className="mobile-only icon-button chat-back"
        aria-label="Back to assistants"
        aria-expanded={railOpen}
        aria-controls="assistant-navigation"
        onClick={onOpenRail}
      >
        <Icon name="back" />
      </button>
      {view !== "conversation" ? <div className="chat-title"><h1>{titles[view][0]}</h1><p>{titles[view][1]}</p></div> : selected ? (
        <h1 className="chat-identity-heading">
          <button className="chat-identity" aria-haspopup="dialog" aria-label={selected.name}
            title="Details, pin, artifacts and settings" onClick={() => onDetails(selected)}>
            <Avatar avatar={selected.avatar} state={avatarState} size={42} name={selected.name} />
            <span className="chat-title">
              <span className="chat-name">{selected.name}</span>
              <span className="chat-summary">{botSummary(selected)}</span>
            </span>
            <Icon name="chevron" size={16} className="chat-identity-chevron" />
          </button>
        </h1>
      ) : (
        <div className="chat-title">
          <h1>Welcome home</h1>
          <p>Your assistants will appear here when Hermes is connected.</p>
        </div>
      )}
    </header>
  );
}
