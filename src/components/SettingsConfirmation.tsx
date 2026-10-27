import { useId } from "react";
import { Dialog, type DialogFocusTarget } from "./ui/dialog";
import { Button } from "./ui/button";

export function SettingsConfirmation({ title, detail, confirmLabel, cancelLabel = "Keep editing", danger = false, busy, onConfirm, onCancel, fallbackFocus }: {
  title: string; detail: string; confirmLabel: string; cancelLabel?: string; danger?: boolean; busy: boolean;
  onConfirm(): void; onCancel(): void; fallbackFocus: DialogFocusTarget;
}) {
  const titleId = useId(), detailId = useId();
  return <Dialog className="confirm-dialog settings-confirmation" role="alertdialog"
    aria-labelledby={titleId} aria-describedby={detailId} initialFocus="[data-confirm-default]" fallbackFocus={fallbackFocus}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onCancel(); }}
    onClose={event => { event.stopPropagation(); onCancel(); }}>
    <h2 id={titleId}>{title}</h2>
    <p id={detailId}>{detail}</p>
    <div className="actions">
      <Button data-confirm-default onClick={onCancel}>{cancelLabel}</Button>
      <Button className={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>
    </div>
  </Dialog>;
}

