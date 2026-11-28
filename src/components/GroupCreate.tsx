import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { request } from "../client-api";
import { useAction } from "../app/use-action";
import { groupCreateKey } from "../app/storage";
import { pendingGroup, type PendingGroup } from "../app/home-rooms";
import { stayAlso, useCloseRequest, type SheetClose } from "../app/close-request";
import { Dialog } from "./ui/dialog";
import { FormMessage } from "./ui/form-message";
import type { Bootstrap } from "../shared/types";
import type { GroupRoom } from "../shared/collaboration";
import { Avatar } from "./Avatar";
import { Button } from "./ui/button";
import { Icon } from "./Icon";
import "./collaboration.css";

/**
 * Starts a group chat from home's New menu. The request is saved before it is sent and kept
 * until Hermes answers, so a retry after a lost connection checks the same room instead of
 * making a second one. Home offers a saved request as "Finish creating group".
 * A name or choice not yet sent is unsaved work: Escape, the close button and the app's own close (the
 * browser's Back) ask before discarding it, as an edited sheet does. Cancel says so itself and does not ask.
 */
export function GroupCreate({
  bootstrap,
  canSend,
  closer,
  onClose,
  onCreated,
}: {
  bootstrap: Bootstrap;
  canSend: boolean;
  closer?: RefObject<SheetClose | null>;
  onClose: () => void;
  onCreated: (room: GroupRoom) => void;
}) {
  const createKey = groupCreateKey(bootstrap.user.id);
  const action = useAction();
  const { busy, error } = action;
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [saved, setSaved] = useState<PendingGroup | null>(() => pendingGroup(bootstrap.user.id));
  const titleId = useId();
  const writable = canSend && bootstrap.connection.connected;
  // A saved request is already kept, so only a form being filled in holds something to lose.
  const unsaved = !saved && (name.trim() !== "" || members.length > 0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const requestClose = () => (unsaved ? setConfirmDiscard(true) : onClose());
  // Whatever asked for the close, such as Back, does not go ahead if the person keeps editing.
  const stay = useRef<(() => void) | null>(null);
  useCloseRequest(closer, (onStay) => {
    if (!unsaved) return onClose();
    stay.current = stayAlso(stay.current, onStay);
    setConfirmDiscard(true);
  });
  useEffect(() => {
    if (confirmDiscard) {
      keepEditing.current?.focus();
      return;
    }
    const kept = stay.current;
    stay.current = null;
    kept?.();
  }, [confirmDiscard]);
  useEffect(() => {
    if (!unsaved) setConfirmDiscard(false);
  }, [unsaved]);
  const create = () => {
    const input = saved || { requestId: crypto.randomUUID(), name: name.trim(), botIds: members };
    return action.run(
      async () => {
        localStorage.setItem(createKey, JSON.stringify(input));
        setSaved(input);
        const value = await request("POST /groups", { body: input });
        localStorage.removeItem(createKey);
        setSaved(null);
        onCreated(value.room);
      },
      {
        onError: (cause) =>
          `${(cause as Error).message} Retry the saved request to check this room's creation.`,
      },
    );
  };
  const choices = bootstrap.bots.filter(
    (bot) => !["all", "everyone"].includes(bot.id.toLowerCase()),
  );
  return (
    <Dialog
      ref={dialog}
      className="settings-sheet group-create-sheet"
      aria-labelledby={titleId}
      initialFocus="input, button.primary"
      onCancel={(event) => {
        if (!unsaved) return onClose();
        event.preventDefault();
        setConfirmDiscard(true);
      }}
      onClose={() => {
        // Closing and reopening in one pass, as Strict Mode does, queues an event for a dialog that is open.
        if (dialog.current?.open) return;
        if (!unsaved) return onClose();
        // A second Escape can close the dialog without a cancelable event, so put it back.
        dialog.current?.showModal();
        setConfirmDiscard(true);
      }}
    >
      <header className="sheet-header">
        <Button className="sheet-close" aria-label="Close" onClick={requestClose}>
          <Icon name="close" />
        </Button>
        <h2 id={titleId}>{saved ? "Finish creating group" : "New group chat"}</h2>
      </header>
      <form
        className="sheet-body group-create"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        {error && <FormMessage tone="error">{error}</FormMessage>}
        {confirmDiscard && (
          <div className="capability-note" role="alert">
            <p>Discard your unsaved changes?</p>
            <div className="actions">
              <Button type="button" className="danger" onClick={onClose}>
                Discard changes
              </Button>
              <Button type="button" ref={keepEditing} onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </Button>
            </div>
          </div>
        )}
        {!canSend && (
          <p className="capability-note">
            Group chats are unavailable right now. Try again once WildBots is connected.
          </p>
        )}
        {saved ? (
          <p>
            {saved.name} · {saved.botIds.length} assistants. The saved request will be checked with
            WildBots.
          </p>
        ) : (
          <>
            <label>
              Name
              <input
                value={name}
                maxLength={100}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <fieldset>
              <legend>
                Choose 2–6 assistants <span role="status">· {members.length} chosen</span>
              </legend>
              {choices.map((bot) => (
                <label key={bot.id}>
                  <input
                    type="checkbox"
                    checked={members.includes(bot.id)}
                    disabled={busy || (members.length === 6 && !members.includes(bot.id))}
                    onChange={(event) =>
                      setMembers((current) =>
                        event.target.checked
                          ? [...current, bot.id]
                          : current.filter((id) => id !== bot.id),
                      )
                    }
                  />
                  <span aria-hidden="true">
                    <Avatar
                      avatar={bot.avatar}
                      name={bot.name}
                      botId={bot.id}
                      size={24}
                      reducedMotion
                    />
                  </span>
                  {bot.name}
                </label>
              ))}
            </fieldset>
            {members.length === 6 && (
              <p className="muted" role="status">
                Six assistants selected. Deselect one to choose another.
              </p>
            )}
            {members.some((id) =>
              bootstrap.bots.some((bot) => bot.id === id && !bot.shared && bot.ownerId),
            ) && (
              <p className="muted">
                Only you will see this group, because it includes your personal assistant.
              </p>
            )}
          </>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            {saved ? "Not now" : "Cancel"}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !writable || (!saved && (members.length < 2 || !name.trim()))}
          >
            {saved ? "Retry saved group request" : "Create group"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
