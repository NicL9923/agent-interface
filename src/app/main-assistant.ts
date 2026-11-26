import { ApiError, request } from "../client-api";
import type { CheckInSettings, MorningBriefSettings, Preferences } from "../shared/types";
import { CHECK_IN_HOURS, MORNING_BRIEF_DEFAULT_TIME } from "../shared/main-assistant";

/** The device's timezone, which check-ins read as night. */
export const deviceTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * The preferences the server saved before a request failed, when its error reports them: a change that
 * was saved but that Hermes hasn't finished, such as a check-in it hasn't removed yet.
 */
export function savedPreferences(error: unknown): Preferences | undefined {
  const value = error instanceof ApiError ? error.data?.preferences : undefined;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Preferences)
    : undefined;
}

/** Applies what the server saved, whether the request succeeded or failed after saving; a failure still rejects with its message. */
async function applying(work: Promise<Preferences>, apply: (value: Preferences) => void) {
  try {
    const saved = await work;
    apply(saved);
    return saved;
  } catch (error) {
    const saved = savedPreferences(error);
    if (saved) apply(saved);
    throw error;
  }
}

/** Makes an assistant this person's main one, or clears it with null, and applies what was saved. */
export const chooseMain = (
  botId: string | null,
  apply: (value: Preferences) => void,
): Promise<Preferences> => applying(request("PUT /preferences/main", { body: { botId } }), apply);

/** Turns check-ins on or off, or changes how often they run, keeping the other setting, and applies what was saved. */
export function saveCheckIns(
  current: Preferences["checkIns"],
  change: Partial<CheckInSettings>,
  apply: (value: Preferences) => void,
): Promise<Preferences> {
  const body: CheckInSettings = {
    enabled: current?.enabled ?? false,
    everyHours: current?.everyHours ?? CHECK_IN_HOURS.default,
    timezone: deviceTimezone(),
    ...change,
  };
  return applying(request("PUT /preferences/check-ins", { body }), apply);
}

/** Turns the main assistant's daily morning brief on or off, or updates its time. */
export function saveMorningBrief(
  current: Preferences["morningBrief"],
  change: Partial<MorningBriefSettings>,
  apply: (value: Preferences) => void,
): Promise<Preferences> {
  const body: MorningBriefSettings = {
    enabled: current?.enabled ?? false,
    timeOfDay: current?.timeOfDay ?? MORNING_BRIEF_DEFAULT_TIME,
    timezone: deviceTimezone(),
    ...change,
  };
  return applying(request("PUT /preferences/morning-brief", { body }), apply);
}
