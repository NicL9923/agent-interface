import { useId } from "react";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import "./shell.css";

/** Asks before Cmd+. stops an assistant's work, as the native app does. */
export function StopConfirm({
  name,
  renewed = false,
  unavailable,
  onStop,
  onClose,
}: {
  name: string;
  renewed?: boolean;
  /** Why stopping is refused now, as when the connection was lost while the question was open. Shown in the question. */
  unavailable?: string;
  onStop: () => void;
  onClose: () => void;
}) {
  const titleId = useId(),
    detailId = useId(),
    reasonId = useId();
  return (
    <Dialog
      className="confirm-dialog"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={unavailable ? `${detailId} ${reasonId}` : detailId}
      initialFocus="[data-confirm-default]"
      onCancel={onClose}
      onClose={onClose}
    >
      <h2 id={titleId}>Stop {name}'s work?</h2>
      <p id={detailId}>
        {renewed ? "A new task started while you were deciding. " : ""}Anything already done stays
        done. You can send new guidance afterwards.
      </p>
      {/* A disabled button leaves the tab order, so its reason is said here and not on the button. */}
      {unavailable && (
        <p id={reasonId} role="status">
          {unavailable}
        </p>
      )}
      <div className="actions">
        <Button data-confirm-default onClick={onClose}>
          Keep working
        </Button>
        <Button
          className="danger"
          disabled={!!unavailable}
          onClick={() => {
            onClose();
            onStop();
          }}
        >
          Stop work
        </Button>
      </div>
    </Dialog>
  );
}
