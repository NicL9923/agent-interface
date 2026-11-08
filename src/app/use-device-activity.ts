import { useEffect } from "react";
import { request } from "../client-api";
import { deviceHeartbeatMs, deviceIdleMs } from "../shared/device-activity";
import { deviceId } from "./device-id";

const inputs = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
type Report = { state: "active" | "inactive"; idleMs?: number };
// One report in flight at a time, and at most one waiting behind it: the latest. A waiting report is
// worked out only as it goes, so a slow server never receives an old "active" after the window was
// left, and the idle time it carries is the time at sending, which the server stamps.
let sending = false;
let next: (() => Report) | undefined;
function report(current: () => Report) {
  next = current;
  if (sending) return;
  sending = true;
  void (async () => {
    while (next) {
      const body = { deviceId: deviceId(), ...next() };
      next = undefined;
      // Activity is a hint: a failed report only means this device's alerts follow the old rule a while longer.
      await request("PUT /devices/activity", { body }).catch(() => {});
    }
    sending = false;
  })();
}

/**
 * Tells the server this browser is the device its person is using, on any screen, while it is
 * focused and touched in the last five minutes. Notifications then go only to the devices in use.
 * Signing out or switching accounts reports the old account's device as no longer in use.
 */
export function useDeviceActivity(userId: string | undefined) {
  useEffect(() => {
    if (!userId) return;
    let using = false, lastInput = Date.now(), mounted = true;
    const attended = () => document.visibilityState === "visible" && document.hasFocus();
    const inUse = () => mounted && attended() && Date.now() - lastInput < deviceIdleMs;
    // What to say when the report actually goes: in use now, with the idle time now, or not.
    const current = (): Report => inUse() ? { state: "active", idleMs: Date.now() - lastInput } : { state: "inactive" };
    const update = () => {
      const now = inUse();
      if (now || using) report(current);
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
      mounted = false;
      if (using) report(() => ({ state: "inactive" }));
    };
  }, [userId]);
}
