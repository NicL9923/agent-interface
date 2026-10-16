import { Icon } from "../components/Icon";
import type { AppUpdate } from "./use-browser";

/** Says a newer WildBots build is ready until the person refreshes into it. */
export function UpdateNotice({ update }: { update: AppUpdate | null }) {
  if (!update) return null;
  return (
    <div className="app-update" role="status">
      <Icon name="upgrade" size={18} />
      <span><strong>Update available</strong> Refresh to get the latest WildBots.</span>
      <button type="button" className="primary" disabled={update.applying} onClick={update.apply}>
        {update.applying ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}
