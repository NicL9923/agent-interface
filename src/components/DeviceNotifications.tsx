import { useId } from "react";
import type { useDeviceNotifications } from "./use-device-notifications";
import "./device-notifications.css";
import { Icon } from "./Icon";
import { FormMessage } from "./ui/form-message";

type Notifications = ReturnType<typeof useDeviceNotifications>;
export function NotificationSettings({ notifications, title = "Notifications" }: { notifications: Notifications; title?: string }) {
  const descriptionId = useId();
  const titleId = `${descriptionId}-title`;
  return <section className={`notification-settings${notifications.blocked ? " is-blocked" : ""}`} aria-labelledby={titleId}>
    <div className="notification-settings-header">
      <h3 id={titleId}>{title}</h3>
      <label className="notification-toggle">
        <input type="checkbox" role="switch" aria-label="Notifications on this device" aria-describedby={descriptionId}
          checked={notifications.enabled} disabled={notifications.checking || notifications.busy || !notifications.enabled && !notifications.canEnable}
          onChange={(event) => { if (event.target.checked) void notifications.enable(); else void notifications.disable().catch(() => {}); }} />
        <span>{notifications.blocked ? "Blocked" : notifications.enabled ? "On" : "Off"}</span>
      </label>
    </div>
    <p id={descriptionId} className={notifications.blocked ? "notification-attention" : "muted"}>{notifications.blocked && <Icon name="alert" size={16} />}{notifications.message}</p>
    {notifications.busy && <p role="status">Updating notifications…</p>}
    {notifications.error && <FormMessage tone="error">{notifications.error}</FormMessage>}
    {notifications.error && <button type="button" disabled={notifications.busy} onClick={() => void notifications.refresh()}>Retry checking notifications</button>}
  </section>;
}
export function NotificationOnboarding({ notifications }: { notifications: Notifications }) {
  if (!notifications.prompt) return null;
  return <section className="notification-onboarding" aria-labelledby="notification-onboarding-title">
    <div><h3 id="notification-onboarding-title">Enable notifications on this device?</h3>
      <p>Get an alert when work finishes or an assistant needs you.</p>
      {!notifications.canEnable && <p className="muted">{notifications.message}</p>}
      {notifications.error && <FormMessage tone="error">{notifications.error}</FormMessage>}
    </div>
    <div className="actions">
      <button type="button" className="primary" disabled={!notifications.canEnable || notifications.busy} onClick={() => void notifications.enable()}>
        {notifications.busy ? "Enabling…" : "Enable notifications"}
      </button>
      <button type="button" disabled={notifications.busy} onClick={notifications.dismissPrompt}>Not now</button>
    </div>
  </section>;
}
