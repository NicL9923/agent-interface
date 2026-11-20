import { useLayoutEffect } from "react";
import { REACTIONS, reactionOf } from "../shared/reactions";
import { Icon } from "../components/Icon";
import { useMenu } from "./use-menu";
import "./reactions.css";

/**
 * Reaction answers on the web: the React menu on the reply that ends the chat. A sent reaction is an
 * ordinary message and draws an ordinary row. The rule is in src/shared/reactions.ts.
 */

/** "You reacted thumbs up", for the status region after a send. */
export const reactionName = (emoji: string) =>
  `You reacted ${(reactionOf(emoji)?.name ?? emoji).toLowerCase()}`;

/**
 * The React button in a reply's action row, and its row of five reactions. A send or an update can take
 * the button away while it or its menu has focus; focus then moves to `onGone`'s target, never to the page.
 */
export function ReactionPicker({
  onReact,
  onGone,
}: {
  onReact: (emoji: string) => void;
  onGone?: () => void;
}) {
  const { open, setOpen, wrap, trigger, menuId, keys, choose } = useMenu({ horizontal: true });
  useLayoutEffect(() => {
    const holder = wrap.current;
    // Layout cleanups run while the removed nodes are still in the document, so focus inside them is seen.
    return () => {
      if (!holder?.contains(document.activeElement)) return;
      requestAnimationFrame(() => {
        const focused = document.activeElement;
        if (!focused || focused === document.body || !focused.isConnected) onGone?.();
      });
    };
  }, [wrap, onGone]);
  return (
    <span className="reaction-picker" ref={wrap} onKeyDown={keys}>
      <button
        ref={trigger}
        type="button"
        className="reply-action"
        aria-label="React"
        title="React"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="react" size={16} />
      </button>
      {open && (
        <div
          className="reaction-menu"
          id={menuId}
          role="menu"
          aria-label="React"
          aria-orientation="horizontal"
        >
          {REACTIONS.map((reaction) => (
            <button
              key={reaction.emoji}
              type="button"
              role="menuitem"
              aria-label={reaction.name}
              title={reaction.name}
              onClick={() => choose(() => onReact(reaction.emoji))}
            >
              <span aria-hidden="true">{reaction.emoji}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
