import { REACTIONS, reactionOf } from "../shared/reactions";
import { Icon } from "../components/Icon";
import { useMenu } from "./use-menu";
import "./reactions.css";

/**
 * Reaction answers on the web. The rule for which messages are reactions is in src/shared/reactions.ts;
 * this file draws the React menu on the latest reply and the chips a reply shows for its reactions.
 */

/** One reaction drawn on the reply it answers. */
export type ReactionChip = {
  /** The reaction message's ID, or its request ID while it is on its way. */
  id: string;
  /** The message's text; the chip draws the offered emoji it matches. */
  text: string;
  /** Another member's name. Absent for the person's own reaction. */
  who?: string;
  /** The send is still on its way. */
  sending: boolean;
};

/** "You reacted thumbs up", "Jordan reacted heart". */
export const reactionName = (chip: Pick<ReactionChip, "text" | "who">) =>
  `${chip.who ?? "You"} reacted ${(reactionOf(chip.text)?.name ?? chip.text).toLowerCase()}`;

/** The React button in the latest reply's action row, and its row of five reactions. */
export function ReactionPicker({ onReact }: { onReact: (emoji: string) => void }) {
  const { open, setOpen, wrap, trigger, menuId, keys, choose } = useMenu({ horizontal: true });
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

/**
 * The reactions under a reply, above its meta row. They are not controls: a reaction is a sent message,
 * so it cannot be taken back. Each reads as one phrase to assistive tech, with the emoji hidden from it.
 */
export function ReactionChips({ chips }: { chips: ReactionChip[] }) {
  if (!chips.length) return null;
  return (
    <ul className="reaction-chips" aria-label="Reactions">
      {chips.map((chip) => (
        <li
          key={chip.id}
          className={`reaction-chip${chip.sending ? " reaction-sending" : ""}`}
          data-reaction-id={chip.id}
          aria-busy={chip.sending || undefined}
        >
          <span className="reaction-emoji" aria-hidden="true">
            {reactionOf(chip.text)?.emoji ?? chip.text}
          </span>
          {chip.who && (
            <span className="reaction-who" aria-hidden="true">
              {chip.who}
            </span>
          )}
          <span className="sr-only">
            {reactionName(chip)}
            {chip.sending ? ", sending" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}
