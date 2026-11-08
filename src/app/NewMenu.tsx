import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Button } from "../components/ui/button";
import { Icon } from "../components/Icon";

/**
 * Home's + button. It opens a small menu of what can be made: an assistant, or a group chat
 * when Hermes can host one. Without the group choice there is nothing to pick from, so the
 * button makes an assistant at once.
 */
export function NewMenu({ canGroup, groupHint, onNewBot, onNewGroup }: { canGroup: boolean; groupHint?: string; onNewBot(): void; onNewGroup(): void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)")?.focus();
    const away = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  useEffect(() => { if (!canGroup) setOpen(false); }, [canGroup]);
  if (!canGroup) return <Button className="home-round" aria-label="New assistant" onClick={onNewBot}><Icon name="plus" /></Button>;
  const choose = (run: () => void) => { setOpen(false); run(); };
  const close = (focus: boolean) => { setOpen(false); if (focus) trigger.current?.focus(); };
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") { setOpen(false); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...wrap.current!.querySelectorAll<HTMLElement>("[role='menuitem']:not(:disabled)")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return <span className="home-new" ref={wrap} onKeyDown={keys}>
    <Button ref={trigger} className="home-round" aria-label="New" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => setOpen(value => !value)}><Icon name="plus" /></Button>
    {open && <div className="home-new-menu" id={menuId} role="menu" aria-label="New">
      <button type="button" role="menuitem" onClick={() => choose(onNewBot)}><Icon name="plus" size={16} />New assistant</button>
      <button type="button" role="menuitem" disabled={!!groupHint} onClick={() => choose(onNewGroup)}><Icon name="groups" size={16} />New group chat</button>
      {groupHint && <small role="note">{groupHint}</small>}
    </div>}
  </span>;
}
