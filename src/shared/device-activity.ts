/**
 * Device activity: which of a person's installations they are using now, so a notification goes
 * only there. The rules live here so the server, the web client and the native contract agree.
 */

/** A device stops counting this long after its person's last input. */
export const deviceIdleMs = 5 * 60_000;
/** How often a device in use reports. */
export const deviceHeartbeatMs = 15_000;
/** A device that missed this many milliseconds of beats, about three, no longer counts. */
export const deviceBeatTtl = 45_000;
/**
 * A device ID is a lowercase UUID chosen once per installation: per browser profile on the web,
 * per install on iOS (the same ID the app registers for push). Upper case is accepted and folded.
 */
export const deviceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Whether a device last used `usedAt` and last heard from `beatAt` counts as in use at `now`. */
export const deviceInUse = (beatAt: number, usedAt: number, now: number) => now - beatAt < deviceBeatTtl && now - usedAt < deviceIdleMs;
