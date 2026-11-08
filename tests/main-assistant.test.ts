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

// A job exactly as Hermes ed1afb0's cron.jobs.list_jobs returns one the app created (fields from a real run).
const nativeJob = { id: "3ec411d64c8c", name: "[bot:x] Check-ins", prompt: "hi", skills: [], skill: null, model: null, provider: null, base_url: null,
  script: null, no_agent: false, monitor_script: null, monitor_url: null, monitor_state: null, context_from: ["self"],
  schedule: { kind: "interval", minutes: 120, display: "every 120m" }, schedule_display: "every 120m", repeat: { times: null, completed: 0 },
  enabled: true, state: "scheduled", paused_at: null, paused_reason: null, created_at: "2026-11-08T09:19:23-06:00", next_run_at: "2026-11-08T11:19:23-06:00",
  last_run_at: null, last_status: null, last_error: null, last_delivery_error: null, last_delivery_unverified: null, last_failure: null, failure_streak: 0,
  deliver: "bot-chat:x", origin: null, enabled_toolsets: null, workdir: null, latest_execution: null, live_execution: null };

it("finds no native override on a job the app created, and names every one that changes how a job runs", () => {
  expect(nativeOverrides(nativeJob)).toEqual([]);
  expect(nativeOverrides({ ...nativeJob, monitor_script: "watch.sh", workdir: "/tmp", base_url: "https://x", skill: "leak", repeat: { times: 3, completed: 0 } }))
    .toEqual(["base_url", "monitor_script", "repeat", "skill", "workdir"]);
  // A setting a later Hermes adds counts until the app knows it.
  expect(nativeOverrides({ ...nativeJob, attach_to_session: "sess-1" })).toEqual(["attach_to_session"]);
});
