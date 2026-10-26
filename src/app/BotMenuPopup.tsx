import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuRadioGroup, ContextMenuRadioItem, ContextMenuSeparator, ContextMenuSubmenu, ContextMenuSubmenuContent, ContextMenuSubmenuTrigger, ContextMenuTrigger } from "../components/ui/context-menu";
import { Icon } from "../components/Icon";
import type { Bot, Preferences } from "../shared/types";
import { sectionOf } from "./preferences-editing";

export type BotMenuProps = {
  bot: Bot; preferences: Preferences; onPin(): void; onSettings(): void; onMove(sectionId: string | null): void; onNewSection(): void; children: ReactElement;
  /** Where the gesture that loaded this menu happened; the menu opens there as soon as it mounts. */
  opensAt?: { x: number; y: number };
  /** The row had focus when it was swapped for this one, so focus returns to it. */
  restoreFocus?: boolean;
};

/**
 * The assistant's context menu. It pulls in the popup library, so Sidebar loads it on first use
 * through BotMenu instead of importing it.
 */
export function BotMenuPopup({ bot, preferences, onPin, onSettings, onMove, onNewSection, children, opensAt, restoreFocus }: BotMenuProps) {
  const pinned = preferences.favorites.includes(bot.id);
  const current = sectionOf(preferences, bot.id)?.id ?? "";
  const trigger = useRef<HTMLDivElement>(null);
  const [keyboardAnchor, setKeyboardAnchor] = useState(false);
  const suppressTouchClick = useRef(false);
  const replayed = useRef(false);
  useEffect(() => { if (restoreFocus) trigger.current?.focus(); }, []);
  useEffect(() => {
    if (!opensAt || replayed.current) return;
    replayed.current = true;
    // Replays the gesture the lightweight trigger swallowed; no coordinates means the keyboard.
    trigger.current?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: opensAt.x, clientY: opensAt.y }));
  }, [opensAt]);
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
