import type { ReactNode } from "react";
import type { CatalogDraft } from "../app/use-catalog-draft";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/** The checklist and Save button for an assistant's tools or skills. */
export function CatalogEditor({ draft, supported, note, busy, progress, onSave }: {
  draft: CatalogDraft;
  supported: boolean;
  /** Why the capability is unavailable, when it is. */
  note: ReactNode;
  busy: boolean;
  /** Replaces the Save label while saving and just after. */
  progress: ReactNode;
  onSave: () => void;
}) {
  const { kind, items, ready } = draft;
  return <>
    {note}
    {supported && !ready && (
      draft.failed ? <Button onClick={draft.retry}>Retry loading {kind}</Button> : <p role="status">Loading {kind}…</p>
    )}
    {items.map(item => {
      const required = "required" in item && !!item.required;
      return <label className="capability-item" key={item.id}>
        <Input type="checkbox" checked={item.enabled || required}
          disabled={busy || !ready || !supported || required}
          onChange={event => draft.toggle(item.id, event.target.checked)} />
        <span>
          <strong>{item.name}</strong>
          <small>{item.description}</small>
          {required && <small>Required by Hermes</small>}
        </span>
      </label>;
    })}
    {ready && supported && !items.length && <p className="muted">No {kind} were reported by Hermes.</p>}
    <Button className="primary with-progress" disabled={busy || !ready || !supported} onClick={onSave}>{progress}</Button>
  </>;
}
