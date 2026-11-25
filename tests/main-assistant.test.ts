import { expect, it } from "vitest";
import { isSilentAnswer, scheduleMinutes, validCheckInHours } from "../src/shared/main-assistant";

it.each([
  ["[SILENT]", true],
  ["  silent. ", true],
  ["Nothing new.\n[SILENT]", true],
  ["NO_REPLY\nall clear", true],
  ["[SILENT] No changes", true],
  ["", false],
  ["Silent retry succeeded on the NAS.", false],
  ["Your call said [SILENT] mid-sentence, oddly.", false],
  ["No reply from the plumber yet.", false],
])("reads %j as silent: %s", (text, silent) => expect(isSilentAnswer(text)).toBe(silent));

it("reads interval displays in minutes and rejects anything else", () => {
  expect([
    scheduleMinutes("every 120m"),
    scheduleMinutes("every 2h"),
    scheduleMinutes("90m"),
  ]).toEqual([120, 120, 90]);
  expect(scheduleMinutes("0 7 * * *")).toBeNaN();
});

it("accepts only whole hours from 1 to 4", () => {
  expect([1, 4].every(validCheckInHours)).toBe(true);
  expect([0, 5, 1.5, "2", null].some(validCheckInHours)).toBe(false);
});
