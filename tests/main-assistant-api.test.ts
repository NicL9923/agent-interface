import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig, type Config } from "../src/server/config.js";
import { checkInMarker, ReconcileError } from "../src/server/main-assistant.js";
import type { Bot, DelegationPolicies, Routine, RuntimeEvent } from "../src/shared/types.js";
import { fakeRuntime, signIn } from "./helpers/server.js";
import { botFixture, capabilitiesFixture } from "./helpers/runtime-fixtures.js";
import type { RoutineRunStatus } from "../src/shared/routine-runs.js";

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
let fail: { create?: "refused" | "uncertain"; delete?: boolean; update?: boolean; status?: boolean };
let routinesSupported: boolean;
let nextId: number;
let mom: Record<string, string>, dad: Record<string, string>;
let results: Record<string, { id: string; status: RoutineRunStatus; startedAt: string; error?: string }[]>;

beforeEach(async () => {
  jobs = []; calls = []; pushed = []; fail = {}; routinesSupported = true; nextId = 1; results = {};
  bots = [
    botFixture({ id: "mom-main", name: "Sage", description: "Mom's chief of staff", shared: false, ownerId: "mom" }),
    botFixture({ id: "mom-notes", name: "Notes", shared: false, ownerId: "mom" }),
    botFixture({ id: "ranch", name: "Ranch Hand", description: "Runs the ranch" }),
    botFixture({ id: "legacy", name: "Legacy", shared: false }),
    botFixture({ id: "dad-diary", name: "Diary", shared: false, ownerId: "dad" }),
  ];
  const runtime = fakeRuntime({
    status: async () => fail.status ? { connected: false } : { connected: true },
    capabilities: async () => capabilitiesFixture({ routines: { supported: routinesSupported }, botConfiguration: { supported: true } }),
    listBots: async () => structuredClone(bots),
    routines: async () => structuredClone(jobs),
    // Hermes stores "every 2h" as an interval and shows it back in minutes.
    saveRoutine: async (input, id) => {
      calls.push(id ? `update:${id}` : `create:${input.botId}`);
      if (!id && fail.create === "refused") throw new Error("Hermes refused the routine.");
      if (id && fail.update) throw new Error("Hermes refused the update.");
      const hours = /^every (\d+)h$/.exec(input.schedule)?.[1];
      const saved: Routine = { ...input, id: id ?? `job${nextId++}`, schedule: hours ? `every ${Number(hours) * 60}m` : input.schedule };
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
    stopRoutineRun: async (botId, id) => { calls.push(`stop:${id}`); jobs = jobs.map(job => job.id === id && job.botId === botId ? { ...job, running: false } : job); return true; },
    routineResults: async (_botId, routineId) => (results[routineId] ?? []).map(run => ({ ...run, title: "Run", previewOnly: true })),
    delegationPolicy: async policies => { pushed.push(structuredClone(policies)); },
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
});
afterEach(async () => { await created?.app.close(); });

const put = (url: string, payload: unknown, headers = mom) => created.app.inject({ method: "PUT", url: `/api${url}`, headers, payload: payload as object });
const main = (botId: string | null, headers = mom) => put("/preferences/main", { botId }, headers);
const checkIns = (settings: Partial<{ enabled: boolean; everyHours: number; timezone: string }> = {}, headers = mom) =>
  put("/preferences/check-ins", { enabled: true, everyHours: 2, timezone: "America/Chicago", ...settings }, headers);
const prefs = (userId = "mom") => created.store.preferences(userId);
const momJobs = () => jobs.filter(job => job.prompt.startsWith(checkInMarker("mom")));

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
    expect(prefs().checkIns?.enabled).toBe(false);
    expect(jobs).toEqual([]);
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
    jobs.push({ ...kept, id: "copy" }, { ...kept, id: "stray", botId: "ranch", prompt: `${checkInMarker("dad")}\n\nOld` },
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
      payload: { botId: "ranch", name: "Sneaky", prompt: `${checkInMarker("mom")}\n\nHi`, schedule: "every 2h", enabled: true, recipientIds: [] } });
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

describe("the main assistant's roster", () => {
  it("lists the member's other personal assistants and the household's, never another member's", async () => {
    await main("mom-main");
    expect(pushed.at(-1)).toEqual({ "mom-main": { member: "Mom",
      personal: [{ id: "mom-notes", name: "Notes" }],
      shared: [{ id: "ranch", name: "Ranch Hand", description: "Runs the ranch" }, { id: "legacy", name: "Legacy" }] } });
  });
  it("follows a rename, a new assistant and a cleared main assistant on the next pass", async () => {
    await main("mom-main");
    await created.app.inject({ method: "PATCH", url: "/api/bots/ranch", headers: mom, payload: { name: "Foreman", instructions: "", model: "test", shared: true } });
    await created.mains.reconcile();
    expect(pushed.at(-1)!["mom-main"].shared[0]).toMatchObject({ id: "ranch", name: "Foreman" });
    await main(null);
    expect(pushed.at(-1)).toEqual({});
  });
});
