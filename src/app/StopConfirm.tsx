import { useId } from "react";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import "./shell.css";

/** Asks before Cmd+. stops an assistant's work, as the native app does. */
export function StopConfirm({ name, onStop, onClose }: { name: string; onStop(): void; onClose(): void }) {
  const titleId = useId(), detailId = useId();
  return <Dialog className="confirm-dialog" role="alertdialog" aria-labelledby={titleId} aria-describedby={detailId}
    initialFocus="[data-confirm-default]" onCancel={onClose} onClose={onClose}>
    <h2 id={titleId}>Stop {name}'s work?</h2>
    <p id={detailId}>Anything already done stays done. You can send new guidance afterwards.</p>
    <div className="actions">
      <Button data-confirm-default onClick={onClose}>Keep working</Button>
      <Button className="danger" onClick={() => { onClose(); onStop(); }}>Stop work</Button>
    </div>
  </Dialog>;
}
