import type { Bot, MascotFamily } from "../shared/types";

/**
 * Home's seasonal chrome: a slight shift of the rail's accent and a few drifting motes behind it.
 * The calendar decides first; outside every window, a pinned seasonal character brings its own season.
 */
export type Season = "winter" | "clover" | "spring" | "stars" | "spooky" | "harvest";

/** Western Easter Sunday for `year`, as a local date (the anonymous Gregorian computus). */
export function easterSunday(year: number) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

const day = (year: number, month: number, date: number) => new Date(year, month - 1, date).getTime();

/** The season the calendar gives `date`, in local time, or null between seasons. */
export function seasonOn(date: Date): Season | null {
  const year = date.getFullYear(), month = date.getMonth() + 1, today = day(year, month, date.getDate());
  if (month === 12 || month === 1 && date.getDate() <= 6) return "winter";
  if (month === 3 && date.getDate() >= 10 && date.getDate() <= 17) return "clover";
  // Whole local dates, built by the calendar, so a daylight saving change never shifts a boundary.
  const easter = easterSunday(year), easterDay = (offset: number) => day(year, easter.getMonth() + 1, easter.getDate() + offset);
  if (today >= easterDay(-7) && today <= easterDay(1)) return "spring";
  if (today >= day(year, 6, 28) && today <= day(year, 7, 4)) return "stars";
  if (today >= day(year, 10, 15) && today <= day(year, 10, 31)) return "spooky";
  if (month === 11) return "harvest";
  return null;
}

const familySeasons: Partial<Record<MascotFamily, Season>> = {
  leprechaun: "clover", bunny: "spring", eagle: "stars", pumpkin: "spooky", bat: "spooky", ghost: "spooky",
  turkey: "harvest", santa: "winter", rudolph: "winter", snowman: "winter",
};

/** The season home shows: the calendar's, or else the first pinned seasonal character's. */
export function homeSeason(date: Date, pinned: Bot[]): Season | null {
  const calendar = seasonOn(date);
  if (calendar) return calendar;
  for (const bot of pinned) {
    const season = bot.avatar?.mode === "mascot" ? familySeasons[bot.avatar.family] : undefined;
    if (season) return season;
  }
  return null;
}
