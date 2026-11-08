import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig, type Config } from "../src/server/config.js";
import { checkInMarker, checkInPrompt, MainAssistants, ReconcileError, signedCheckInMember } from "../src/server/main-assistant.js";
import type { Bot, DelegationPolicies, Routine, Runtime, RuntimeEvent } from "../src/shared/types.js";
import { fakeRuntime, signIn } from "./helpers/server.js";
import { botFixture, capabilitiesFixture } from "./helpers/runtime-fixtures.js";
import type { RoutineRunStatus } from "../src/shared/routine-runs.js";
import { nativeOverrides } from "../src/server/hermes.js";
import { readFileSync } from "node:fs";

// A job as Hermes ed1afb0's real scheduler left it, mid-run and after completing.
const scheduled = JSON.parse(readFileSync(new URL("./fixtures/hermes-ed1afb0-scheduled-job.json", import.meta.url), "utf8")) as
  Record<"running" | "completed", Record<string, unknown>> & { failures: Record<string, Record<string, unknown>> };

// A member's main assistant and its check-ins, through the real app with an in-memory Hermes cron
// store. Every path that changes what a member wants, or what they may have, must leave Hermes with
// zero or one check-in job for them: never an orphan, never a duplicate.
const origin = "http://127.0.0.1:3000";
type Created = Awaited<ReturnType<typeof createApp>>;
let created: Created;
let config: Config;
let jobs: Routine[];
let calls: string[];
let bots: Bot[];
let pushed: DelegationPolicies[];
let fail: { create?: "refused" | "uncertain"; delete?: boolean; update?: boolean; status?: boolean; pause?: boolean; policy?: boolean; routines?: boolean; stop?: boolean; held?: boolean };
let held: Record<string, { id: string; name: string }[]>;
let enforcing: number;
let runtime: Runtime;
let holdRoutines: Promise<void> | undefined;
let holdBots: Promise<void> | undefined;
let holdPolicy: Promise<void> | undefined;
let applied: DelegationPolicies[];
let discovered: RuntimeEvent[];
let routinesSupported: boolean;
let nextId: number;
let mom: Record<string, string>, dad: Record<string, string>;
let results: Record<string, { id: string; status: RoutineRunStatus; startedAt: string; error?: string }[]>;

beforeEach(async () => {
  held = {}; enforcing = 2;
  jobs = []; calls = []; pushed = []; fail = {}; discovered = []; holdRoutines = undefined; holdBots = undefined; holdPolicy = undefined; applied = []; routinesSupported = true; nextId = 1; results = {};
  bots = [
    botFixture({ id: "mom-main", name: "Sage", description: "Mom's chief of staff", shared: false, ownerId: "mom" }),
    botFixture({ id: "mom-notes", name: "Notes", shared: false, ownerId: "mom" }),
    botFixture({ id: "ranch", name: "Ranch Hand", description: "Runs the ranch" }),
    botFixture({ id: "legacy", name: "Legacy", shared: false }),
    botFixture({ id: "dad-diary", name: "Diary", shared: false, ownerId: "dad" }),
  ];
  runtime = fakeRuntime({
    status: async () => fail.status ? { connected: false } : { connected: true },
    capabilities: async () => capabilitiesFixture({ routines: { supported: routinesSupported }, botConfiguration: { supported: true }, durableEvents: { supported: true } }),
    // Holds one roster read back, as a slow Hermes would.
    listBots: async () => { if (holdBots) { const wait = holdBots; holdBots = undefined; await wait; } return structuredClone(bots); },
    routines: async () => {
      if (fail.routines) throw new Error("Hermes routines unavailable.");
      // Holds one read back, as a slow Hermes would, then answers with the jobs as they are by then.
      if (holdRoutines) { const wait = holdRoutines; holdRoutines = undefined; await wait; }
      return structuredClone(jobs);
    },
    // Cursor-based like the add-on: events after a cursor come back until the cursor moves past them.
    discoverEvents: async cursor => cursor === "" && discovered.length ? { cursor: "c1", events: structuredClone(discovered) } : { cursor, events: [] },
    // Hermes stores "every 2h" as an interval and shows it back in minutes.
    saveRoutine: async (input, id) => {
      calls.push(id ? `update:${id}` : `create:${input.botId}`);
      if (!id && fail.create === "refused") throw new Error("Hermes refused the routine.");
      if (id && fail.update) throw new Error("Hermes refused the update.");
      const hours = /^every (\d+)h$/.exec(input.schedule)?.[1];
      // A new job delivers to its own assistant's chat, as Hermes records the app's create.
      const saved: Routine = { ...input, id: id ?? `job${nextId++}`, schedule: hours ? `every ${Number(hours) * 60}m` : input.schedule,
        ...(!id ? { delivery: { deliver: `bot-chat:${input.botId}` }, contextFrom: ["self"], nativeOverrides: [] } : {}) };
      if (id) jobs = jobs.map(job => job.id === id && job.botId === input.botId ? { ...job, ...saved } : job);
      else jobs.push(saved);
      if (!id && fail.create === "uncertain") throw new Error("Hermes response lost.");
      return saved;
    },
    deleteRoutine: async (id, botId) => {
      calls.push(`delete:${id}`);
      if (fail.delete) throw new Error("Hermes refused the deletion.");
      jobs = jobs.filter(job => !(job.id === id && job.botId === botId));
    },
    setRoutineEnabled: async (botId, id, enabled) => {
      calls.push(`pause:${id}`);
      if (fail.pause) throw new Error("Hermes refused the pause.");
      jobs = jobs.map(job => job.id === id && job.botId === botId ? { ...job, enabled } : job);
    },
    // With fail.stop, Hermes answers but the run goes on, as when cancellation hasn't reached it yet.
    stopRoutineRun: async (botId, id) => { calls.push(`stop:${id}`); if (!fail.stop) jobs = jobs.map(job => job.id === id && job.botId === botId ? { ...job, running: false } : job); return true; },
    routineResults: async (_botId, routineId) => (results[routineId] ?? []).map(run => ({ ...run, title: "Run", previewOnly: true })),
    // `applied` is the order Hermes takes rosters in; holdPolicy keeps one send in flight, as a slow Hermes would.
    delegationPolicy: async policies => {
      calls.push("policy"); if (fail.policy) throw new Error("Hermes refused the roster."); pushed.push(structuredClone(policies));
      if (holdPolicy) { const wait = holdPolicy; holdPolicy = undefined; await wait; }
      applied.push(structuredClone(policies));
      return enforcing;
    },
    // The routine results Hermes still holds for delivery, by assistant; `fail.held` makes them unreadable.
    routineDeliveries: async botId => { if (fail.held) throw new Error("Hermes delivery queue unreadable."); return structuredClone(held[botId] ?? []); },
    saveBot: async (input, id) => { calls.push(`saveBot:${id}`); const bot = { ...bots.find(row => row.id === id)!, ...input }; bots = bots.map(row => row.id === id ? bot : row); return bot; },
    deleteBot: async id => { calls.push(`deleteBot:${id}`); bots = bots.filter(bot => bot.id !== id); jobs = jobs.filter(job => job.botId !== id); },
    close: async () => {},
  });
  config = loadConfig({ APP_ORIGIN: origin, APP_DATABASE: ":memory:", HOUSEHOLD_EMAILS: "mom@example.test,dad@example.test" });
  created = await createApp(config, runtime, { background: false });
  mom = signIn(created.store, origin, "mom", { email: "mom@example.test" });
  dad = signIn(created.store, origin, "dad", { email: "dad@example.test" });
  created.store.user({ id: "mom", name: "Mom", email: "mom@example.test" });
  for (const bot of bots) if (bot.ownerId || bot.shared === false) created.store.savePresentation(bot.id, { shared: bot.shared, ownerId: bot.ownerId });
  // As the server's start does: until a first inventory, every personal assistant is held to a main assistant's limits.
  await created.mains.reconcile();
  calls = []; pushed = []; applied = [];
});
afterEach(async () => { await created?.app.close(); });

const put = (url: string, payload: unknown, headers = mom) => created.app.inject({ method: "PUT", url: `/api${url}`, headers, payload: payload as object });
const main = (botId: string | null, headers = mom) => put("/preferences/main", { botId }, headers);
const checkIns = (settings: Partial<{ enabled: boolean; everyHours: number; timezone: string }> = {}, headers = mom) =>
  put("/preferences/check-ins", { enabled: true, everyHours: 2, timezone: "America/Chicago", ...settings }, headers);
const prefs = (userId = "mom") => created.store.preferences(userId);
const momJobs = () => jobs.filter(job => signedCheckInMember(created.store, job) === "mom");

describe("choosing a main assistant", () => {
  it("takes only the member's own personal assistant, and says why another can't be", async () => {
    expect((await main("mom-main")).json().mainBotId).toBe("mom-main");
    const shared = await main("ranch");
    expect(shared.statusCode).toBe(409);
    expect(shared.json()).toMatchObject({ code: "main_not_personal", error: expect.stringContaining("Shared with the household") });
    expect((await main("legacy")).json()).toMatchObject({ code: "main_not_personal", error: expect.stringContaining("no recorded owner") });
    // Another member's personal assistant does not exist for Mom, and neither does a made-up one.
    expect((await main("dad-diary")).statusCode).toBe(404);
    expect((await main("nobody")).statusCode).toBe(404);
    expect(prefs().mainBotId).toBe("mom-main");
  });
  it("refuses a malformed request, and clears only on an explicit null", async () => {
    await main("mom-main");
    for (const payload of [{}, { botId: "" }, { botId: 3 }, { botId: "mom-main", extra: true }])
      expect((await put("/preferences/main", payload)).statusCode).toBe(400);
    expect(prefs().mainBotId).toBe("mom-main");
    expect((await main(null)).json().mainBotId).toBeUndefined();
    expect(prefs().mainBotId).toBeUndefined();
  });
  it("is never changed or cleared by a preferences save, from an older client or a stale copy", async () => {
    await main("mom-main");
    await checkIns();
    const { mainBotId: _, checkIns: __, ...older } = prefs();
    const saved = await created.app.inject({ method: "PATCH", url: "/api/preferences", headers: mom, payload: { ...older, theme: "dark" } });
    expect(saved.json()).toMatchObject({ theme: "dark", mainBotId: "mom-main", checkIns: { enabled: true } });
    const stale = await created.app.inject({ method: "PATCH", url: "/api/preferences", headers: mom,
      payload: { ...older, mainBotId: "mom-notes", checkIns: { enabled: false, everyHours: 4, timezone: "UTC" } } });
    expect(stale.json()).toMatchObject({ mainBotId: "mom-main", checkIns: { enabled: true, everyHours: 2 } });
    expect(momJobs()).toHaveLength(1);
  });
  it("keeps a dismissed suggestion dismissed when a client that doesn't know it saves", async () => {
    const { mainBotId: _, ...value } = prefs();
    await created.app.inject({ method: "PATCH", url: "/api/preferences", headers: mom, payload: { ...value, mainSuggestionDismissed: true } });
    await created.app.inject({ method: "PATCH", url: "/api/preferences", headers: mom, payload: value });
    expect(prefs().mainSuggestionDismissed).toBe(true);
  });
});

describe("check-ins", () => {
  beforeEach(async () => { await main("mom-main"); });
  it("creates one quiet, member-only routine on the main assistant", async () => {
    const response = await checkIns();
    expect(response.json().checkIns).toEqual({ enabled: true, everyHours: 2, timezone: "America/Chicago" });
    expect(momJobs()).toHaveLength(1);
    const [job] = momJobs();
    expect(job).toMatchObject({ botId: "mom-main", name: "Check-ins", schedule: "every 120m", enabled: true });
    // The member's timezone, the night rule and Hermes's silent marker are in the instructions.
    expect(job.prompt).toContain("Mom's timezone is America/Chicago");
    expect(job.prompt).toContain("between 10 PM and 7 AM");
    expect(job.prompt).toContain("reply with exactly [SILENT] and nothing else");
    expect(created.store.getRoutineRecipients("mom-main", job.id)).toEqual(["mom"]);
  });
  it("changes the frequency in place and removes the routine when turned off", async () => {
    await checkIns();
    const [{ id }] = momJobs();
    await checkIns({ everyHours: 4 });
    expect(calls).toContain(`update:${id}`);
    expect(momJobs()).toMatchObject([{ id, schedule: "every 240m" }]);
    expect((await checkIns({ enabled: false })).json().checkIns.enabled).toBe(false);
    expect(momJobs()).toEqual([]);
  });
  it("refuses frequencies outside 1 to 4 whole hours, a bad timezone, and turning on without a main assistant", async () => {
    for (const everyHours of [0, 5, 2.5, -1]) expect((await checkIns({ everyHours })).json().code).toBe("check_in_hours");
    expect((await checkIns({ timezone: "Mars/Olympus" })).statusCode).toBe(400);
    expect((await put("/preferences/check-ins", { enabled: true, everyHours: 2 })).statusCode).toBe(400);
    expect((await checkIns({}, dad)).json().code).toBe("main_required");
    expect(jobs).toEqual([]);
  });
  it("is unavailable on a Hermes without routines", async () => {
    routinesSupported = false;
    expect((await checkIns()).statusCode).toBe(409);
    expect(prefs().checkIns).toBeUndefined();
  });
  it("turns the switch back off when Hermes refuses to create the routine", async () => {
    fail.create = "refused";
    const response = await checkIns();
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe("check_in_unavailable");
    expect(response.json().preferences).toMatchObject({ checkIns: { enabled: false } });
    expect(prefs().checkIns?.enabled).toBe(false);
    expect(jobs).toEqual([]);
  });
  it("keeps the new frequency and says Hermes hasn't caught up when it refuses the update", async () => {
    await checkIns();
    fail.update = true;
    const response = await checkIns({ everyHours: 3 });
    expect(response.json()).toMatchObject({ code: "check_in_unavailable", preferences: { checkIns: { enabled: true, everyHours: 3 } } });
    expect(momJobs()[0].schedule).toBe("every 120m");
  });
  it("removes a routine Hermes created after all when the create looked failed", async () => {
    fail.create = "uncertain";
    expect((await checkIns()).statusCode).toBe(200);
    // The answer was lost but the job exists and carries the member's marker, so it is adopted.
    expect(momJobs()).toHaveLength(1);
    expect(created.store.checkIns.current()).toMatchObject([{ userId: "mom", botId: "mom-main", jobId: momJobs()[0].id }]);
  });
  it("keeps trying to remove a routine Hermes would not delete, and never makes a second", async () => {
    await checkIns();
    fail.delete = true;
    const off = await checkIns({ enabled: false });
    expect(off.json().code).toBe("check_in_removal_pending");
    expect(off.json().preferences).toMatchObject({ mainBotId: "mom-main", checkIns: { enabled: false } });
    expect(prefs().checkIns?.enabled).toBe(false);
    expect(momJobs()).toHaveLength(1);
    fail.delete = false;
    await created.mains.reconcile();
    expect(momJobs()).toEqual([]);
    expect(created.store.checkIns.current()).toEqual([]);
  });
  it("ends with one routine, or none, however toggles race", async () => {
    await Promise.all([checkIns(), checkIns({ enabled: false }), checkIns(), checkIns({ everyHours: 3 })]);
    expect(momJobs()).toHaveLength(1);
    expect(momJobs()[0].schedule).toBe("every 180m");
    await Promise.all([checkIns({ enabled: false }), checkIns(), checkIns({ enabled: false })]);
    expect(momJobs()).toEqual([]);
  });
  it("stops a run in progress before deleting the routine", async () => {
    await checkIns();
    jobs = jobs.map(job => ({ ...job, running: true }));
    await checkIns({ enabled: false });
    const id = created.store.db.prepare("SELECT job_id FROM check_in_jobs").get() as { job_id: string };
    expect(calls.slice(-2)).toEqual([`stop:${id.job_id}`, `delete:${id.job_id}`]);
  });
  it("moves off the old main assistant when the main assistant changes", async () => {
    await checkIns();
    const response = await main("mom-notes");
    expect(response.json()).toMatchObject({ mainBotId: "mom-notes", checkIns: { enabled: false } });
    expect(momJobs()).toEqual([]);
    expect((await checkIns()).statusCode).toBe(200);
    expect(momJobs()).toMatchObject([{ botId: "mom-notes" }]);
  });
  it("asks before sharing the main assistant, then ends check-ins before anyone else can read its chat", async () => {
    await checkIns();
    const share = (confirm?: boolean) => created.app.inject({ method: "PATCH", url: "/api/bots/mom-main", headers: mom,
      payload: { name: "Sage", instructions: "", model: "test", shared: true, ...(confirm ? { confirmMainCleared: true } : {}) } });
    const refused = await share();
    expect(refused.json()).toMatchObject({ code: "main_share_confirmation_required", error: expect.stringContaining("turns off its check-ins") });
    expect(prefs().mainBotId).toBe("mom-main");
    expect(calls).not.toContain("saveBot:mom-main");
    expect((await share(true)).statusCode).toBe(200);
    expect(calls.indexOf(`delete:${created.store.db.prepare("SELECT job_id FROM check_in_jobs").get()!.job_id}`)).toBeLessThan(calls.indexOf("saveBot:mom-main"));
    expect(prefs().mainBotId).toBeUndefined();
    expect(prefs().checkIns?.enabled).toBe(false);
    expect(jobs).toEqual([]);
  });
  it("keeps the assistant personal when Hermes won't remove its check-ins first", async () => {
    await checkIns();
    fail.delete = true;
    const response = await created.app.inject({ method: "PATCH", url: "/api/bots/mom-main", headers: mom,
      payload: { name: "Sage", instructions: "", model: "test", shared: true, confirmMainCleared: true } });
    expect(response.json().code).toBe("check_in_removal_pending");
    expect(created.store.presentation("mom-main")).toMatchObject({ shared: false, ownerId: "mom" });
    // Sharing ended it being main before Hermes refused, and the error says so, so a client shows it.
    expect(response.json().preferences).toMatchObject({ checkIns: { enabled: false } });
    expect(response.json().preferences).not.toHaveProperty("mainBotId");
  });
  it("clears the main assistant and its routine when the assistant is deleted", async () => {
    await checkIns();
    expect((await created.app.inject({ method: "DELETE", url: "/api/bots/mom-main", headers: mom })).statusCode).toBe(200);
    expect(prefs().mainBotId).toBeUndefined();
    expect(prefs().checkIns?.enabled).toBe(false);
    await created.mains.reconcile();
    expect(jobs).toEqual([]);
    expect(created.store.checkIns.current()).toEqual([]);
  });
  it("removes the routine of a member who left the household, and keeps what they chose", async () => {
    await checkIns();
    config.householdEmails.splice(config.householdEmails.indexOf("mom@example.test"), 1);
    await created.mains.reconcile();
    expect(jobs).toEqual([]);
    expect(prefs().mainBotId).toBe("mom-main");
  });
  it("ends being main when the assistant is no longer the member's own, however that happened", async () => {
    await checkIns();
    // As if changed outside this app: the assistant became shared.
    created.store.savePresentation("mom-main", { shared: true });
    expect((await created.app.inject({ url: "/api/bootstrap", headers: mom })).json().preferences).toMatchObject({ checkIns: { enabled: false } });
    await created.mains.reconcile();
    expect(prefs().mainBotId).toBeUndefined();
    expect(jobs).toEqual([]);
  });
  it("finds lost and duplicate check-ins at startup and keeps only the one it made", async () => {
    await checkIns();
    const [kept] = momJobs();
    // A copy Hermes made after an answer was lost, another member's left behind on a deleted main, and an unrelated routine.
    jobs.push({ ...kept, id: "copy" }, { ...kept, id: "stray", botId: "ranch", prompt: `${checkInMarker(created.store, "ranch", "dad")}\n\nOld`, delivery: { deliver: "bot-chat:ranch" }, nativeOverrides: [] },
      { id: "brief", botId: "mom-main", name: "Brief", prompt: "Morning brief", schedule: "0 7 * * *", enabled: true });
    await created.mains.reconcile();
    expect(jobs.map(job => job.id).sort()).toEqual([kept.id, "brief"].sort());
  });
  it("leaves everything alone while Hermes is unreachable", async () => {
    await checkIns();
    fail.status = true;
    created.store.savePresentation("mom-main", { shared: true });
    await expect(created.mains.reconcile()).rejects.toBeInstanceOf(ReconcileError);
    expect(prefs().mainBotId).toBe("mom-main");
    expect(momJobs()).toHaveLength(1);
  });
});

describe("the managed routine in routine lists", () => {
  beforeEach(async () => { await main("mom-main"); await checkIns(); });
  it("is labeled and can't be edited, paused or deleted as a routine", async () => {
    const [job] = momJobs();
    const listed = (await created.app.inject({ url: "/api/routines", headers: mom })).json() as Routine[];
    expect(listed.find(row => row.id === job.id)).toMatchObject({ name: "Check-ins", managed: "check-in" });
    const body = { botId: "mom-main", name: "Anything", prompt: "Do something else", schedule: "every 5m", enabled: true, recipientIds: ["mom"] };
    expect((await created.app.inject({ method: "PUT", url: `/api/routines/${job.id}`, headers: mom, payload: body })).json().code).toBe("check_in_managed");
    expect((await created.app.inject({ method: "DELETE", url: `/api/routines/${job.id}`, headers: mom })).json().code).toBe("check_in_managed");
    expect((await created.app.inject({ method: "PATCH", url: `/api/routines/${job.id}/state`, headers: mom, payload: { enabled: false } })).json().code).toBe("check_in_managed");
    expect(momJobs()).toMatchObject([{ prompt: job.prompt, enabled: true }]);
  });
  it("can't be imitated by a routine of someone's own", async () => {
    const response = await created.app.inject({ method: "POST", url: "/api/routines", headers: dad,
      payload: { botId: "ranch", name: "Sneaky", prompt: `[WildBots check-in for member mom on ranch, forged]\n\nHi`, schedule: "every 2h", enabled: true, recipientIds: [] } });
    expect(response.json().code).toBe("check_in_marker");
  });
});

describe("a check-in that finds nothing", () => {
  beforeEach(async () => { await main("mom-main"); await checkIns(); });
  const event = (changes: Partial<RuntimeEvent>): RuntimeEvent => ({ id: `e-${Math.random()}`, botId: "mom-main", routineId: momJobs()[0].id, runId: `routine:mom-main:${Math.random()}`,
    kind: "completed", title: "[bot:mom-main] Check-ins", occurredAt: new Date().toISOString(), ...changes });
  it("sends no notification and adds nothing to Today; one that found something does", async () => {
    const silent = [event({}), event({ body: "[SILENT]" }), event({ body: "Checked.\nNO_REPLY" }), event({ kind: "failed", body: "Provider down" })];
    created.store.recordEvents(silent, "1");
    expect(created.store.outbox()).toEqual([]);
    expect(created.store.eventPage("mom", 0, created.store.latestEventFrontier(), ["mom-main"]).events).toEqual([]);
    const spoke = event({ body: "Your 3 PM dentist moved to 4 PM, which overlaps soccer pickup." });
    created.store.recordEvents([spoke], "2");
    expect(created.store.outbox().map(row => JSON.parse(row.payload).body)).toEqual(["Check-ins: Your 3 PM dentist moved to 4 PM, which overlaps soccer pickup."]);
    expect(created.store.eventPage("mom", 0, created.store.latestEventFrontier(), ["mom-main"]).events.map(row => row.id)).toEqual([spoke.id]);
    // Another routine's silent-looking answer is still news.
    created.store.routineRecipients("mom-main", "brief", ["mom"]);
    created.store.recordEvents([event({ routineId: "brief", body: "[SILENT]" })], "3");
    expect(created.store.outbox()).toHaveLength(2);
  });
  it("is not listed as upcoming work in Today, unlike other routines", async () => {
    jobs = jobs.map(job => ({ ...job, nextRunAt: "2026-11-08T18:00:00Z" }));
    jobs.push({ id: "brief", botId: "mom-main", name: "Brief", prompt: "Morning brief", schedule: "0 7 * * *", enabled: true, nextRunAt: "2026-11-09T07:00:00Z" });
    const today = (await created.app.inject({ url: "/api/today", headers: mom })).json();
    expect(today.upcoming.map((row: Routine) => row.id)).toEqual(["brief"]);
  });
  it("shows only a failed check-in as a run card in the chat", async () => {
    const id = momJobs()[0].id;
    results[id] = [{ id: "r1", status: "succeeded", startedAt: "2026-11-07T10:00:00Z" }, { id: "r2", status: "failed", error: "Provider down", startedAt: "2026-11-07T12:00:00Z" },
      { id: "r3", status: "running", startedAt: "2026-11-07T14:00:00Z" }];
    jobs.push({ id: "brief", botId: "mom-main", name: "Brief", prompt: "Morning brief", schedule: "0 7 * * *", enabled: true });
    results.brief = [{ id: "b1", status: "succeeded", startedAt: "2026-11-07T07:00:00Z" }];
    const page = (await created.app.inject({ url: "/api/bots/mom-main/routine-runs", headers: mom })).json();
    expect(page.runs.map((run: { id: string }) => run.id)).toEqual(["b1", "r2"]);
  });
});

describe("every assistant's roster", () => {
  const ids = (list: { id: string }[]) => list.map(row => row.id);
  it("lists a member's own personal assistants and the household's, never another member's", async () => {
    await main("mom-main");
    const policies = pushed.at(-1)!;
    expect(policies["mom-main"]).toEqual({ member: "Mom", main: true, owned: true,
      personal: [{ id: "mom-notes", name: "Notes" }],
      shared: [{ id: "ranch", name: "Ranch Hand", description: "Runs the ranch" }, { id: "legacy", name: "Legacy" }] });
    // Mom's other personal assistant is not her main one, so it needs no yes for shared ones, but still never sees Dad's.
    expect(policies["mom-notes"]).toMatchObject({ main: false, owned: true });
    expect(ids(policies["mom-notes"].personal)).toEqual(["mom-main"]);
    expect(ids(policies["dad-diary"].personal)).toEqual([]);
    expect(ids(policies["dad-diary"].shared)).toEqual(["ranch", "legacy"]);
    // A shared assistant, and an ownerless one, see only what the whole household sees.
    expect(policies.ranch).toEqual({ member: "the household", main: false, owned: false, personal: [], shared: [{ id: "legacy", name: "Legacy" }] });
    expect(ids(policies.legacy.shared)).toEqual(["ranch"]);
  });
  it("gives an assistant whose owner left the household nobody to reach", async () => {
    config.householdEmails.splice(config.householdEmails.indexOf("dad@example.test"), 1);
    await created.mains.reconcile();
    expect(pushed.at(-1)!["dad-diary"]).toMatchObject({ personal: [], shared: [] });
  });
  it("follows a rename and a cleared main assistant on the next pass", async () => {
    await main("mom-main");
    await created.app.inject({ method: "PATCH", url: "/api/bots/ranch", headers: mom, payload: { name: "Foreman", instructions: "", model: "test", shared: true } });
    await created.mains.reconcile();
    expect(pushed.at(-1)!["mom-main"].shared[0]).toMatchObject({ id: "ranch", name: "Foreman" });
    await main(null);
    expect(pushed.at(-1)!["mom-main"].main).toBe(false);
  });
  it("stops listing an assistant whose sharing changes before the change, and refuses it when Hermes won't take that", async () => {
    await main("mom-main");
    pushed.length = 0; calls.length = 0;
    const share = () => created.app.inject({ method: "PATCH", url: "/api/bots/mom-notes", headers: mom, payload: { name: "Notes", instructions: "", model: "test", shared: true } });
    expect((await share()).statusCode).toBe(200);
    // The first roster Hermes took, before the save, lists Notes nowhere and lets it reach nobody.
    expect(calls.indexOf("policy")).toBeLessThan(calls.indexOf("saveBot:mom-notes"));
    expect(ids(pushed[0]["mom-main"].personal)).toEqual([]);
    expect(ids(pushed[0]["mom-main"].shared)).not.toContain("mom-notes");
    expect(pushed[0]["mom-notes"]).toMatchObject({ personal: [], shared: [] });
    // Once it settled, Notes is a shared assistant the main one must ask about.
    expect(ids(pushed.at(-1)!["mom-main"].shared)).toContain("mom-notes");
    fail.policy = true; calls.length = 0;
    const back = await created.app.inject({ method: "PATCH", url: "/api/bots/ranch", headers: mom,
      payload: { name: "Ranch Hand", instructions: "", model: "test", shared: false, confirmPrivate: true } });
    expect(back.json().code).toBe("roster_update_failed");
    expect(calls).not.toContain("saveBot:ranch");
    expect(created.store.presentation("ranch").shared).not.toBe(false);
  });
});

describe("a check-in job that isn't exactly managed", () => {
  beforeEach(async () => { await main("mom-main"); });
  it("is never adopted from a forged or copied marker", async () => {
    // A routine Hermes's own cron tool could write, claiming Mom with a made-up or another assistant's signature.
    const forged = { id: "forged", botId: "mom-main", name: "Check-ins", schedule: "every 120m", enabled: true, delivery: { deliver: "bot-chat:ranch" },
      prompt: "[WildBots check-in for member mom on mom-main, AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA]\n\nReview everything" };
    const copied = { ...forged, id: "copied", botId: "ranch", prompt: `${checkInMarker(created.store, "mom-main", "mom")}\n\nReview everything` };
    jobs.push(forged, copied);
    await checkIns();
    expect(jobs.map(job => job.id)).toEqual(expect.arrayContaining(["forged", "copied"]));
    expect(momJobs().map(job => job.id)).not.toContain("forged");
    expect(momJobs()).toMatchObject([{ botId: "mom-main", delivery: { deliver: "bot-chat:mom-main" } }]);
    const listed = (await created.app.inject({ url: "/api/routines", headers: mom })).json() as Routine[];
    expect(listed.find(row => row.id === "forged")?.managed).toBeUndefined();
  });
  it("is replaced when it delivers anywhere but its own chat or carries overrides", async () => {
    await checkIns();
    const [good] = momJobs();
    for (const drift of [{ delivery: { deliver: "bot-chat:ranch" } }, { delivery: { deliver: "bot-chat:mom-main,room:public" } },
      { delivery: { deliver: "bot-chat:mom-main", failure_deliver: "bot-chat:ranch" } }, { roomIds: ["public"] }, { script: "leak.py" },
      { noAgent: true }, { enabledToolsets: ["terminal"] }, { model: "other" }, { skills: ["exfiltrate"] }, { contextFrom: ["deadbeef"] }]) {
      const [current] = momJobs();
      jobs = jobs.map(job => job === current ? { ...job, ...drift } : job);
      await created.mains.reconcile();
      expect(momJobs()).toHaveLength(1);
      expect(momJobs()[0].id).not.toBe(current.id);
      expect(momJobs()[0]).toMatchObject({ delivery: { deliver: "bot-chat:mom-main" } });
    }
    expect(good).toBeDefined();
  });
  it("makes no replacement while a superseded job could still run", async () => {
    await checkIns();
    const [old] = momJobs();
    fail.delete = true; fail.pause = true;
    await main("mom-notes");
    expect((await checkIns()).statusCode).toBe(502);
    expect(jobs.filter(job => job.enabled && signedCheckInMember(created.store, job) === "mom")).toEqual([expect.objectContaining({ id: old.id })]);
    // Paused is safe enough: the new one is made, and the old one is deleted on a later pass.
    fail.pause = false;
    expect((await checkIns()).statusCode).toBe(502);
    expect(jobs.find(job => job.id === old.id)?.enabled).toBe(false);
    expect(momJobs().filter(job => job.enabled)).toMatchObject([{ botId: "mom-notes" }]);
    fail.delete = false;
    await created.mains.reconcile();
    expect(momJobs()).toMatchObject([{ botId: "mom-notes" }]);
  });
  it("keeps sharing refused on a retry while a check-in from an earlier attempt is still there", async () => {
    await checkIns();
    fail.delete = true; fail.pause = true;
    const share = (confirm = true) => created.app.inject({ method: "PATCH", url: "/api/bots/mom-main", headers: mom,
      payload: { name: "Sage", instructions: "", model: "test", shared: true, ...(confirm ? { confirmMainCleared: true } : {}) } });
    expect((await share()).json().code).toBe("check_in_removal_pending");
    expect(prefs().mainBotId).toBeUndefined();
    // No longer main, but its check-in remains, so a retry is still confirmed and still refused.
    expect((await share(false)).json().code).toBe("main_share_confirmation_required");
    expect((await share()).json().code).toBe("check_in_removal_pending");
    expect(created.store.presentation("mom-main")).toMatchObject({ shared: false, ownerId: "mom" });
    fail.delete = false;
    expect((await share()).statusCode).toBe(200);
    expect(jobs).toEqual([]);
  });
  it("refuses sharing a personal assistant while Hermes can't say whether a check-in is still on it", async () => {
    fail.routines = true;
    const share = await created.app.inject({ method: "PATCH", url: "/api/bots/mom-notes", headers: mom,
      payload: { name: "Notes", instructions: "", model: "test", shared: true } });
    expect(share.json().code).toBe("main_share_confirmation_required");
    expect(created.store.presentation("mom-notes")).toMatchObject({ shared: false, ownerId: "mom" });
  });
  it("is known as a check-in before its first run is stored, even before this server reconciled it", async () => {
    // As after a create whose answer was lost and a restart: Hermes has the job, this server has no record.
    jobs.push({ id: "lost", botId: "mom-main", name: "Check-ins", schedule: "every 120m", enabled: true, delivery: { deliver: "bot-chat:mom-main" }, nativeOverrides: [],
      prompt: `${checkInMarker(created.store, "mom-main", "mom")}\n\nCheck in` });
    const event: RuntimeEvent = { id: "lost-run", botId: "mom-main", routineId: "lost", runId: "routine:mom-main:lost:1", kind: "completed", title: "[bot:mom-main] Check-ins", occurredAt: new Date().toISOString() };
    await created.mains.identify([event]);
    created.store.recordEvents([event], "9");
    expect(created.store.outbox()).toEqual([]);
    expect(created.store.eventPage("mom", 0, created.store.latestEventFrontier(), ["mom-main"]).events).toEqual([]);
  });
  it("keeps a run of a check-in that is already gone quiet", async () => {
    const gone: RuntimeEvent = { id: "gone-run", botId: "mom-main", routineId: "gone", kind: "completed", title: "[bot:mom-main] Check-ins", occurredAt: new Date().toISOString() };
    created.store.routineRecipients("mom-main", "gone", ["mom"]);
    await created.mains.identify([gone]);
    created.store.recordEvents([gone], "10");
    expect(created.store.outbox()).toEqual([]);
  });
  it("leaves discovered runs undiscovered while Hermes can't say which are check-ins", async () => {
    jobs.push({ id: "lost", botId: "mom-main", name: "Check-ins", schedule: "every 120m", enabled: true, delivery: { deliver: "bot-chat:mom-main" }, nativeOverrides: [],
      prompt: `${checkInMarker(created.store, "mom-main", "mom")}\n\nCheck in` });
    discovered = [{ id: "lost-run", botId: "mom-main", routineId: "lost", runId: "routine:mom-main:lost:1", kind: "completed", title: "[bot:mom-main] Check-ins", occurredAt: new Date().toISOString() }];
    fail.routines = true;
    await created.worker.tick();
    expect(created.store.cursor()).toBe("");
    fail.routines = false;
    await created.worker.tick();
    expect(created.store.cursor()).toBe("c1");
    expect(created.store.outbox()).toEqual([]);
    expect(created.store.checkIns.isCheckIn("mom-main", "lost")).toBe(true);
  });
});

describe("review round two", () => {
  const ids = (list: { id: string }[]) => list.map(row => row.id);
  it("never sends a roster from before a sharing change after it, even from a pass that began earlier", async () => {
    await main("mom-main");
    let open!: () => void;
    holdRoutines = new Promise(resolve => { open = resolve; });
    const pass = created.mains.reconcile();
    // The pass read the roster with Notes personal and now waits on Hermes's routines.
    for (let tick = 0; tick < 20 && holdRoutines !== undefined; tick++) await new Promise(resolve => setImmediate(resolve));
    const sharing = created.app.inject({ method: "PATCH", url: "/api/bots/mom-notes", headers: mom, payload: { name: "Notes", instructions: "", model: "test", shared: true } });
    for (let tick = 0; tick < 200 && !calls.includes("saveBot:mom-notes"); tick++) await new Promise(resolve => setImmediate(resolve));
    const shared = pushed.length;
    open();
    await pass;
    expect((await sharing).statusCode).toBe(200);
    // Every roster sent once Notes was shared treats it as shared: never personal to Mom's main assistant, never reaching her others.
    for (const policies of pushed.slice(shared)) {
      expect(ids(policies["mom-main"].personal)).not.toContain("mom-notes");
      expect(policies["mom-notes"].personal).toEqual([]);
    }
    expect(ids(pushed.at(-1)!["mom-main"].shared)).toContain("mom-notes");
  });
  it("replaces a check-in carrying a native setting the app doesn't read, or whose settings Hermes didn't list", async () => {
    await main("mom-main");
    await checkIns();
    for (const overrides of [["monitor_script"], ["workdir"], undefined]) {
      const [current] = momJobs();
      jobs = jobs.map(job => job === current ? { ...job, nativeOverrides: overrides } : job);
      await created.mains.reconcile();
      expect(momJobs()).toHaveLength(1);
      expect(momJobs()[0].id).not.toBe(current.id);
    }
  });
  it("makes no replacement while an old check-in's run is still going, even once it is paused", async () => {
    await main("mom-main");
    await checkIns();
    const [old] = momJobs();
    jobs = jobs.map(job => job.id === old.id ? { ...job, running: true } : job);
    fail.stop = true; fail.delete = true;
    await main("mom-notes");
    expect((await checkIns()).statusCode).toBe(502);
    // Paused, but its run goes on, so nothing new runs beside it.
    expect(jobs.find(job => job.id === old.id)).toMatchObject({ enabled: false, running: true });
    expect(momJobs().filter(job => job.botId === "mom-notes")).toEqual([]);
    fail.stop = false; fail.delete = false;
    expect((await checkIns()).statusCode).toBe(200);
    expect(momJobs()).toMatchObject([{ botId: "mom-notes" }]);
  });
  describe("a routine's chat and outward deliveries, through the app's own routes", () => {
    const routine = (botId: string, deliver: string): Routine => ({ id: `r-${botId}`, botId, name: "R", prompt: "Report", schedule: "0 7 * * *", enabled: false,
      delivery: { deliver }, nativeOverrides: [] });
    const resume = (id: string) => created.app.inject({ method: "PATCH", url: `/api/routines/${id}/state`, headers: mom, payload: { enabled: true } });
    it("leaves other assistants' routine deliveries as Hermes has them, a known limit taken up separately", async () => {
      jobs.push(routine("mom-notes", "bot-chat:dad-diary"), routine("ranch", "bot-chat:mom-notes"));
      expect((await resume("r-mom-notes")).statusCode).toBe(200);
      expect((await resume("r-ranch")).statusCode).toBe(200);
    });
    it("refuses a main assistant's routine that posts outside WildBots, but not another assistant's", async () => {
      await main("mom-main");
      jobs.push(routine("mom-main", "telegram:-100123"), routine("mom-notes", "telegram:-100123"));
      expect((await resume("r-mom-main")).json().code).toBe("routine_chats");
      expect((await resume("r-mom-notes")).statusCode).toBe(200);
    });
  });
});

describe("review round two, ordering", () => {
  const ids = (list: { id: string }[]) => list.map(row => row.id);
  it("lets Hermes take only one roster at a time, so an older one can't land after a newer one", async () => {
    await main("mom-main");
    let open!: () => void;
    holdPolicy = new Promise(resolve => { open = resolve; });
    applied = [];
    // A pass with a roster change (a rename made in Hermes) stalls in Hermes while Notes is shared.
    bots = bots.map(bot => bot.id === "ranch" ? { ...bot, name: "Foreman" } : bot);
    const pass = created.mains.reconcile();
    for (let tick = 0; tick < 200 && holdPolicy !== undefined; tick++) await new Promise(resolve => setImmediate(resolve));
    expect(holdPolicy).toBeUndefined();
    const sharing = created.app.inject({ method: "PATCH", url: "/api/bots/mom-notes", headers: mom, payload: { name: "Notes", instructions: "", model: "test", shared: true } });
    for (let tick = 0; tick < 50; tick++) await new Promise(resolve => setImmediate(resolve));
    open();
    await pass;
    expect((await sharing).statusCode).toBe(200);
    // Once Hermes took the roster that withdrew Notes, it never again takes one listing Notes as Mom's personal assistant.
    const withdrawn = applied.findIndex(policies => policies["mom-notes"].personal.length === 0 && !ids(policies["mom-main"].personal).includes("mom-notes"));
    expect(withdrawn).toBeGreaterThan(-1);
    for (const policies of applied.slice(withdrawn)) expect(ids(policies["mom-main"].personal)).not.toContain("mom-notes");
    expect(ids(applied.at(-1)!["mom-main"].shared)).toContain("mom-notes");
  });
  it("deletes no check-in while its run goes on, so nothing new runs beside it", async () => {
    await main("mom-main");
    await checkIns();
    const [old] = momJobs();
    jobs = jobs.map(job => job.id === old.id ? { ...job, running: true } : job);
    fail.stop = true;
    await main("mom-notes");
    expect((await checkIns()).statusCode).toBe(502);
    expect(jobs.find(job => job.id === old.id)).toMatchObject({ running: true, enabled: false });
    expect(momJobs().filter(job => job.botId === "mom-notes")).toEqual([]);
  });
});

describe("review round three", () => {
  const routine = (botId: string, deliver: string, enabled = true): Routine => ({ id: `r-${botId}`, botId, name: `${botId} report`, prompt: "Report",
    schedule: "0 7 * * *", enabled, delivery: { deliver }, nativeOverrides: [] });
  it("refuses a main assistant's routine that delivers to where it was made when no origin was recorded", async () => {
    await main("mom-main");
    jobs.push({ ...routine("mom-main", "origin"), enabled: false });
    const resume = await created.app.inject({ method: "PATCH", url: "/api/routines/r-mom-main/state", headers: mom, payload: { enabled: true } });
    expect(resume.json().code).toBe("routine_chats");
  });
  it("keeps a healthy check-in through its runs, failures, retries and quota holds, reading its native fields as Hermes left them", async () => {
    await main("mom-main");
    await checkIns();
    const [job] = momJobs();
    const states = [["running", scheduled.running, true], ["completed", scheduled.completed, false],
      ...Object.entries(scheduled.failures).map(([state, native]) => [state, native, false] as const)] as const;
    for (const [, native, running] of states) {
      jobs = jobs.map(row => row.id === job.id ? { ...row, running, nativeOverrides: nativeOverrides(native) } : row);
      calls.length = 0;
      await created.mains.reconcile();
      expect(momJobs().map(row => row.id)).toEqual([job.id]);
      expect(calls.filter(call => /^(stop|delete|create)/.test(call))).toEqual([]);
    }
  });
});

describe("a main assistant's routines post only in its own chat", () => {
  const routine = (id: string, deliver: string, enabled = false): Routine => ({ id, botId: "mom-main", name: `Routine ${id}`, prompt: "Report",
    schedule: "0 7 * * *", enabled, delivery: { deliver }, nativeOverrides: [] });
  const elsewhere = ["bot-chat:mom-notes", "bot-chat:ranch", "room:team", "telegram:-100123", "origin", "bot-chat:mom-main,room:team", "all"];
  it("isn't made main while one of its routines posts anywhere else, paused or not, and says which", async () => {
    for (const deliver of elsewhere) {
      jobs = [routine("r1", "bot-chat:mom-main"), routine("r2", deliver)];
      const response = await main("mom-main");
      expect(response.json(), deliver).toMatchObject({ code: "main_routine_delivery", error: expect.stringContaining('"Routine r2"') });
      expect(prefs().mainBotId).toBeUndefined();
    }
    // Its own chat, or saving without delivering, is fine.
    jobs = [routine("r1", "bot-chat:mom-main"), routine("r2", "bot-chat"), routine("r3", "local")];
    expect((await main("mom-main")).json().mainBotId).toBe("mom-main");
  });
  it("isn't made main while WildBots can't read its routines", async () => {
    fail.routines = true;
    expect((await main("mom-main")).json().code).toBe("main_routine_delivery");
  });
  describe("once it is main", () => {
    beforeEach(async () => { await main("mom-main"); });
    // As if made outside WildBots after it became main.
    const add = (deliver: string) => { jobs.push(routine("outside", deliver)); };
    it("refuses saving one that posts elsewhere, even paused", async () => {
      for (const deliver of elsewhere) {
        jobs = jobs.filter(job => job.id !== "outside"); add(deliver);
        const save = await created.app.inject({ method: "PUT", url: "/api/routines/outside", headers: mom,
          payload: { botId: "mom-main", name: "Renamed", prompt: "Report", schedule: "0 7 * * *", enabled: false, recipientIds: ["mom"] } });
        expect(save.json().code, deliver).toBe("routine_chats");
      }
      expect(calls.filter(call => call.startsWith("update:outside"))).toEqual([]);
      // A new routine of its own posts in its own chat.
      const created_ = await created.app.inject({ method: "POST", url: "/api/routines", headers: mom,
        payload: { botId: "mom-main", name: "Mine", prompt: "Report", schedule: "0 7 * * *", enabled: true, recipientIds: ["mom"] } });
      expect(created_.statusCode).toBe(200);
    });
    it("refuses resuming one that posts elsewhere", async () => {
      add("bot-chat:mom-notes");
      expect((await created.app.inject({ method: "PATCH", url: "/api/routines/outside/state", headers: mom, payload: { enabled: true } })).json().code).toBe("routine_chats");
      expect(calls.filter(call => call.startsWith("pause:"))).toEqual([]);
    });
    it("refuses a trial run of one that posts elsewhere", async () => {
      add("room:team");
      const run = await created.app.inject({ method: "POST", url: "/api/routines/outside/run", headers: mom, payload: { requestId: "3f1c2a4e-8b7d-4c6e-9a5f-1d2e3c4b5a69" } });
      expect(run.json().code).toBe("routine_chats");
    });
    it("refuses an event trigger for one that posts elsewhere, even without group chats", async () => {
      add("telegram:-100123");
      const trigger = await created.app.inject({ method: "POST", url: "/api/bots/mom-main/automation/triggers", headers: mom,
        payload: { id: "fence", description: "Fence", events: ["issue.created"], routineId: "outside" } });
      expect(trigger.json().code).toBe("routine_chats");
    });
  });
});

describe("moving into and out of being main", () => {
  const routine = (id: string, deliver: string, extra: Partial<Routine> = {}): Routine => ({ id, botId: "mom-main", name: `Routine ${id}`, prompt: "Report",
    schedule: "0 7 * * *", enabled: true, delivery: { deliver }, nativeOverrides: [], ...extra });
  const lastMain = (botId = "mom-main") => applied.at(-1)?.[botId]?.main;
  describe("making an assistant main", () => {
    it("records nothing when Hermes doesn't take its limits, or can't enforce them", async () => {
      fail.policy = true;
      expect((await main("mom-main")).json()).toMatchObject({ code: "main_activation_failed" });
      expect(prefs().mainBotId).toBeUndefined();
      fail.policy = false; enforcing = 0;
      expect((await main("mom-main")).json()).toMatchObject({ code: "main_activation_failed", error: expect.stringContaining("Update the add-on") });
      expect(prefs().mainBotId).toBeUndefined();
      enforcing = 2;
      expect((await main("mom-main")).json().mainBotId).toBe("mom-main");
      expect(lastMain()).toBe(true);
    });
    it("checks its routines only once Hermes holds it to a main assistant's limits, and takes the limits back when they fail", async () => {
      // A routine posting elsewhere appears while the roster is on its way, as one the assistant made just before Hermes enforced it.
      let release!: () => void;
      holdPolicy = new Promise(resolve => { release = resolve; });
      const request = main("mom-main");
      await vi.waitFor(() => expect(pushed.at(-1)?.["mom-main"]?.main).toBe(true));
      jobs.push(routine("late", "bot-chat:ranch"));
      release();
      expect((await request).json()).toMatchObject({ code: "main_routine_delivery", error: expect.stringContaining('"Routine late"') });
      expect(prefs().mainBotId).toBeUndefined();
      expect(lastMain()).toBe(false);
    });
    it("waits while one of its routines is running or has a delivery Hermes still holds, wherever it posts", async () => {
      for (const extra of [{ running: true }, { inFlight: true }] as Partial<Routine>[]) {
        jobs = [routine("busy", "bot-chat:mom-main", extra)];
        expect((await main("mom-main")).json(), JSON.stringify(extra)).toMatchObject({ code: "main_routine_busy", error: expect.stringContaining('"Routine busy" is running or waiting to deliver') });
        expect(prefs().mainBotId).toBeUndefined();
        expect(lastMain()).toBe(false);
      }
      // A delivery from a routine since deleted is still held under the routine's Hermes name.
      jobs = [];
      held["mom-main"] = [{ id: "gone", name: "[bot:mom-main] Old digest" }];
      expect((await main("mom-main")).json().error).toContain('"Old digest"');
      // Another assistant's held deliveries don't count.
      held = { ranch: [{ id: "r", name: "Ranch digest" }] };
      expect((await main("mom-main")).json().mainBotId).toBe("mom-main");
    });
    it("isn't made main while Hermes can't say what deliveries it holds, or this Hermes can't read them", async () => {
      fail.held = true;
      expect((await main("mom-main")).json()).toMatchObject({ code: "main_routine_delivery" });
      expect(prefs().mainBotId).toBeUndefined();
      expect(lastMain()).toBe(false);
      fail.held = false;
      delete runtime.routineDeliveries;
      expect((await main("mom-main")).json()).toMatchObject({ code: "main_routine_delivery" });
      expect(prefs().mainBotId).toBeUndefined();
    });
    it("runs in turn with routine changes, so a trigger sent meanwhile is checked as the main assistant's", async () => {
      let release!: () => void;
      holdPolicy = new Promise(resolve => { release = resolve; });
      const request = main("mom-main");
      await vi.waitFor(() => expect(pushed.at(-1)?.["mom-main"]?.main).toBe(true));
      // A routine WildBots can't find can't be shown to post only in its own chat.
      const trigger = created.app.inject({ method: "POST", url: "/api/bots/mom-main/automation/triggers", headers: mom,
        payload: { id: "fence", description: "Fence", events: ["issue.created"], routineId: "unknown" } });
      // Long enough for a trigger that didn't wait its turn to finish first.
      await new Promise(resolve => setTimeout(resolve, 100));
      release();
      expect((await request).json().mainBotId).toBe("mom-main");
      expect((await trigger).json().code).toBe("routine_chats");
    });
  });
  describe("ending being main", () => {
    beforeEach(async () => { await main("mom-main"); await checkIns(); fail.delete = true; fail.pause = true; });
    it("keeps a main assistant's limits in Hermes while a check-in cleanup missed is still there, and says it isn't finished", async () => {
      const cleared = await main(null);
      expect(cleared.statusCode).toBe(502);
      expect(cleared.json()).toMatchObject({ code: "main_clear_pending" });
      expect(cleared.json().preferences).not.toHaveProperty("mainBotId");
      expect(prefs().mainBotId).toBeUndefined();
      expect(momJobs()).toHaveLength(1);
      expect(lastMain()).toBe(true);
      // Once Hermes removes it, the limits end with it.
      fail.delete = false; fail.pause = false;
      await created.mains.reconcile();
      expect(momJobs()).toEqual([]);
      expect(lastMain()).toBe(false);
    });
    it("keeps the limits for a check-in WildBots lost track of, and from a restarted server before its first pass", async () => {
      await main(null);
      // A fresh server sends rosters, here for another member's change, before it has looked at any routine.
      const restarted = new MainAssistants(runtime, created.store, config);
      await restarted.activate("dad-diary", async () => {}, () => {});
      expect(lastMain()).toBe(true);
      // A check-in found only by its signed marker, as after a create whose answer was lost.
      const [job] = momJobs();
      created.store.checkIns.removed(job.botId, job.id);
      await created.mains.reconcile().catch(() => {});
      expect(created.store.checkIns.current()).toEqual([]);
      expect(lastMain()).toBe(true);
    });
    it("keeps the old main's limits too when the member moves to another assistant", async () => {
      const moved = await main("mom-notes");
      expect(moved.json()).toMatchObject({ code: "main_clear_pending" });
      expect(prefs().mainBotId).toBe("mom-notes");
      expect([lastMain("mom-main"), lastMain("mom-notes")]).toEqual([true, true]);
    });
  });
});

describe("protection while check-ins are unknown, and requests that race", () => {
  const signed = (botId: string, id = "orphan"): Routine => ({ id, botId, name: "Check-ins", prompt: checkInPrompt({ marker: checkInMarker(created.store, botId, "mom"), member: "Mom", timezone: "America/Chicago", everyHours: 2 }),
    schedule: "every 120m", enabled: true, delivery: { deliver: `bot-chat:${botId}` }, contextFrom: ["self"], nativeOverrides: [] });
  const lastMain = (botId: string) => applied.at(-1)?.[botId]?.main;
  it("holds every personal assistant to a main assistant's limits after a restart until a routine inventory succeeds", async () => {
    // A signed check-in nothing here tracks, as after a create whose answer was lost, on an assistant that isn't main.
    jobs.push(signed("mom-notes"));
    expect(created.store.checkIns.current()).toEqual([]);
    const restarted = new MainAssistants(runtime, created.store, config);
    // Making another assistant main first sends rosters before any inventory: nobody's protection comes off.
    await restarted.activate("mom-main", async () => {}, () => {});
    expect([lastMain("mom-notes"), lastMain("dad-diary")]).toEqual([true, true]);
    // An inventory that fails changes nothing.
    fail.routines = true;
    await expect(restarted.reconcile()).rejects.toThrow();
    await restarted.activate("mom-main", async () => {}, () => {});
    expect(lastMain("mom-notes")).toBe(true);
    // The first one that succeeds finds the orphan; it stays protected until it is confirmed gone.
    fail.routines = false; fail.delete = true; fail.pause = true;
    await restarted.reconcile().catch(() => {});
    expect([lastMain("mom-notes"), lastMain("dad-diary")]).toEqual([true, false]);
    fail.delete = false; fail.pause = false;
    await restarted.reconcile();
    expect(jobs).toEqual([]);
    expect(lastMain("mom-notes")).toBe(false);
  });
  it("keeps protection through a pass that couldn't list routines, as when Hermes drops after the roster read", async () => {
    jobs.push(signed("mom-notes"));
    const restarted = new MainAssistants(runtime, created.store, config);
    // Hermes answers the roster, then reports routines unavailable, as its capabilities do while disconnected.
    routinesSupported = false;
    await restarted.reconcile();
    routinesSupported = true;
    await restarted.activate("mom-main", async () => {}, () => {});
    expect([lastMain("mom-notes"), lastMain("dad-diary")]).toEqual([true, true]);
    // A pass that lists them finds the orphan, and protection comes off only for those without one.
    fail.delete = true; fail.pause = true;
    await restarted.reconcile().catch(() => {});
    expect([lastMain("mom-notes"), lastMain("dad-diary")]).toEqual([true, false]);
    // After that, unavailable routines change nothing either.
    routinesSupported = false;
    await restarted.reconcile();
    expect(lastMain("mom-notes")).toBe(true);
  });
  it("saves check-in settings in turn with main changes, so a clear isn't undone by a request that read before it", async () => {
    await main("mom-main");
    let release!: () => void;
    holdBots = new Promise(resolve => { release = resolve; });
    const settings = checkIns();
    const clear = main(null);
    await new Promise(resolve => setTimeout(resolve, 100));
    release();
    await settings; await clear;
    // In order: check-ins went on, then main was cleared, which turned them off; neither came back.
    expect(prefs().mainBotId).toBeUndefined();
    expect(prefs().checkIns?.enabled).toBe(false);
    expect(lastMain("mom-main")).toBe(false);
  });
  it("turns a switch back off without undoing a newer check-ins change", async () => {
    await main("mom-main");
    fail.create = "refused";
    // The first request's pass holds its routine read while the newer change waits its turn behind it.
    let release!: () => void;
    holdRoutines = new Promise(resolve => { release = resolve; });
    const on = checkIns();
    await new Promise(resolve => setTimeout(resolve, 100));
    const later = checkIns({ enabled: false, everyHours: 4 });
    await new Promise(resolve => setTimeout(resolve, 100));
    release();
    expect((await on).json().code).toBe("check_in_unavailable");
    expect((await later).statusCode).toBe(200);
    expect(prefs().checkIns).toMatchObject({ enabled: false, everyHours: 4 });
  });
  it("never lets a failed setup turn off a newer request that asked for the same settings", async () => {
    await main("mom-main");
    fail.create = "refused";
    const wait = () => new Promise(resolve => setTimeout(resolve, 100));
    // The first request's two setup passes both fail; the second, identical request saves between them and its rollback.
    let first!: () => void, second!: () => void, third!: () => void;
    holdRoutines = new Promise(resolve => { first = resolve; });
    const older = checkIns();
    await wait();
    holdRoutines = new Promise(resolve => { second = resolve; });
    first();
    await wait();
    const newer = checkIns();
    await wait();
    holdRoutines = new Promise(resolve => { third = resolve; });
    second();
    await wait();
    // Hermes recovers before the newer request's own pass.
    fail.create = undefined;
    third();
    expect((await older).json().code).toBe("check_in_unavailable");
    expect((await newer).statusCode).toBe(200);
    expect(prefs().checkIns?.enabled).toBe(true);
  });
  it("keeps a check-in's assistant protected when main is cleared while Hermes can't list routines, whether it was just made or kept", async () => {
    // Just made: the last inventory that succeeded is the one that created it.
    await main("mom-main");
    await checkIns();
    fail.routines = true;
    expect((await main(null)).json().code).toBe("main_clear_pending");
    expect(lastMain("mom-main")).toBe(true);
    // Kept: a later inventory found it and left it in place.
    fail.routines = false;
    await created.mains.reconcile();
    await main("mom-main");
    await checkIns();
    await created.mains.reconcile();
    fail.routines = true;
    expect((await main(null)).json().code).toBe("main_clear_pending");
    expect(lastMain("mom-main")).toBe(true);
  });
  it("decides a reaffirmation in turn, so a clear that came after it can't let it skip the checks", async () => {
    await main("mom-main");
    let release!: () => void;
    holdBots = new Promise(resolve => { release = resolve; });
    const reaffirm = main("mom-main");
    const clear = main(null);
    // Long enough for a clear that didn't wait its turn to finish, and a routine posting elsewhere to appear after it.
    await new Promise(resolve => setTimeout(resolve, 100));
    jobs.push({ id: "outward", botId: "mom-main", name: "Outward", prompt: "Report", schedule: "0 7 * * *", enabled: true, delivery: { deliver: "bot-chat:ranch" }, nativeOverrides: [] });
    release();
    expect((await reaffirm).statusCode).toBe(200);
    expect((await clear).statusCode).toBe(200);
    // The requests took effect in order: it was reaffirmed, then cleared, never main again with an outward routine.
    expect(prefs().mainBotId).toBeUndefined();
  });
  it("decides a share in turn with making the assistant main, so a shared assistant is never left designated main", async () => {
    let release!: () => void;
    holdPolicy = new Promise(resolve => { release = resolve; });
    const making = main("mom-main");
    await vi.waitFor(() => expect(pushed.at(-1)?.["mom-main"]?.main).toBe(true));
    // Sent from a screen that didn't know yet that it was becoming main, so without a yes.
    const sharing = created.app.inject({ method: "PATCH", url: "/api/bots/mom-main", headers: mom, payload: { name: "Sage", instructions: "", model: "test", shared: true } });
    await new Promise(resolve => setTimeout(resolve, 100));
    release();
    expect((await making).json().mainBotId).toBe("mom-main");
    expect((await sharing).json().code).toBe("main_share_confirmation_required");
    expect(created.store.presentation("mom-main")).toMatchObject({ shared: false, ownerId: "mom" });
  });
});
