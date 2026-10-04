import type { ActivityState, Bootstrap, Bot, Preferences } from "../shared/types";
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
export function ChatHeader({ boot, view, selected, avatarState, conversation, connectionLost, railOpen, onOpenRail, onSettings, savePreferences }: {
  boot: Bootstrap;
  view: View;
  selected?: Bot;
  avatarState: ActivityState;
  conversation: SavedConversation | null;
  connectionLost: boolean;
  railOpen: boolean;
  onOpenRail(): void;
  onSettings(bot: Bot): void;
  savePreferences(value: Preferences): Promise<void>;
}) {
  const prefs = boot.preferences;
  return (
    <header className="chat-header">
      <button
        className="mobile-only icon-button"
        aria-label="Open assistants"
        aria-expanded={railOpen}
        aria-controls="assistant-navigation"
        onClick={onOpenRail}
      >
        <Icon name="menu" />
      </button>
      {view !== "conversation" ? <div className="chat-title"><h1>{titles[view][0]}</h1><p>{titles[view][1]}</p></div> : selected ? (
        <>
          <Avatar
            avatar={selected.avatar}
            state={avatarState}
            size={42}
            name={selected.name}
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
            className={`icon-button favorite-toggle ${prefs.favorites.includes(selected.id) ? "on" : ""}`}
            aria-label={
              prefs.favorites.includes(selected.id)
                ? "Remove favorite"
                : "Favorite assistant"
            }
            aria-pressed={prefs.favorites.includes(selected.id)}
            title={prefs.favorites.includes(selected.id) ? "Remove favorite" : "Favorite"}
            onClick={() =>
              void savePreferences({
                ...prefs,
                favorites: prefs.favorites.includes(selected.id)
                  ? prefs.favorites.filter((id) => id !== selected.id)
                  : [...prefs.favorites, selected.id],
              })
            }
          >
            <Icon name="star" filled={prefs.favorites.includes(selected.id)} />
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
