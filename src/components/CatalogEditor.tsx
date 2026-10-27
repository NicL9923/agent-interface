import type { ReactNode } from "react";
import type { CatalogDraft } from "../app/use-catalog-draft";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import "./catalog-editor.css";

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
  return <section className="catalog-editor" aria-label={kind === "tools" ? "Tools" : "Skills"}>
    <header>
      <h2>{kind === "tools" ? "Tools" : "Skills"}</h2>
      <p>{kind === "tools" ? "Save to apply your changes." : "Required skills stay enabled."}</p>
    </header>
    {note}
    {supported && !ready && (
      draft.failed ? <Button onClick={draft.retry}>Retry loading {kind}</Button> : <p role="status">Loading {kind}…</p>
    )}
    <div className="capability-list">{items.map(item => {
      const required = "required" in item && !!item.required;
      const description = item.description !== "Required by Hermes" && item.description !== "Hermes profile skill" ? item.description : "";
      return <label className="capability-item" key={item.id}>
        <Input type="checkbox" checked={item.enabled || required}
          disabled={busy || !ready || !supported || required}
          onChange={event => draft.toggle(item.id, event.target.checked)} />
        <span>
          <strong>{item.name}</strong>
          {description && <small>{description}</small>}
          {required && <small>Required by Hermes</small>}
        </span>
      </label>;
    })}</div>
    {ready && supported && !items.length && <p className="muted">No {kind} were reported by Hermes.</p>}
    <div className="actions sticky-actions settings-save-actions catalog-save-actions">
      <Button className="primary with-progress" disabled={busy || !ready || !supported} onClick={onSave}>{progress}</Button>
    </div>
  </section>;
}
