// Display timestamps in the viewer's time zone. Values that belong to an explicit zone format themselves.
export type Instant = Date | string | number;
export type WhenOptions = {
  now?: number;
  locale?: string;
  // Lowercases a leading relative word for use inside a sentence ("Since yesterday, 6:38 PM").
  inline?: boolean;
  // False for scheduled times such as calendar events, which read better as clock times.
  relative?: boolean;
  // Omits the day when the value falls on the same day as this one, as in a range end.
  from?: Instant;
};
const MINUTE = 60_000;
const dayNumber = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
export function formatWhen(value: Instant, { now = Date.now(), locale, inline = false, relative = true, from }: WhenOptions = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const current = new Date(now);
  const time = date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const minutes = Math.floor(Math.abs(date.getTime() - now) / MINUTE);
  const days = dayNumber(date) - dayNumber(current);
  const label = relative && minutes < 60
    ? minutes < 1 ? "Just now" : date.getTime() < now ? `${minutes} min ago` : `In ${minutes} min`
    : from !== undefined && dayNumber(new Date(from)) === dayNumber(date) ? time
    : days === 0 ? `Today, ${time}`
    : days === -1 ? `Yesterday, ${time}`
    : days === 1 ? `Tomorrow, ${time}`
    : Math.abs(days) < 7 ? `${date.toLocaleDateString(locale, { weekday: "short" })} ${time}`
    : date.getFullYear() === current.getFullYear()
      ? `${date.toLocaleDateString(locale, { month: "short", day: "numeric" })}, ${time}`
      : date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
  return inline && /^(Just|In |Today|Yesterday|Tomorrow)/.test(label) ? label[0].toLowerCase() + label.slice(1) : label;
}
export function formatFull(value: Instant, locale?: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(locale, { dateStyle: "full", timeStyle: "medium" });
}
/** Short list label: a clock time today, then Yesterday, a weekday, or a date. */
export function formatListDate(value: Instant, { now = Date.now(), locale }: Pick<WhenOptions, "now" | "locale"> = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const current = new Date(now);
  const days = dayNumber(current) - dayNumber(date);
  return days <= 0 ? date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
    : days === 1 ? "Yesterday"
    : days < 7 ? date.toLocaleDateString(locale, { weekday: "short" })
    : date.getFullYear() === current.getFullYear() ? date.toLocaleDateString(locale, { month: "short", day: "numeric" })
    : date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
}
