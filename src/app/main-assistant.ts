import { request } from "../client-api";
import type { CheckInSettings, Preferences } from "../shared/types";
import { CHECK_IN_HOURS } from "../shared/main-assistant";

/** The device's timezone, which check-ins read as night. */
export const deviceTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Makes an assistant this person's main one, or clears it with null. Resolves with the saved preferences. */
export const chooseMain = (botId: string | null): Promise<Preferences> => request("PUT /preferences/main", { body: { botId } });

/** Turns check-ins on or off, or changes how often they run, keeping the other setting. */
export function saveCheckIns(current: Preferences["checkIns"], change: Partial<CheckInSettings>): Promise<Preferences> {
  const body: CheckInSettings = { enabled: current?.enabled ?? false, everyHours: current?.everyHours ?? CHECK_IN_HOURS.default, timezone: deviceTimezone(), ...change };
  return request("PUT /preferences/check-ins", { body });
}
