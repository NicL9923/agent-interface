import { useId } from "react";
import type { useDeviceNotifications } from "./use-device-notifications";
import "./device-notifications.css";

type Notifications = ReturnType<typeof useDeviceNotifications>;
export function NotificationSettings({ notifications }: { notifications: Notifications }) {
  const descriptionId = useId();
  return <section className="notification-settings" aria-labelledby="notifications-title">
    <div className="notification-settings-header">
      <h3 id="notifications-title">Notifications</h3>
      <label className="notification-toggle">
        <input type="checkbox" role="switch" aria-label="Notifications on this device" aria-describedby={descriptionId}
          checked={notifications.enabled} disabled={notifications.checking || notifications.busy || !notifications.enabled && !notifications.canEnable}
          onChange={(event) => { if (event.target.checked) void notifications.enable(); else void notifications.disable().catch(() => {}); }} />
        <span>{notifications.enabled ? "Enabled" : "Disabled"}</span>
      </label>
    </div>
    <p id={descriptionId} className="muted">{notifications.message}</p>
    {notifications.busy && <p role="status">Updating notifications…</p>}
    {notifications.error && <p className="form-error" role="alert">{notifications.error}</p>}
    {notifications.error && <button type="button" disabled={notifications.busy} onClick={() => void notifications.refresh()}>Retry checking notifications</button>}
    <p className="muted notification-device-note">This setting applies to your account on this device.</p>
  </section>;
}
export function NotificationOnboarding({ notifications }: { notifications: Notifications }) {
  if (!notifications.prompt) return null;
  return <section className="notification-onboarding" aria-labelledby="notification-onboarding-title">
    <div><h3 id="notification-onboarding-title">Enable notifications on this device?</h3>
      <p>Get notified when work finishes or an assistant needs your attention. You can change this later in Preferences &gt; Notifications.</p>
      {!notifications.canEnable && <p className="muted">{notifications.message}</p>}
      {notifications.error && <p className="form-error" role="alert">{notifications.error}</p>}
    </div>
    <div className="actions">
      <button type="button" className="primary" disabled={!notifications.canEnable || notifications.busy} onClick={() => void notifications.enable()}>
        {notifications.busy ? "Enabling…" : "Enable notifications"}
      </button>
      <button type="button" disabled={notifications.busy} onClick={notifications.dismissPrompt}>Not now</button>
    </div>
  </section>;
}
