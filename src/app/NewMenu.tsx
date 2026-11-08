import { useEffect } from "react";
import { Button } from "../components/ui/button";
import { Icon } from "../components/Icon";
import { useMenu } from "./use-menu";

/**
 * Home's + button. It opens a small menu of what can be made: an assistant, or a group chat
 * when Hermes can host one. Without the group choice there is nothing to pick from, so the
 * button makes an assistant at once.
 */
export function NewMenu({ canGroup, groupHint, onNewBot, onNewGroup }: { canGroup: boolean; groupHint?: string; onNewBot(): void; onNewGroup(): void }) {
  const { open, setOpen, wrap, trigger, menuId, keys, choose } = useMenu();
  useEffect(() => { if (!canGroup) setOpen(false); }, [canGroup, setOpen]);
  if (!canGroup) return <Button className="home-round" aria-label="New assistant" onClick={onNewBot}><Icon name="plus" /></Button>;
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
