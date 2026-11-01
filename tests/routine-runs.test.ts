import { botFixture } from "./helpers/runtime-fixtures.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { installAuth } from "../src/server/auth.js";
import { Store } from "../src/server/store.js";
import { installCollaborationRoutes } from "../src/server/collaboration.js";
import { fakeRuntime, signIn } from "./helpers/server.js";
import { errorHandler } from "../src/server/http-error.js";
import type { RoutineResult } from "../src/shared/collaboration.js";
import type { Routine } from "../src/shared/types.js";
import {
  deliveredRoutineName, deliveredRuns, placeRuns, routineRun, runStatusLabel, runsHidden, runsInWindow, runTone, withRunsShown,
  type RoutineRun,
} from "../src/shared/routine-runs.js";

const run = (id: string, startedAt: string | undefined, extra: Partial<RoutineRun> = {}): RoutineRun =>
  ({ id, routineId: "brief", routineName: "Morning brief", startedAt, status: "succeeded", previewOnly: false, ...extra });

describe("run status", () => {
  it("reads a missing or unfamiliar status as unknown and keeps a delivery failure apart", () => {
    const routine = { id: "brief", name: "Morning brief" };
    expect(routineRun(routine, { id: "a", title: "Run", previewOnly: false }).status).toBe("unknown");
    expect(routineRun(routine, { id: "b", title: "Run", previewOnly: false, status: "paused" as RoutineResult["status"] }).status).toBe("unknown");
    const undelivered = routineRun(routine, { id: "c", title: "Run", previewOnly: false, status: "succeeded", deliveryFailed: true });
    expect([runStatusLabel(undelivered), runTone(undelivered)]).toEqual(["Finished, not delivered", "warning"]);
    expect(runStatusLabel(run("d", undefined, { status: "failed", deliveryFailed: true }))).toBe("Failed");
    expect(runStatusLabel(run("e", undefined, { status: "unknown" }))).toBe("Status unknown");
  });
});

describe("the loaded window", () => {
  const runs = [run("old", "2026-10-01T07:00:00Z"), run("new", "2026-10-03T07:00:00Z"), run("undated", undefined),
    run("cert", "2026-10-03T08:00:00Z", { routineId: "cert" })];
  it("shows runs from the oldest loaded message on, and all runs once history reaches the start", () => {
    const shown = (window: Parameters<typeof runsInWindow>[1]) => runsInWindow(runs, window).map(run => run.id);
    expect(shown({ oldest: "2026-10-02T00:00:00Z", complete: false, hidden: () => false })).toEqual(["new", "cert"]);
    expect(shown({ oldest: "2026-10-02T00:00:00Z", complete: true, hidden: () => false })).toEqual(["old", "new", "cert"]);
    // Nothing dated is loaded yet, so no run can be placed beside it.
    expect(shown({ complete: false, hidden: () => false })).toEqual([]);
    expect(shown({ complete: true, hidden: id => id === "cert" })).toEqual(["old", "new"]);
  });
  it("hides and shows one routine per assistant without touching others", () => {
    const hidden = withRunsShown({ hiddenRoutineRuns: [{ botId: "ranch", routineId: "other" }] }, "ranch", "cert", false);
    expect(runsHidden(hidden, "ranch", "cert")).toBe(true);
    expect(runsHidden(hidden, "planner", "cert")).toBe(false);
    const shownAgain = withRunsShown(withRunsShown(hidden, "ranch", "cert", false), "ranch", "cert", true);
    expect(shownAgain.hiddenRoutineRuns).toEqual([{ botId: "ranch", routineId: "other" }]);
    expect(runsHidden({}, "ranch", "cert")).toBe(false);
  });
});

describe("placing runs among turns", () => {
  it("puts each run before the first turn that started after it, in time order", () => {
    const turns = ["2026-10-02T09:00:00Z", undefined, "2026-10-02T12:00:00Z"];
    const slots = placeRuns(turns, [run("late", "2026-10-02T13:00:00Z"), run("early", "2026-10-02T08:00:00Z"),
      run("between", "2026-10-02T10:00:00Z"), run("tie", "2026-10-02T12:00:00Z"), run("first", "2026-10-02T07:00:00Z")]);
    expect(slots.map(slot => slot.map(run => run.id))).toEqual([["first", "early"], [], ["between"], ["tie", "late"]]);
  });
  it("puts every run after a transcript with no dated turn", () => {
    expect(placeRuns([undefined], [run("a", "2026-10-02T07:00:00Z")]).map(slot => slot.length)).toEqual([0, 1]);
    expect(placeRuns([], [run("a", "2026-10-02T07:00:00Z")]).map(slot => slot.length)).toEqual([1]);
  });
});

describe("runs a delivery already shows", () => {
  it("reads the routine name from both Hermes delivery forms", () => {
    expect(deliveredRoutineName({ text: '[Cronjob "[bot:ranch] Morning Brief" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]\n\nRain' })).toBe("morning brief");
    expect(deliveredRoutineName({ text: "[Cron delivery: Morning brief]\nRain at noon" })).toBe("morning brief");
    expect(deliveredRoutineName({ text: "Morning brief" })).toBeUndefined();
  });
  it("lets each delivery claim the closest finished run of the routine it names", () => {
    const runs = [run("monday", "2026-10-05T07:00:00Z", { finishedAt: "2026-10-05T07:02:00Z" }),
      run("tuesday", "2026-10-06T07:00:00Z", { finishedAt: "2026-10-06T07:02:00Z" }),
      run("other", "2026-10-06T07:00:00Z", { routineId: "cert", routineName: "Certificates", finishedAt: "2026-10-06T07:00:30Z" }),
      run("by-id", "2026-10-06T09:00:00Z", { routineId: "job-7", routineName: "Renamed" })];
    const delivered = deliveredRuns(runs, [
      { text: "[Cron delivery: Morning brief]\nRain", createdAt: "2026-10-06T07:02:10Z" },
      { text: "[Cron delivery: Morning brief]\nSame again", createdAt: "2026-10-06T07:03:00Z" },
      { text: "[Cron delivery: job-7]\nDone", createdAt: "2026-10-06T09:00:05Z" },
      { text: "[Cron delivery: Morning brief]\nUndated" },
      // Too late to be Monday's: a delivery comes within half an hour of its run.
      { text: "[Cron delivery: Morning brief]\nLate", createdAt: "2026-10-05T09:00:00Z" },
    ]);
    // The second Tuesday message finds Tuesday taken, and Monday's run is a day earlier.
    expect([...delivered].sort()).toEqual(["by-id", "tuesday"]);
  });
});

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function fixture() {
  const app = Fastify(); apps.push(app); const store = new Store(":memory:");
  const origin = "https://routine-runs.invalid";
  await app.register(cookie);
  await installAuth(app, store, loadConfig({ NODE_ENV: "production", APP_ORIGIN: origin, GOOGLE_CLIENT_ID: "fixture", HOUSEHOLD_EMAILS: "one@example.invalid" }));
  app.setErrorHandler(errorHandler({ production: true }));
  const routine = (id: string, botId: string, name: string): Routine => ({ id, botId, name, prompt: "", schedule: "0 7 * * *", enabled: true });
  const routines = vi.fn(async () => [routine("brief", "ranch", "Morning brief"), routine("cert", "ranch", "Certificates"),
    routine("broken", "ranch", "Broken"), routine("secret", "private-bot", "Private")]);
  const results: Record<string, RoutineResult[]> = {
    brief: [{ id: "b2", title: "Run", startedAt: "2026-10-03T07:00:00.000Z", status: "succeeded", previewOnly: false, preview: "Rain" },
      { id: "b1", title: "Run", startedAt: "2026-10-01T07:00:00.000Z", previewOnly: false }],
    cert: [{ id: "c1", title: "Run", startedAt: "2026-10-02T07:00:00.000Z", status: "failed", error: "Expired", previewOnly: true },
      { id: "c0", title: "Undated", previewOnly: true }],
  };
  const routineResults = vi.fn(async (_botId: string, routineId: string) => {
    if (routineId === "broken") throw new Error("Hermes refused");
    return results[routineId] ?? [];
  });
  const runtime = fakeRuntime({ routines, routineResults, listBots: async () => [botFixture({ id: "ranch" }), botFixture({ id: "private-bot", shared: false, ownerId: "someone-else" })] });
  await installCollaborationRoutes(app, runtime, store);
  app.addHook("onClose", async () => store.close());
  return { app, routineResults, headers: signIn(store, origin, "one") };
}
describe("GET /api/bots/:botId/routine-runs", () => {
  it("lists a visible assistant's dated runs in time order with routine names and unread routines", async () => {
    const s = await fixture();
    const response = await s.app.inject({ url: "/api/bots/ranch/routine-runs", headers: s.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ unavailable: ["broken"], runs: [
      { id: "b1", routineId: "brief", routineName: "Morning brief", startedAt: "2026-10-01T07:00:00.000Z", status: "unknown", previewOnly: false },
      { id: "c1", routineId: "cert", routineName: "Certificates", startedAt: "2026-10-02T07:00:00.000Z", status: "failed", error: "Expired", previewOnly: true },
      { id: "b2", routineId: "brief", routineName: "Morning brief", startedAt: "2026-10-03T07:00:00.000Z", status: "succeeded", preview: "Rain", previewOnly: false },
    ] });
    // Only this assistant's routines are read.
    expect(s.routineResults.mock.calls.map(([botId, routineId]) => `${botId}/${routineId}`).sort()).toEqual(["ranch/brief", "ranch/broken", "ranch/cert"]);
  });
  it("returns only runs from the window's start and shares one read across quick polls", async () => {
    const s = await fixture();
    const ids = async (query: string) => (await s.app.inject({ url: `/api/bots/ranch/routine-runs${query}`, headers: s.headers })).json().runs.map((run: RoutineRun) => run.id);
    expect(await ids("?since=2026-10-02T07:00:00Z")).toEqual(["c1", "b2"]);
    expect(await ids("?since=2026-10-02T09:00:00%2B02:00")).toEqual(["c1", "b2"]);
    expect(await ids("?since=2026-10-04T00:00:00Z")).toEqual([]);
    expect(s.routineResults).toHaveBeenCalledTimes(3);
    expect((await s.app.inject({ url: "/api/bots/ranch/routine-runs?since=yesterday", headers: s.headers })).statusCode).toBe(400);
    expect((await s.app.inject({ url: "/api/bots/ranch/routine-runs?until=2026-10-02T07:00:00Z", headers: s.headers })).statusCode).toBe(400);
  });
  it("refuses someone else's personal assistant and a signed-out reader without reading Hermes", async () => {
    const s = await fixture();
    expect((await s.app.inject({ url: "/api/bots/private-bot/routine-runs", headers: s.headers })).statusCode).toBe(404);
    expect((await s.app.inject({ url: "/api/bots/missing/routine-runs", headers: s.headers })).statusCode).toBe(404);
    expect((await s.app.inject({ url: "/api/bots/ranch/routine-runs" })).statusCode).toBe(401);
    expect(s.routineResults).not.toHaveBeenCalled();
  });
});

describe("Show runs in chat preference", () => {
  it("saves per person, survives an older client's save, and rejects malformed entries", async () => {
    const { createApp } = await import("../src/server/app.js");
    const { defaultPreferences } = await import("../src/shared/types.js");
    const origin = "https://app.example.invalid";
    const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: origin, APP_DATABASE: ":memory:",
      GOOGLE_CLIENT_ID: "fixture-client", HOUSEHOLD_EMAILS: "one@example.invalid,two@example.invalid" });
    const { app, store } = await createApp(config, fakeRuntime({ close: async () => {} }), { background: false }); apps.push(app);
    const one = signIn(store, origin, "one");
    const hiddenRoutineRuns = [{ botId: "ranch", routineId: "cert" }];
    const patch = (payload: unknown) => app.inject({ method: "PATCH", url: "/api/preferences", headers: one, payload });
    expect((await patch({ ...defaultPreferences, hiddenRoutineRuns })).json().hiddenRoutineRuns).toEqual(hiddenRoutineRuns);
    // An app that predates the setting sends preferences without it.
    expect((await patch({ ...defaultPreferences, theme: "dark" })).statusCode).toBe(200);
    expect(store.preferences("one")).toMatchObject({ theme: "dark", hiddenRoutineRuns });
    expect(store.preferences("two").hiddenRoutineRuns).toBeUndefined();
    expect((await patch({ ...defaultPreferences, hiddenRoutineRuns: [] })).json().hiddenRoutineRuns).toEqual([]);
    expect((await patch({ ...defaultPreferences, hiddenRoutineRuns: [{ botId: "ranch" }] })).statusCode).toBe(400);
  });
});
