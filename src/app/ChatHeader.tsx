import type { ActivityState, Bootstrap, Bot } from "../shared/types";
import { Avatar } from "../components/Avatar";
import { ArtifactsButton } from "../components/Artifacts";
import { Icon } from "../components/Icon";
import type { SavedConversation } from "./storage";
import type { View } from "./view";
const titles: Record<Exclude<View, "conversation">, [string, string]> = {
  find: ["Search & saved", "Past answers, saved items and automations"],
  groups: ["Group chats", "Two to six assistants in one conversation"],
  today: ["Today", "Your assistants, at a glance"],
};
export function ChatHeader({ boot, view, selected, avatarState, conversation, connectionLost, railOpen, onOpenRail, onSettings, onPin }: {
  boot: Bootstrap;
  view: View;
  selected?: Bot;
  avatarState: ActivityState;
  conversation: SavedConversation | null;
  connectionLost: boolean;
  railOpen: boolean;
  onOpenRail(): void;
  onSettings(bot: Bot): void;
  onPin(bot: Bot): void;
}) {
  const pinned = !!selected && boot.preferences.favorites.includes(selected.id);
  return (
    <header className="chat-header">
      <button
        className="mobile-only icon-button"
        aria-label="Back to assistants"
        aria-expanded={railOpen}
        aria-controls="assistant-navigation"
        onClick={onOpenRail}
      >
        <Icon name="back" />
      </button>
      {view !== "conversation" ? <div className="chat-title"><h1>{titles[view][0]}</h1><p>{titles[view][1]}</p></div> : selected ? (
        <>
          <Avatar
            avatar={selected.avatar}
            state={avatarState}
            size={42}
            name={selected.name}
            reducedMotion
          />
          <div className="chat-title">
            <h1>{selected.name}</h1>
            <p>{`${selected.shared ? "Shared with your household" : "Your personal assistant"} · ${selected.provider ? selected.provider + " / " : ""}${selected.model}`}</p>
          </div>
          <ArtifactsButton key={`${boot.user.id}:${selected.id}`} bot={selected} conversation={conversation} unavailable={connectionLost} />
          <button
            className="icon-button"
            aria-label="Edit assistant"
            title="Assistant settings"
            onClick={() => onSettings(selected)}
          >
            <Icon name="gear" />
          </button>
          <button
            className={`icon-button favorite-toggle ${pinned ? "on" : ""}`}
            aria-label={pinned ? "Unpin assistant" : "Pin assistant"}
            aria-pressed={pinned}
            title={pinned ? "Unpin from the top of home" : "Pin to the top of home"}
            onClick={() => onPin(selected)}
          >
            <Icon name="pin" filled={pinned} />
          </button>
        </>
      ) : (
        <div className="chat-title">
          <h1>Welcome home</h1>
          <p>Your assistants will appear here when Hermes is connected.</p>
        </div>
      )}
    </header>
  );
}
