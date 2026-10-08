// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatFull, formatListDate, formatWhen } from "../src/time";
import type { WhenOptions } from "../src/time";
import { When } from "../src/components/When";

// Local-time constructors keep calendar-day boundaries independent of the machine's zone.
const at = (month: number, day: number, hour: number, minute = 0, year = 2026) => new Date(year, month - 1, day, hour, minute);
const saturdayEvening = at(10, 3, 18, 50).getTime();
const label = (value: Date | string | number, options: WhenOptions = {}) =>
  formatWhen(value, { now: saturdayEvening, locale: "en-US", ...options }).replace(/ /g, " ");

describe("timestamp labels", () => {
  it("keeps list dates short: clock today, then Yesterday, weekday and date", () => {
    const list = (value: Date) => formatListDate(value, { now: saturdayEvening, locale: "en-US" }).replace(/ /g, " ");
    expect(list(at(10, 3, 9, 41))).toBe("9:41 AM");
    expect(list(at(10, 2, 23, 59))).toBe("Yesterday");
    expect(list(at(9, 28, 12))).toBe("Mon");
    expect(list(at(9, 19, 12))).toBe("Sep 19");
    expect(list(at(12, 30, 12, 0, 2025))).toBe("Dec 30, 2025");
  });

  it("uses relative words within the hour in both directions", () => {
    expect(label(saturdayEvening - 20_000)).toBe("Just now");
    expect(label(saturdayEvening + 20_000)).toBe("Just now");
    expect(label(at(10, 3, 18, 38))).toBe("12 min ago");
    expect(label(at(10, 3, 17, 51))).toBe("59 min ago");
    expect(label(at(10, 3, 19, 2))).toBe("In 12 min");
  });

  it("names today, yesterday and tomorrow with a clock time", () => {
    expect(label(at(10, 3, 17, 50))).toBe("Today, 5:50 PM");
    expect(label(at(10, 3, 19, 58))).toBe("Today, 7:58 PM");
    expect(label(at(10, 2, 18, 38))).toBe("Yesterday, 6:38 PM");
    expect(label(at(10, 4, 7))).toBe("Tomorrow, 7:00 AM");
  });

  it("follows calendar days rather than 24-hour spans around midnight", () => {
    const afterMidnight = { now: at(10, 3, 0, 30).getTime() };
    expect(label(at(10, 2, 23), afterMidnight)).toBe("Yesterday, 11:00 PM");
    expect(label(at(10, 2, 23, 45), afterMidnight)).toBe("45 min ago");
    const beforeMidnight = { now: at(10, 3, 23, 30).getTime() };
    expect(label(at(10, 4, 0, 45), beforeMidnight)).toBe("Tomorrow, 12:45 AM");
    expect(label(at(10, 3, 0, 15), beforeMidnight)).toBe("Today, 12:15 AM");
  });

  it("uses the weekday within six days, then the date, and the year only for other years", () => {
    expect(label(at(9, 29, 18, 38))).toBe("Tue 6:38 PM");
    expect(label(at(9, 27, 9))).toBe("Sun 9:00 AM");
    expect(label(at(9, 26, 18, 38))).toBe("Sep 26, 6:38 PM");
    expect(label(at(10, 6, 9))).toBe("Tue 9:00 AM");
    expect(label(at(10, 10, 9))).toBe("Oct 10, 9:00 AM");
    expect(label(at(3, 14, 18, 38))).toBe("Mar 14, 6:38 PM");
    expect(label(at(10, 3, 18, 38, 2025))).toBe("Oct 3, 2025");
    const newYear = { now: at(1, 1, 0, 30, 2027).getTime() };
    expect(label(at(12, 31, 22), newYear)).toBe("Yesterday, 10:00 PM");
    expect(label(at(12, 20, 22), newYear)).toBe("Dec 20, 2026");
  });

  it("reads naturally inside a sentence without lowercasing names", () => {
    expect(label(at(10, 2, 18, 38), { inline: true })).toBe("yesterday, 6:38 PM");
    expect(label(saturdayEvening, { inline: true })).toBe("just now");
    expect(label(at(10, 3, 19, 2), { inline: true })).toBe("in 12 min");
    expect(label(at(9, 29, 18, 38), { inline: true })).toBe("Tue 6:38 PM");
    expect(label(at(9, 26, 18, 38), { inline: true })).toBe("Sep 26, 6:38 PM");
  });

  it("formats scheduled ranges as clock times and drops a repeated day", () => {
    expect(label(at(10, 3, 19, 2), { relative: false })).toBe("Today, 7:02 PM");
    expect(label(at(10, 4, 19), { relative: false, from: at(10, 4, 18) })).toBe("7:00 PM");
    expect(label(at(10, 5, 9), { relative: false, from: at(10, 4, 18) })).toBe("Mon 9:00 AM");
  });

  it("accepts server ISO strings and epoch values and ignores invalid input", () => {
    expect(label(at(10, 3, 18, 38).toISOString())).toBe("12 min ago");
    expect(label(at(10, 3, 18, 38).getTime())).toBe("12 min ago");
    expect(label("not a date")).toBe("");
    expect(formatFull(at(10, 3, 18, 38), "en-US").replace(/ /g, " ")).toBe("Saturday, October 3, 2026 at 6:38:00 PM");
  });
});

describe("When", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("renders a machine-readable time and refreshes every mounted label from one minute timer", async () => {
    vi.useFakeTimers({ now: at(10, 3, 18, 50).getTime() + 30_000 });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const value = at(10, 3, 18, 50).toISOString();
    await act(async () => root.render([createElement(When, { key: "a", value }), createElement(When, { key: "b", value: at(10, 3, 18, 40).getTime(), inline: true })]));
    const [first, second] = container.querySelectorAll("time");
    expect(first.getAttribute("datetime")).toBe(value);
    expect(first.title).toContain("2026");
    expect([first.textContent, second.textContent]).toEqual(["Just now", "10 min ago"]);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect([first.textContent, second.textContent]).toEqual(["1 min ago", "11 min ago"]);
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
