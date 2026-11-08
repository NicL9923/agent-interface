import { Button } from "../components/ui/button";
import { Icon } from "../components/Icon";
import type { Bootstrap } from "../shared/types";
import { usageSummary } from "../shared/account-usage";
import { useResource } from "./use-resource";
import { request } from "../client-api";
import { routeUrl } from "../shared/api";
import { useMenu } from "./use-menu";

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase() || "?";

/**
 * The person's own avatar, with the connection dot, opens their profile menu: who is signed in, how
 * close the household's accounts are to their limits, Settings and Sign out.
 */
export function AccountMenu({ user, status, onUsage, onSettings, onSignOut }: {
  user: Bootstrap["user"]; status: "connected" | "reconnecting" | "offline";
  onUsage(): void; onSettings(): void; onSignOut(): void;
}) {
  const { open, setOpen, wrap, trigger, menuId, keys, choose } = useMenu();
  // Read once the menu first opens; the server keeps one answer for a minute, so reopening is cheap.
  const usage = useResource(routeUrl("GET /usage/accounts", {}), { load: (_, signal) => request("GET /usage/accounts", { signal }), enabled: open });
  const summary = usage.data ? usageSummary(usage.data.accounts) ?? "No limits reported" : "Plans, limits and credits";
  return <span className="home-new account-menu" ref={wrap} onKeyDown={keys}>
    <Button ref={trigger} className="home-account" aria-label="Account" title="Account" aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined} onClick={() => setOpen(value => !value)}>
      {user.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : initials(user.name)}
      <span className={`home-status home-status-${status}`} aria-hidden="true" />
    </Button>
    {open && <div className="home-new-menu account-menu-list" id={menuId} role="menu" aria-label="Account">
      <div className="account-menu-who" role="presentation"><strong>{user.name}</strong><small>{user.email}</small></div>
      <button type="button" role="menuitem" onClick={() => choose(onUsage)}>
        <Icon name="gauge" size={16} /><span className="account-menu-text">Usage<small>{summary}</small></span>
      </button>
      <button type="button" role="menuitem" onClick={() => choose(onSettings)}><Icon name="gear" size={16} />Settings</button>
      <button type="button" role="menuitem" onClick={() => choose(onSignOut)}><Icon name="signout" size={16} />Sign out</button>
    </div>}
  </span>;
}
