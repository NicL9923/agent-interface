import type { ActivityState, Bootstrap, Bot } from "../shared/types";
import type { GroupRoom } from "../shared/collaboration";
import { memberNames } from "./home-rooms";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { ModelChipFace, modelChipTitle } from "../components/ModelChip";
import { ChatModelPicker, Loading } from "./panels";
import type { View } from "./view";
const titles: Record<Exclude<View, "conversation" | "group">, [string, string]> = {
  find: ["Search & saved", "Past answers, saved items and automations"],
  today: ["Today", "Your assistants, at a glance"],
};
/** Who the assistant belongs to. The model is shown only in Advanced, as its own chip. */
export function botSummary(bot: Bot) {
  return bot.shared ? "Shared with your household" : bot.ownerId ? "Your personal assistant" : "Personal, visible to the household";
}
// Stands in for the picker while it loads, or when it cannot load.
function ModelChipPlaceholder({ bot, failed = false }: { bot: Bot; failed?: boolean }) {
  const description = failed ? "Model controls unavailable. Reload to try again." : "Loading model controls";
  return <div className="chat-model" role={failed ? "status" : undefined}>
    <button type="button" className="model-chip" disabled aria-label={description} title={failed ? description : modelChipTitle(bot)}><ModelChipFace bot={bot} /></button>
  </div>;
}
/**
 * Like a messaging app: a lone back button on phones, and the assistant itself as the
 * one control that opens its details, where pinning, artifacts and settings live.
 */
export function ChatHeader({ view, boot, selected, room, avatarState, offline = false, modelLocked = false, railOpen, onOpenRail, onDetails, onModelSaved }: {
  view: View;
  boot: Bootstrap;
  selected?: Bot;
  /** The open group chat, when the view is a group. It may not be listed yet. */
  room?: GroupRoom;
  avatarState: ActivityState;
  offline?: boolean;
  /** The model cannot change now: Hermes is out of reach, or a message is on its way. */
  modelLocked?: boolean;
  railOpen: boolean;
  onOpenRail(): void;
  onDetails(bot: Bot): void;
  onModelSaved(): void;
}) {
  // Simple presentation never shows a model.
  const model = boot.preferences.presentation === "advanced";
  const identity = view === "conversation" && selected;
  return (
    <header className={`chat-header${identity ? " chat-header-identity" : view === "today" ? " chat-header-today" : ""}`}>
      <button
        className="mobile-only icon-button chat-back"
        aria-label="Back to assistants"
        aria-expanded={railOpen}
        aria-controls="assistant-navigation"
        onClick={onOpenRail}
      >
        <Icon name="back" />
      </button>
      {view === "group" ? <div className="chat-title"><h1>{room?.name ?? "Group chat"}</h1><p>{room ? memberNames(room) : "Two to six assistants in one conversation"}</p></div>
        : view !== "conversation" ? <div className="chat-title"><h1>{titles[view][0]}</h1><p>{titles[view][1]}</p></div> : selected ? (
        /* Avatar, name and model chip each own a grid cell, so no control's box covers another's. */
        <div className={`chat-identity-wrap${model ? " with-model" : ""}`}>
          {/* A larger place to click for pointers; the name button is the one control for keyboards and screen readers. */}
          <span className="chat-identity-avatar" aria-hidden="true" onClick={() => onDetails(selected)}>
            <Avatar avatar={selected.avatar} state={avatarState === "blocked" ? "idle" : avatarState} size={42} offline={offline} name={selected.name} botId={selected.id} />
          </span>
          <h1 className="chat-identity-heading">
            <button className="chat-identity" aria-haspopup="dialog" aria-label={selected.name}
              title="Details, pin, artifacts and settings" onClick={() => onDetails(selected)}>
              <span className="chat-title">
                {/* The chevron follows the name, so it never floats between the name and a wider model chip. */}
                <span className="chat-name-line"><span className="chat-name">{selected.name}</span><Icon name="chevron" size={16} className="chat-identity-chevron" /></span>
                {!model && <span className="chat-summary">{botSummary(selected)}</span>}
              </span>
            </button>
          </h1>
          {model && <div className="chat-model-slot">
            <Loading loadingFallback={<ModelChipPlaceholder bot={selected} />} errorFallback={<ModelChipPlaceholder bot={selected} failed />}>
              <ChatModelPicker bot={selected} bootstrap={boot} disabled={modelLocked} onSaved={onModelSaved} />
            </Loading>
          </div>}
        </div>
      ) : (
        <div className="chat-title">
          <h1>Welcome home</h1>
          <p>Your assistants will appear here when Hermes is connected.</p>
        </div>
      )}
    </header>
  );
}
