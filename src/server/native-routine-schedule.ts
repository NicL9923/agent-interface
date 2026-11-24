import { InvalidInput } from "../shared/errors.js";

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

export type NativeRoutineKind = "cron" | "once" | "interval" | "heartbeat";
export type QuietHours = { start: string; end: string };

function cronField(field: string, label: string, min: number, max: number, names: string[] = []) {
  const invalid = () => new InvalidInput(`Invalid cron ${label} field.`);
  function parseValue(value: string) {
    const number = /^\d+$/.test(value) ? Number(value) : min + names.indexOf(value.toUpperCase());
    if (number < min || number > max) throw invalid();
    return number;
  }

  const values = new Set<number>();
  for (const item of field.split(",")) {
    const match = /^(\*|[A-Za-z\d]+)(?:-([A-Za-z\d]+))?(?:\/(\d+))?$/.exec(item);
    if (!match) throw invalid();
    const [, first, last, stepText] = match;
    if ((first === "*" && last) || (stepText && first !== "*" && !last)) throw invalid();
    const start = first === "*" ? min : parseValue(first);
    const end = first === "*" ? max : last ? parseValue(last) : start;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (start > end || !Number.isSafeInteger(step) || step < 1) throw invalid();
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function timezoneFormatter(timezone: string) {
  try {
    // Intl also accepts numeric UTC offsets. Routines use named IANA zones.
    if (typeof timezone !== "string" || !/^[A-Za-z]/.test(timezone)) throw new RangeError();
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
      hour: "numeric",
    });
  } catch (error) {
    throw new InvalidInput("Choose a valid IANA time zone.", undefined, { cause: error });
  }
}

function offsetAt(formatter: Intl.DateTimeFormat, time: number): number {
  const zone = formatter.formatToParts(time).find((part) => part.type === "timeZoneName")!.value;
  if (zone === "GMT") return 0;
  const [hours, minutes, seconds = "0"] = zone.slice(4).split(":");
  return (
    (zone[3] === "-" ? -1 : 1) *
    (Number(hours) * hourMs + Number(minutes) * minuteMs + Number(seconds) * 1000)
  );
}

/** Return the first matching instant strictly after afterMs. Both instants of a fall-back fold match. */
export function nextCronTime(expr: string, timezone: string, afterMs: number): number {
  const fields = typeof expr === "string" ? expr.trim().split(/\s+/) : [];
  if (fields.length !== 5) throw new InvalidInput("Cron requires five fields.");
  const [minute, hour, day, month, weekday] = fields;
  const minutes = cronField(minute, "minute", 0, 59);
  const hours = cronField(hour, "hour", 0, 23);
  const days = cronField(day, "day of month", 1, 31);
  const months = cronField(
    month,
    "month",
    1,
    12,
    "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split(" "),
  );
  const weekdays = cronField(
    weekday,
    "day of week",
    0,
    7,
    "SUN MON TUE WED THU FRI SAT".split(" "),
  );
  if (weekdays.delete(7)) weekdays.add(0);
  const requireBothDays = day.startsWith("*") || weekday.startsWith("*");
  const formatter = timezoneFormatter(timezone);
  if (!Number.isFinite(new Date(afterMs).getTime()))
    throw new InvalidInput("Choose a valid cron search time.");

  const times = [...hours]
    .flatMap((h) => [...minutes].map((m) => h * hourMs + m * minuteMs))
    .sort((a, b) => a - b);
  const startDay = Math.floor(afterMs / dayMs) * dayMs;
  const maxTime = 8.64e15;
  // A Gregorian calendar cycle bounds the search even for expressions such as February 31.
  for (
    let utcDay = startDay;
    utcDay < Math.min(maxTime, startDay + 146_097 * dayMs);
    utcDay += dayMs
  ) {
    // Every IANA offset is shorter than a day. Check the possible local dates first to
    // skip sparse calendar ranges without any Intl calls.
    const localDays = [utcDay - dayMs, utcDay, utcDay + dayMs].filter((localDay) => {
      const date = new Date(localDay);
      const dom = days.has(date.getUTCDate());
      const dow = weekdays.has(date.getUTCDay());
      return months.has(date.getUTCMonth() + 1) && (requireBothDays ? dom && dow : dom || dow);
    });
    if (!localDays.length) continue;

    // Sample the offsets on either side of any transition within this UTC day. IANA
    // transitions within a zone are spaced more than six hours apart. Check each
    // candidate with its actual offset to drop gaps and keep both sides of a fold.
    const offsets = new Set(
      [0, 6, 12, 18, 24].map((h) => offsetAt(formatter, utcDay + h * hourMs)),
    );
    let next = utcDay + dayMs;
    for (const localDay of localDays) {
      for (const offset of offsets) {
        for (const time of times) {
          const candidate = localDay + time - offset;
          if (candidate >= next) break;
          if (
            candidate >= utcDay &&
            candidate > afterMs &&
            offsetAt(formatter, candidate) === offset
          ) {
            next = candidate;
            break;
          }
        }
      }
    }
    if (next < utcDay + dayMs) return next;
  }
  throw new InvalidInput("Cron expression has no matching date.");
}

function quietTime(time: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new InvalidInput("Enter quiet hours as HH:MM.");
  const [hour, minute] = time.split(":").map(Number);
  return hour * hourMs + minute * minuteMs;
}

export function validateQuietHours(hours: QuietHours): void {
  quietTime(hours.start);
  quietTime(hours.end);
}

export function isInQuietHours(hours: QuietHours, timezone: string, now: number): boolean {
  const start = quietTime(hours.start);
  const end = quietTime(hours.end);
  const local = now + offsetAt(timezoneFormatter(timezone), now);
  const time = local - Math.floor(local / dayMs) * dayMs;
  return start <= end ? time >= start && time < end : time >= start || time < end;
}

const MIN_INTERVAL_MS = 1000;

function recurringTime(expr: string, timezone: string, afterMs: number, anchorMs: number): number {
  const interval = /^\d+$/.test(expr) ? Number(expr) : NaN;
  const next = anchorMs + (Math.floor((afterMs - anchorMs) / interval) + 1) * interval;
  if (
    !Number.isSafeInteger(interval) ||
    interval < MIN_INTERVAL_MS ||
    !Number.isFinite(new Date(next).getTime())
  )
    throw new InvalidInput(
      `Enter a positive, whole interval of at least ${MIN_INTERVAL_MS} milliseconds.`,
    );
  return next;
}

export function firstRoutineTime(
  kind: NativeRoutineKind,
  expr: string,
  timezone: string,
  now: number,
): number {
  if (kind === "cron" || (kind === "heartbeat" && /\s/.test(expr)))
    return nextCronTime(expr, timezone, now);

  timezoneFormatter(timezone);
  if (kind === "once") {
    const iso =
      /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:[0-5]\d)$/.exec(
        expr,
      );
    const timestamp = Date.parse(expr);
    const date = new Date(iso?.[1] ?? "");
    if (
      !iso ||
      !Number.isFinite(timestamp) ||
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== iso[1]
    )
      throw new InvalidInput("Enter an ISO timestamp with a time zone for a one-time routine.");
    return timestamp;
  }

  return recurringTime(expr, timezone, now, now);
}

export function nextRecurringRoutineTime(
  kind: Exclude<NativeRoutineKind, "once">,
  expr: string,
  timezone: string,
  now: number,
  due: number,
): number {
  if (kind === "cron" || (kind === "heartbeat" && /\s/.test(expr)))
    return nextCronTime(expr, timezone, now);
  return recurringTime(expr, timezone, now, due);
}
