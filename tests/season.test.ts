import { expect, it } from "vitest";
import { easterSunday, homeSeason, seasonOn } from "../src/app/season";
import type { Bot } from "../src/shared/types";

const on = (year: number, month: number, day: number) =>
  seasonOn(new Date(year, month - 1, day, 12));
const shaped = (id: string, shape: string) =>
  ({
    id,
    avatar: { mode: "geometric", shape, color: "#ffffff", eyes: "round", accessory: "none" },
  }) as Bot;

it("finds Western Easter Sunday", () => {
  expect([2024, 2025, 2026, 2027, 2038].map((year) => easterSunday(year).toDateString())).toEqual([
    new Date(2024, 2, 31).toDateString(),
    new Date(2025, 3, 20).toDateString(),
    new Date(2026, 3, 5).toDateString(),
    new Date(2027, 2, 28).toDateString(),
    new Date(2038, 3, 25).toDateString(),
  ]);
});

it("gives each holiday window its season and leaves the rest of the year plain", () => {
  expect(on(2026, 12, 1)).toBe("winter");
  expect(on(2027, 1, 6)).toBe("winter");
  expect(on(2027, 1, 7)).toBeNull();
  expect(on(2026, 3, 9)).toBeNull();
  expect(on(2026, 3, 17)).toBe("clover");
  // Easter 2026 is April 5: the week before through Easter Monday.
  expect([on(2026, 3, 28), on(2026, 3, 29), on(2026, 4, 6), on(2026, 4, 7)]).toEqual([
    null,
    "spring",
    "spring",
    null,
  ]);
  expect([on(2026, 6, 27), on(2026, 6, 28), on(2026, 7, 4), on(2026, 7, 5)]).toEqual([
    null,
    "stars",
    "stars",
    null,
  ]);
  expect([on(2026, 10, 14), on(2026, 10, 15), on(2026, 10, 31)]).toEqual([
    null,
    "spooky",
    "spooky",
  ]);
  expect([on(2026, 11, 1), on(2026, 11, 30)]).toEqual(["harvest", "harvest"]);
  expect(on(2026, 8, 15)).toBeNull();
});

it("lets a pinned seasonal shape bring its season only between calendar seasons", () => {
  const pinned = [shaped("plain", "bear"), shaped("frosty", "snowman")];
  expect(homeSeason(new Date(2026, 7, 15), pinned)).toBe("winter");
  expect(homeSeason(new Date(2026, 10, 6), pinned)).toBe("harvest");
  expect(homeSeason(new Date(2026, 7, 15), [shaped("plain", "bear")])).toBeNull();
  expect(
    homeSeason(new Date(2026, 7, 15), [
      { id: "photo", avatar: { mode: "portrait", src: "", origin: "uploaded" } } as Bot,
    ]),
  ).toBeNull();
});

it("gives each seasonal shape its season and leaves holiday-looking everyday shapes plain", () => {
  const season = (shape: string) => homeSeason(new Date(2026, 7, 15), [shaped("one", shape)]);
  expect(["pumpkin", "bat", "turkey", "santa-hat", "reindeer", "snowman"].map(season)).toEqual([
    "spooky",
    "spooky",
    "harvest",
    "winter",
    "winter",
    "winter",
  ]);
  // A ghost, a star, a bunny or a clover is an everyday pick, so it must not turn home seasonal
  // all year. Nor does a shape this release has never heard of.
  expect(["ghost", "star", "bunny", "clover", "witch-hat", "tesseract"].map(season)).toEqual(
    Array(6).fill(null),
  );
});
