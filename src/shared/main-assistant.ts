import type { Bot, Message, Preferences } from "./types.js";

/**
 * A member's main assistant and its check-ins: who may be one, how often it checks in, and how a
 * check-in that finds nothing stays silent. Pure, so the server, the web and their tests share one
 * rule; the iOS app mirrors it in MainAssistant.swift.
 */

/** Check-ins run every 1 to 4 whole hours. Never more often: each one is a model run. */
export const CHECK_IN_HOURS = { min: 1, max: 4, default: 2 } as const;
/** The name the managed routine has in every routine list. */
export const CHECK_IN_ROUTINE_NAME = "Check-ins";
/** The name the managed morning brief routine has in every routine list. */
export const MORNING_BRIEF_ROUTINE_NAME = "Morning brief";
/** Default 24h local time for a member's daily morning brief. */
export const MORNING_BRIEF_DEFAULT_TIME = "07:30";

const clockPattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Whether `timeOfDay` is a valid 24-hour HH:MM clock time. */
export const validMorningBriefTime = (value: unknown): value is string =>
  typeof value === "string" && clockPattern.test(value);

/** Daily cron expression for a valid HH:MM clock time (e.g. "07:30" -> "30 7 * * *"). */
export function morningBriefCron(timeOfDay: string): string {
  const match = clockPattern.exec(timeOfDay);
  if (!match) return "30 7 * * *";
  return `${Number(match[2])} ${Number(match[1])} * * *`;
}

/**
 * Only a member's own personal assistant can be their main one. Its routines, deliveries and
 * followers are scoped to its profile, so only an owned personal assistant keeps check-ins private
 * to that member. Shared assistants and older personal ones without a recorded owner are excluded.
 */
export const mainEligible = (
  bot: { shared?: boolean; ownerId?: string } | undefined,
  userId: string,
) => !!bot && bot.shared === false && bot.ownerId === userId;

/** Why an assistant cannot be this member's main one, in words for the picker, or undefined when it can. */
export function mainIneligibleReason(
  bot: { shared?: boolean; ownerId?: string },
  userId: string,
): string | undefined {
  if (mainEligible(bot, userId)) return undefined;
  if (bot.shared !== false)
    return "Shared with the household. Check-ins stay private only on your own personal assistant.";
  return "Visible to the whole household because it has no recorded owner.";
}

/** The Hermes schedule for checking in every `hours` hours: an interval, so no timezone is involved. */
export const checkInSchedule = (hours: number) => `every ${hours}h`;

/** Hermes shows "every 2h" back as "every 120m". Minutes between runs, or NaN when the schedule is something else. */
export function scheduleMinutes(schedule: string) {
  const match = /^(?:every\s+)?(\d+)\s*(m|min|minutes?|h|hr|hours?)$/i.exec(schedule.trim());
  if (!match) return NaN;
  return Number(match[1]) * (match[2].toLowerCase().startsWith("h") ? 60 : 1);
}

/** Whether this many hours is a frequency the server accepts. */
export const validCheckInHours = (hours: unknown): hours is number =>
  typeof hours === "number" &&
  Number.isInteger(hours) &&
  hours >= CHECK_IN_HOURS.min &&
  hours <= CHECK_IN_HOURS.max;

/** "Every 2 hours", for the switch's frequency choices and the routine list. */
export const checkInFrequencyLabel = (hours: number) =>
  hours === 1 ? "Every hour" : `Every ${hours} hours`;

/**
 * Hermes's own silence matcher for routine answers, mirrored for an add-on too old to drop silent
 * answers itself (gateway/response_filters.py is_autonomous_silence_response): `[SILENT]`, SILENT,
 * NO_REPLY or NO REPLY as the whole answer or its own first or last line, or `[SILENT]` opening it.
 */
const silentWords = new Set([
  "[SILENT]",
  "SILENT",
  "NO_REPLY",
  "NO REPLY",
  "[NO_REPLY]",
  "[NO REPLY]",
]);
const bare = (line: string) =>
  line
    .trim()
    .replace(/[.!。]+$/u, "")
    .toUpperCase();
export function isSilentAnswer(text: string | undefined | null) {
  const stripped = (text ?? "").trim();
  if (!stripped) return false;
  const lines = stripped.split(/\r?\n/).filter((line) => line.trim());
  return (
    stripped.toUpperCase().startsWith("[SILENT]") ||
    [stripped, lines[0], lines.at(-1)!].some((line) => silentWords.has(bare(line)))
  );
}

/** The assistant this person made their main one, when it is still on their home. */
export function mainBot(preferences: Pick<Preferences, "mainBotId">, bots: Bot[]) {
  return preferences.mainBotId ? bots.find((bot) => bot.id === preferences.mainBotId) : undefined;
}

/**
 * The assistant an agent message names, for "Open <name>'s chat": the target of a handoff this
 * assistant sent, or the sender of one it received. Only assistants on this person's home can be
 * named, so another member's personal assistant never resolves; nor does the chat already open.
 * A message to several assistants at once, "ranch, notes", matches no single name, so it names none.
 */
export function exchangePartner(
  message: Pick<Message, "toolCall" | "role">,
  incomingName: string | undefined,
  bots: Bot[],
  currentBotId: string,
): Bot | undefined {
  let name = incomingName;
  if (!name) {
    try {
      const target = (JSON.parse(message.toolCall?.arguments || "{}") as { target?: unknown })
        .target;
      if (typeof target === "string") name = target;
    } catch {
      return undefined;
    }
  }
  const wanted = name?.trim().replace(/^@/, "").toLowerCase();
  if (!wanted) return undefined;
  const bot =
    bots.find((row) => row.id.toLowerCase() === wanted) ??
    bots.find((row) => row.name.trim().toLowerCase() === wanted);
  return bot && bot.id !== currentBotId ? bot : undefined;
}
