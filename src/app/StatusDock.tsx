import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import "./shell.css";

/**
 * The notices above the composer, most pressing first: a send whose outcome is unknown, an
 * interrupted task to review before continuing, the connection, decisions waiting, then an update.
 */
export const dockPriority = { send: 0, interrupted: 1, connection: 2, decisions: 3, update: 4 } as const;
export type DockKind = keyof typeof dockPriority;
export type DockItem = { id: string; kind: DockKind; node: ReactNode };

export function sortDock(items: readonly DockItem[]) {
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => dockPriority[a.item.kind] - dockPriority[b.item.kind] || a.index - b.index)
    .map(entry => entry.item);
}

export function StatusDock({ items }: { items: readonly DockItem[] }) {
  if (!items.length) return null;
  return <div className="status-dock">
    {sortDock(items).map(item => <div key={item.id} className={`dock-item dock-${item.kind}`}>{item.node}</div>)}
  </div>;
}

/** Waiting approvals, questions and secure requests in the open chat. */
export function DecisionsNotice({ count, onReview, disconnected = false }: { count: number; onReview(): void; disconnected?: boolean }) {
  return <div className="dock-row dock-decisions-row">
    <Icon name="bell" size={17} />
    <span><strong>{count === 1 ? "1 decision waiting" : `${count} decisions waiting`}</strong></span>
    <button type="button" className={disconnected ? undefined : "primary"} onClick={onReview}>Review</button>
  </div>;
}

/** Scrolls the first waiting decision into view and moves focus to it. W1 marks the cards with data-attention-id. */
export function reviewFirstDecision(root: ParentNode = document) {
  const card = root.querySelector<HTMLElement>("[data-attention-id]")
    ?? root.querySelector<HTMLElement>(".transcript .approval-card");
  if (!card) return false;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView?.({ block: "center", behavior: reduced ? "auto" : "smooth" });
  // The card itself takes focus, so a screen reader reads what is being decided before its buttons.
  if (!card.hasAttribute("tabindex")) card.setAttribute("tabindex", "-1");
  card.focus({ preventScroll: true });
  return true;
}

