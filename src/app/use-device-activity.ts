import { useEffect } from "react";
import { request } from "../client-api";
import { deviceHeartbeatMs, deviceIdleMs } from "../shared/device-activity";
import { deviceId } from "./device-id";

const inputs = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
// One report at a time, so stopping can never land after starting again.
let reports = Promise.resolve();
function report(state: "active" | "inactive", idleMs?: number) {
  const body = { deviceId: deviceId(), state, ...(idleMs !== undefined && { idleMs }) };
  // Activity is a hint: a failed report only means this device's alerts follow the old rule a while longer.
  reports = reports.then(() => request("PUT /devices/activity", { body })).then(() => {}, () => {});
}

/**
 * Tells the server this browser is the device its person is using, on any screen, while it is
 * focused and touched in the last five minutes. Notifications then go only to the devices in use.
 * Signing out or switching accounts reports the old account's device as no longer in use.
 */
export function useDeviceActivity(userId: string | undefined) {
  useEffect(() => {
    if (!userId) return;
    let using = false, lastInput = Date.now();
    const attended = () => document.visibilityState === "visible" && document.hasFocus();
    const update = () => {
      const idle = Date.now() - lastInput;
      const now = attended() && idle < deviceIdleMs;
      if (now) report("active", idle);
      else if (using) report("inactive");
      using = now;
    };
    const input = () => {
      lastInput = Date.now();
      if (!using) update();
    };
    update();
    const timer = setInterval(update, deviceHeartbeatMs);
    for (const name of inputs) window.addEventListener(name, input, { passive: true });
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      for (const name of inputs) window.removeEventListener(name, input);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
      if (using) report("inactive");
    };
  }, [userId]);
}
