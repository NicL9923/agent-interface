import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { nativeOverrides } from "../src/server/hermes";
import { isSilentAnswer, scheduleMinutes, validCheckInHours } from "../src/shared/main-assistant";

// Mirrors Hermes's is_autonomous_silence_response for an add-on too old to drop silent answers itself.
it.each([
  ["[SILENT]", true], ["  silent. ", true], ["Nothing new.\n[SILENT]", true], ["NO_REPLY\nall clear", true], ["[SILENT] No changes", true],
  ["", false], ["Silent retry succeeded on the NAS.", false], ["Your call said [SILENT] mid-sentence, oddly.", false], ["No reply from the plumber yet.", false],
])("reads %j as silent: %s", (text, silent) => expect(isSilentAnswer(text)).toBe(silent));

it("reads Hermes's interval display back in minutes and rejects anything else", () => {
  expect([scheduleMinutes("every 120m"), scheduleMinutes("every 2h"), scheduleMinutes("90m")]).toEqual([120, 120, 90]);
  expect(scheduleMinutes("0 7 * * *")).toBeNaN();
});

it("accepts only whole hours from 1 to 4", () => {
  expect([1, 4].every(validCheckInHours)).toBe(true);
  expect([0, 5, 1.5, "2", null].some(validCheckInHours)).toBe(false);
});

// A job as Hermes ed1afb0's real scheduler left it, mid-run and after completing: see the fixture's source.
const scheduled = JSON.parse(readFileSync(new URL("./fixtures/hermes-ed1afb0-scheduled-job.json", import.meta.url), "utf8")) as
  Record<"running" | "completed", Record<string, unknown>> & { failures: Record<string, Record<string, unknown>> };

it("counts the scheduler's own bookkeeping, mid-run or after, as no override", () => {
  expect(nativeOverrides(scheduled.running)).toEqual([]);
  expect(nativeOverrides(scheduled.completed)).toEqual([]);
});

it("counts a provider-failure retry, a quota hold and their recoveries as bookkeeping too", () => {
  for (const [state, job] of Object.entries(scheduled.failures)) expect(nativeOverrides(job), state).toEqual([]);
  // The fixture really holds those states, so this can fail.
  const fields = new Set(Object.values(scheduled.failures).flatMap(job => Object.keys(job)));
  for (const field of ["unreachable_retry", "quota_hold_until", "quota_hold_cron_expr"]) expect(fields.has(field), field).toBe(true);
});

it("names every set native field that changes how a job runs", () => {
  expect(nativeOverrides({ ...scheduled.completed, monitor_script: "watch.sh", workdir: "/tmp", base_url: "https://x", skill: "leak", interpreter: "python3", repeat: { times: 3, completed: 0 } }))
    .toEqual(["base_url", "interpreter", "monitor_script", "repeat", "skill", "workdir"]);
  // A setting a later Hermes adds counts until the app knows it.
  expect(nativeOverrides({ ...scheduled.completed, attach_to_session: "sess-1" })).toEqual(["attach_to_session"]);
});
