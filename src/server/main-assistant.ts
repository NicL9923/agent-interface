import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CHECK_IN_ROUTINE_NAME, checkInSchedule, scheduleMinutes, mainEligible, mainIneligibleReason, validCheckInHours } from "../shared/main-assistant.js";
import type { Bot, CapabilityKey, DelegationPolicies, Preferences, Routine, Runtime } from "../shared/types.js";
import { apiRoute } from "./api-route.js";
import { signedIn } from "./auth.js";
import { notFound, visible } from "./bot-access.js";
import { allowedIdentity, type Config } from "./config.js";
import { httpError } from "./http-error.js";
import { quietLog, type Log } from "./logging.js";
import { serialDelivery } from "./routine-delivery.js";
import { id, timezone } from "./schemas.js";
import type { Store } from "./store.js";
export { scheduleMinutes };

// A member's main assistant and its check-ins. The member's preferences say what they want; this
// module keeps Hermes matching: exactly one check-in routine per member who has them on, on their
// current main assistant, and none anywhere else. Every change reconciles, and so does a periodic
// pass, so a failed or uncertain create or delete, a deleted or shared assistant and a removed
// member all end with zero or one job, never an orphan or a duplicate.

/** The first line of a check-in's prompt, which names its member, so a job this server lost track of is still found. */
export const checkInMarker = (userId: string) => `[WildBots check-in for member ${userId}]`;
const markerPattern = /^\[WildBots check-in for member ([^\]\s]+)\]/;
/** The member a job's prompt says it checks in for. */
export const checkInMember = (prompt: string | undefined) => markerPattern.exec(prompt ?? "")?.[1];

export function checkInPrompt(input: { userId: string; member: string; timezone: string; everyHours: number }) {
  const { member } = input;
  return [
    checkInMarker(input.userId),
    `You are ${member}'s main assistant in WildBots, checking in on your own about every ${input.everyHours === 1 ? "hour" : `${input.everyHours} hours`}.`,
    `${member}'s timezone is ${input.timezone}. If it is between 10 PM and 7 AM there right now, reply with exactly [SILENT] and nothing else.`,
    `Otherwise review what you can reach: connected calendars, email and task lists, and your recent conversation with ${member}.`,
    "Speak up only for something that clearly needs them soon: a calendar conflict, a time that changed, a deadline within the next day, or a reply someone is waiting on from them. Skip anything you already raised in an earlier check-in.",
    "When something needs them, write one short message: what it is, why it matters now, and what you suggest.",
    `When nothing needs attention, reply with exactly [SILENT] and nothing else, so ${member} hears nothing.`,
  ].join("\n\n");
}


/** Whether a routine is someone's managed check-in, which only its own controls change. */
export function isManagedCheckIn(store: Store, routine: Pick<Routine, "botId" | "id" | "prompt">) {
  return store.checkIns.current().some(job => job.botId === routine.botId && job.jobId === routine.id) || !!checkInMember(routine.prompt);
}
export function assertNotManaged(store: Store, routine: Pick<Routine, "botId" | "id" | "prompt">, botName = "its assistant") {
  if (isManagedCheckIn(store, routine))
    throw httpError(409, `These are check-ins. Change or turn them off from ${botName}'s details.`, { code: "check_in_managed" });
}
/** Nobody writes a check-in's marker into a routine of their own, which would make it look managed. */
export function assertNoMarker(prompt: string) {
  if (checkInMember(prompt)) throw httpError(400, "Routine instructions can't start with a WildBots check-in marker.", { code: "check_in_marker" });
}

/** A pass that could not finish every step. `members` names whose check-ins it left as they were; a whole-pass failure names nobody. */
export class ReconcileError extends Error {
  constructor(readonly errors: unknown[], readonly members: Set<string>, readonly whole: boolean) {
    super(errors[0] instanceof Error ? errors[0].message : "Check-ins could not be reconciled.");
  }
  /** Whether this member's check-ins may not match what they asked for. */
  affects(userId: string) { return this.whole || this.members.has(userId); }
}

const tick = 5 * 60_000;
const rosterQuiet = 30_000;
const policyRefresh = 10 * 60_000;

export class MainAssistants {
  private queue: Promise<void> = Promise.resolve();
  private queued?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private soonTimer?: ReturnType<typeof setTimeout>;
  private unwatch?: () => void;
  private policy = { key: "", at: 0 };
  constructor(private readonly runtime: Runtime, private readonly store: Store, private readonly config: Config, private readonly log: Log = quietLog) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.reconcile().catch(() => {}), tick);
    this.timer.unref?.();
    // Hermes changes made outside this app, such as a rename, reach the roster a little later.
    this.unwatch = this.runtime.watchRoster?.(() => this.soon());
    void this.reconcile().catch(() => {});
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.unwatch?.();
    this.timer = this.soonTimer = this.unwatch = undefined;
    return this.queue;
  }
  /** Whether any member has a main assistant, check-ins or a roster in Hermes, so a roster change matters here. */
  relevant() {
    return this.policy.key.length > 2 || this.store.checkIns.current().length > 0
      || this.store.users().some(user => !!this.store.preferences(user.id).mainBotId);
  }
  /** Reconciles within half a minute, joining any change that comes before then. */
  soon() {
    if (this.soonTimer || !this.timer) return;
    this.soonTimer = setTimeout(() => { this.soonTimer = undefined; void this.reconcile().catch(() => {}); }, rosterQuiet);
    this.soonTimer.unref?.();
  }
  /**
   * One pass over every member, after any pass already running. Calls made before a queued pass
   * starts share it, since it reads everything when it starts. Rejects when any step failed; the
   * steps that could go ahead did.
   */
  reconcile(): Promise<void> {
    if (this.queued) return this.queued;
    const run = this.queue.then(() => { this.queued = undefined; return this.pass(); });
    this.queued = run;
    this.queue = run.catch(() => {});
    return run;
  }

  /** The assistants with this app's sharing applied, or undefined while Hermes cannot say. */
  private async roster(): Promise<Bot[] | undefined> {
    const status = await this.runtime.status();
    if (!status.connected) return undefined;
    const bots = await this.runtime.listBots();
    // A disconnected Hermes reports its last roster as disconnected; it proves nothing.
    if (bots.length && bots.every(bot => bot.activity === "disconnected")) return undefined;
    return bots.map(bot => ({ ...bot, ...this.store.presentation(bot.id) }));
  }

  private async pass() {
    const bots = await this.roster();
    if (!bots) throw new ReconcileError([new Error("Hermes is unavailable, so check-ins were not reconciled.")], new Set(), true);
    const failures: unknown[] = [], members = new Set<string>();
    let whole = false;
    const household = this.store.users().filter(user => allowedIdentity(this.config, user));
    // A main assistant that was deleted, shared, or is no longer this member's own stops being one.
    for (const user of household) {
      const value = this.store.preferences(user.id);
      if (value.mainBotId && !mainEligible(bots.find(bot => bot.id === value.mainBotId), user.id)) this.clearMain(user.id);
    }
    const capabilities = await this.runtime.capabilities();
    if (capabilities.routines.supported) {
      const failed = (userId: string, error: unknown) => { failures.push(error); members.add(userId); };
      try { await serialDelivery(this.store, () => this.reconcileJobs(bots, household, failed)); }
      catch (error) { failures.push(error); whole = true; }
    }
    // The roster is guidance and a gate in Hermes, separate from anyone's check-ins.
    try { await this.pushPolicies(bots, household); } catch (error) { failures.push(error); }
    if (failures.length) {
      this.log.warn({ errors: failures.map(error => error instanceof Error ? error.message : String(error)) }, "Main assistant check-ins could not be reconciled yet");
      throw new ReconcileError(failures, members, whole);
    }
  }

  private clearMain(userId: string) {
    const value = this.store.preferences(userId);
    this.store.savePreferences(userId, { ...value, mainBotId: undefined, checkIns: value.checkIns && { ...value.checkIns, enabled: false } });
  }

  private wanted(user: { id: string; name: string }, bots: Bot[]) {
    const value = this.store.preferences(user.id);
    const bot = bots.find(row => row.id === value.mainBotId);
    if (!bot || !mainEligible(bot, user.id) || !value.checkIns?.enabled || !validCheckInHours(value.checkIns.everyHours)) return undefined;
    return { botId: bot.id, everyHours: value.checkIns.everyHours,
      prompt: checkInPrompt({ userId: user.id, member: user.name, timezone: value.checkIns.timezone, everyHours: value.checkIns.everyHours }) };
  }

  private async reconcileJobs(bots: Bot[], members: { id: string; name: string }[], failed: (userId: string, error: unknown) => void) {
    const jobs = await this.runtime.routines();
    const tracked = this.store.checkIns.current();
    const same = (job: Routine, row: { botId: string; jobId: string }) => job.botId === row.botId && job.id === row.jobId;
    // A tracked job Hermes no longer has is gone, whoever removed it.
    for (const row of tracked) if (!jobs.some(job => same(job, row))) this.store.checkIns.removed(row.botId, row.jobId);
    const held = new Map<string, Routine[]>();
    for (const job of jobs) {
      const member = tracked.find(row => same(job, row))?.userId ?? checkInMember(job.prompt);
      if (member) held.set(member, [...held.get(member) ?? [], job]);
    }
    const wanted = new Map(members.flatMap(user => { const want = this.wanted(user, bots); return want ? [[user.id, want] as const] : []; }));
    for (const userId of new Set([...held.keys(), ...wanted.keys()])) {
      const want = wanted.get(userId);
      const have = held.get(userId) ?? [];
      // The job this server created is kept over any other on the same assistant, such as one whose
      // creation looked failed but went through.
      const onBot = have.filter(job => job.botId === want?.botId);
      const keep = onBot.find(job => tracked.some(row => same(job, row))) ?? onBot[0];
      for (const job of have) if (job !== keep) {
        try { await this.remove(job); } catch (error) { failed(userId, error); }
      }
      if (!want) continue;
      const input = { botId: want.botId, name: CHECK_IN_ROUTINE_NAME, prompt: want.prompt, schedule: checkInSchedule(want.everyHours), enabled: true, recipientIds: [userId] };
      try {
        if (!keep) {
          const created = await this.runtime.saveRoutine(input);
          this.store.checkIns.track({ botId: want.botId, jobId: created.id, userId });
          this.store.routineRecipients(want.botId, created.id, [userId]);
        } else {
          this.store.checkIns.track({ botId: keep.botId, jobId: keep.id, userId });
          if (keep.prompt !== want.prompt || scheduleMinutes(keep.schedule) !== want.everyHours * 60 || !keep.enabled || keep.name !== CHECK_IN_ROUTINE_NAME)
            await this.runtime.saveRoutine(input, keep.id);
          if (JSON.stringify(this.store.getRoutineRecipients(keep.botId, keep.id)) !== JSON.stringify([userId]))
            this.store.routineRecipients(keep.botId, keep.id, [userId]);
        }
      } catch (error) { failed(userId, error); }
    }
  }

  /** A run in progress is stopped first, so nothing it finds is delivered after check-ins end. */
  private async remove(job: Routine) {
    if (job.running && this.runtime.stopRoutineRun) await this.runtime.stopRoutineRun(job.botId, job.id);
    await this.runtime.deleteRoutine(job.id, job.botId);
    this.store.checkIns.removed(job.botId, job.id);
    this.store.routineRecipients(job.botId, job.id, []);
  }

  /**
   * Each main assistant's roster: its member's other personal assistants, which it may message
   * freely, and the assistants the whole household sees, which need that member's yes first since
   * the whole household can read their chats. Another member's personal assistant is never listed.
   */
  policies(bots: Bot[], members: { id: string; name: string }[]): DelegationPolicies {
    const policies: DelegationPolicies = {};
    const target = (bot: Bot) => ({ id: bot.id, name: bot.name, ...(bot.description ? { description: bot.description } : {}) });
    for (const user of members) {
      const main = this.store.preferences(user.id).mainBotId;
      if (!main || !mainEligible(bots.find(bot => bot.id === main), user.id)) continue;
      const others = bots.filter(bot => bot.id !== main);
      policies[main] = { member: user.name,
        personal: others.filter(bot => mainEligible(bot, user.id)).map(target),
        shared: others.filter(bot => visible(bot, undefined)).map(target) };
    }
    return policies;
  }

  private async pushPolicies(bots: Bot[], members: { id: string; name: string }[]) {
    if (!this.runtime.delegationPolicy) return;
    const policies = this.policies(bots, members);
    const key = JSON.stringify(policies);
    // Sent again now and then, in case the add-on restarted from an older copy.
    if (key === this.policy.key && Date.now() - this.policy.at < policyRefresh) return;
    await this.runtime.delegationPolicy(policies);
    this.policy = { key, at: Date.now() };
  }
}

/**
 * Making someone's main assistant shared again: confirmed first, then its designation and check-ins
 * end before the sharing changes, so its check-ins never run in a chat the household can read.
 */
export async function endMainBeforeSharing(store: Store, mains: MainAssistants, userId: string, botId: string, confirmed: boolean | undefined) {
  const value = store.preferences(userId);
  if (value.mainBotId !== botId) return;
  if (!confirmed) throw httpError(409, `This is your main assistant. Sharing it ends that${value.checkIns?.enabled ? " and turns off its check-ins" : ""}.`, { code: "main_share_confirmation_required" });
  store.savePreferences(userId, { ...value, mainBotId: undefined, checkIns: value.checkIns && { ...value.checkIns, enabled: false } });
  await mains.reconcile().catch(() => {});
  if (store.checkIns.current().some(job => job.botId === botId))
    throw httpError(502, "Hermes hasn't removed this assistant's check-ins yet, so it stays personal. Try again in a minute.", { code: "check_in_removal_pending" });
}

export function installMainAssistantRoutes(app: FastifyInstance, collaborators: {
  runtime: Runtime;
  store: Store;
  mains: MainAssistants;
  preferences(userId: string): Preferences;
  requireCapability(key: CapabilityKey): Promise<void>;
}) {
  const { runtime, store, mains, preferences, requireCapability } = collaborators;
  const eligibleBot = async (userId: string, botId: string) => {
    const bot = (await runtime.listBots()).find(row => row.id === botId);
    const shown = bot && { ...bot, ...store.presentation(bot.id) };
    if (!shown || !visible(shown, userId)) throw httpError(404, notFound.error, { code: notFound.code });
    const reason = mainIneligibleReason(shown, userId);
    if (reason) throw httpError(409, `${shown.name} can't be your main assistant. ${reason}`, { code: "main_not_personal" });
    return shown;
  };
  // Clearing is an explicit null, never a missing field, so no client can clear it by not knowing it.
  apiRoute(app, "PUT /preferences/main", { body: z.object({ botId: id.nullable() }).strict() }, async (req, { botId }) => {
    const userId = signedIn(req).id;
    if (botId !== null) await eligibleBot(userId, botId);
    const value = store.preferences(userId);
    // A new main assistant starts without check-ins; the member turns them on for it.
    const changed = value.mainBotId !== (botId ?? undefined);
    store.savePreferences(userId, { ...value, mainBotId: botId ?? undefined, ...(changed && value.checkIns ? { checkIns: { ...value.checkIns, enabled: false } } : {}) });
    // The old main's check-ins go now; if Hermes refuses, the periodic pass removes them.
    if (changed) await mains.reconcile().catch(() => {});
    return preferences(userId);
  });
  apiRoute(app, "PUT /preferences/check-ins", {
    before: () => requireCapability("routines"),
    body: z.object({ enabled: z.boolean(), everyHours: z.number(), timezone }).strict(),
  }, async (req, settings) => {
    const userId = signedIn(req).id;
    if (!validCheckInHours(settings.everyHours)) throw httpError(400, "Check in every 1 to 4 hours.", { code: "check_in_hours" });
    const value = store.preferences(userId);
    if (!value.mainBotId) throw httpError(409, "Choose a main assistant before turning on check-ins.", { code: "main_required" });
    if (settings.enabled) await eligibleBot(userId, value.mainBotId);
    store.savePreferences(userId, { ...value, checkIns: settings });
    let failed = await mains.reconcile().then(() => undefined, (error: unknown) => error);
    // A create whose answer was lost may still have made the job, which one more pass adopts.
    if (failed && settings.enabled && !store.checkIns.current().some(row => row.userId === userId))
      failed = await mains.reconcile().then(() => undefined, (error: unknown) => error);
    const job = store.checkIns.current().find(row => row.userId === userId);
    const mine = !!failed && (!(failed instanceof ReconcileError) || failed.affects(userId));
    if (settings.enabled && !job) {
      // Nothing runs, so the switch must not say it does. A job Hermes made after all goes on the next pass.
      const now = store.preferences(userId);
      store.savePreferences(userId, { ...now, checkIns: { ...settings, enabled: false } });
      void mains.reconcile().catch(() => {});
      throw httpError(502, "Hermes couldn't set up check-ins. Try again.", { code: "check_in_unavailable", expose: true });
    }
    if (!settings.enabled && job)
      throw httpError(502, "Check-ins are off, but Hermes hasn't removed the routine yet. WildBots will keep trying.", { code: "check_in_removal_pending", expose: true });
    // Running, but perhaps on the old frequency.
    if (mine && settings.enabled)
      throw httpError(502, "Hermes couldn't update check-ins yet. WildBots will keep trying.", { code: "check_in_unavailable", expose: true });
    return preferences(userId);
  });
}
