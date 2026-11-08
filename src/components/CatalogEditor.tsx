import type { ReactNode } from "react";
import type { CatalogDraft } from "../app/use-catalog-draft";
import type { Skill, Tool } from "../shared/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import "./catalog-editor.css";

/** The checklist for an assistant's tools or skills. The settings sheet's Save changes sends it. */
export function CatalogEditor({ draft, supported, note, busy, extras }: {
  draft: CatalogDraft;
  supported: boolean;
  /** Why the capability is unavailable, when it is, and any messages about the list. */
  note: ReactNode;
  busy: boolean;
  /** More about one row and what can be done with it, such as a skill's lock. */
  extras?: (item: Tool | Skill) => ReactNode;
}) {
  const { kind, items, ready } = draft;
  const title = kind === "tools" ? "Tools" : "Skills";
  return <section className="catalog-editor" aria-label={title}>
    <header>
      <h2>{title}</h2>
      {kind === "skills" && <p>Required skills stay enabled.</p>}
    </header>
    {note}
    {supported && !ready && (
      draft.failed ? <Button onClick={draft.retry}>Retry loading {kind}</Button> : <p role="status">Loading {kind}…</p>
    )}
    <div className="capability-list">{items.map(item => {
      const required = "required" in item && !!item.required;
      const description = item.description !== "Required by Hermes" && item.description !== "Hermes profile skill" ? item.description : "";
      const more = extras?.(item);
      return <div className="capability-row" key={item.id}>
        <label className="capability-item">
          <Input type="checkbox" checked={item.enabled || required}
            disabled={busy || !ready || !supported || required}
            onChange={event => draft.toggle(item.id, event.target.checked)} />
          <span>
            <strong>{item.name}</strong>
            {description && <small>{description}</small>}
            {required && <small>Required by Hermes</small>}
          </span>
        </label>
        {more}
      </div>;
    })}</div>
    {ready && supported && !items.length && <p className="muted">No {kind} were reported by Hermes.</p>}
  </section>;
}
