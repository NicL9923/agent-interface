import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CHECK_IN_ROUTINE_NAME, checkInSchedule, scheduleMinutes, mainEligible, mainIneligibleReason, validCheckInHours } from "../shared/main-assistant.js";
import type { Bot, CapabilityKey, DelegationPolicies, Preferences, Routine, Runtime, RuntimeEvent } from "../shared/types.js";
import { withoutBotTag } from "../shared/event-copy.js";
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

/**
 * The first line of a check-in's prompt: its member and assistant, signed with this installation's
 * secret, so a job this server lost track of is still found and a copied marker is never trusted.
 */
export const checkInMarker = (store: Store, botId: string, userId: string) =>
  `[WildBots check-in for member ${userId} on ${botId}, ${store.accounts.checkInSignature(botId, userId)}]`;
const markerPattern = /^\[WildBots check-in for member ([^\]\s]+) on ([^\]\s,]+), ([A-Za-z0-9_-]+)\]/;
/** Anything that looks like a check-in marker, signed or not. */
const markerPrefix = /^\s*\[WildBots check-in\b/i;
/** The member a job is a genuine check-in for: its marker names this job's assistant and its signature verifies. */
export function signedCheckInMember(store: Store, job: Pick<Routine, "botId" | "prompt">): string | undefined {
  const match = markerPattern.exec(job.prompt ?? "");
  // The signature covers this job's own assistant, so a marker copied from another assistant's job fails it.
  if (!match) return undefined;
  const expected = Buffer.from(store.accounts.checkInSignature(job.botId, match[1])), given = Buffer.from(match[3]);
  return expected.length === given.length && timingSafeEqual(expected, given) ? match[1] : undefined;
}

/**
 * Whether a job runs exactly as a check-in must: into its own assistant's chat only, with no failure
 * delivery, rooms or execution overrides. Anything else, such as delivery to another assistant's
 * chat, a group room or a script, would take what the check-in reads to someone else.
 */
export function managedConfig(job: Routine) {
  const tokens = String(job.delivery?.deliver ?? "").split(",").map(part => part.trim().toLowerCase()).filter(Boolean);
  const failure = job.delivery?.failure_deliver;
  const empty = (value: unknown) => value === undefined || value === null || value === "" || Array.isArray(value) && value.length === 0;
  const context = job.contextFrom ?? [];
  return tokens.length === 1 && (tokens[0] === `bot-chat:${job.botId.toLowerCase()}` || tokens[0] === "bot-chat")
    && empty(failure) && empty(job.roomIds) && empty(job.skills) && empty(job.model) && empty(job.provider)
    && empty(job.enabledToolsets) && empty(job.script) && job.noAgent !== true
    && context.every(ref => ref === "self" || ref === job.id);
}

export function checkInPrompt(input: { marker: string; member: string; timezone: string; everyHours: number }) {
  const { member } = input;
  return [
    input.marker,
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
  return store.checkIns.current().some(job => job.botId === routine.botId && job.jobId === routine.id) || !!signedCheckInMember(store, routine);
}
export function assertNotManaged(store: Store, routine: Pick<Routine, "botId" | "id" | "prompt">, botName = "its assistant") {
  if (isManagedCheckIn(store, routine))
    throw httpError(409, `These are check-ins. Change or turn them off from ${botName}'s details.`, { code: "check_in_managed" });
}
/** Nobody writes a check-in's marker into a routine of their own, which would make it look managed. */
export function assertNoMarker(prompt: string) {
  if (markerPrefix.test(prompt)) throw httpError(400, "Routine instructions can't start with a WildBots check-in marker.", { code: "check_in_marker" });
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
  /** Assistants whose sharing is changing: no roster lists them, and they reach nobody, until the change settles. */
  private readonly withdrawn = new Set<string>();
  /** Withdrawn assistants whose change settled but whose roster Hermes has not taken yet. */
  private readonly releasing = new Set<string>();
  private bots: Bot[] = [];
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
    this.bots = bots;
    const released = [...this.releasing];
    for (const botId of released) this.withdrawn.delete(botId);
    try { await this.pushPolicies(bots, household, released.length > 0); for (const botId of released) this.releasing.delete(botId); }
    catch (error) { for (const botId of released) this.withdrawn.add(botId); failures.push(error); }
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
      prompt: checkInPrompt({ marker: checkInMarker(this.store, bot.id, user.id), member: user.name, timezone: value.checkIns.timezone, everyHours: value.checkIns.everyHours }) };
  }

  private async reconcileJobs(bots: Bot[], members: { id: string; name: string }[], failed: (userId: string, error: unknown) => void) {
    const jobs = await this.runtime.routines();
    const tracked = this.store.checkIns.current();
    const same = (job: Routine, row: { botId: string; jobId: string }) => job.botId === row.botId && job.id === row.jobId;
    // A tracked job Hermes no longer has is gone, whoever removed it.
    for (const row of tracked) if (!jobs.some(job => same(job, row))) this.store.checkIns.removed(row.botId, row.jobId);
    const held = new Map<string, Routine[]>();
    for (const job of jobs) {
      const member = tracked.find(row => same(job, row))?.userId ?? signedCheckInMember(this.store, job);
      if (member) held.set(member, [...held.get(member) ?? [], job]);
    }
    const wanted = new Map(members.flatMap(user => { const want = this.wanted(user, bots); return want ? [[user.id, want] as const] : []; }));
    for (const userId of new Set([...held.keys(), ...wanted.keys()])) {
      const want = wanted.get(userId);
      const have = held.get(userId) ?? [];
      // Only a job that runs exactly as a check-in must is kept; one delivering elsewhere or carrying
      // overrides goes, whoever made it. The job this server created is kept over any other copy.
      const onBot = have.filter(job => job.botId === want?.botId && managedConfig(job));
      const keep = onBot.find(job => tracked.some(row => same(job, row))) ?? onBot[0];
      // A replacement waits until every job it would replace is deleted or at least paused.
      let unsafe = false;
      for (const job of have) if (job !== keep) {
        try { await this.remove(job); }
        catch (error) { failed(userId, error); if (!(error instanceof RemovalError && error.paused)) unsafe = true; }
      }
      if (!want) continue;
      const input = { botId: want.botId, name: CHECK_IN_ROUTINE_NAME, prompt: want.prompt, schedule: checkInSchedule(want.everyHours), enabled: true, recipientIds: [userId] };
      try {
        if (!keep) {
          if (unsafe) throw new Error("An earlier check-in is still running in Hermes, so no new one was made.");
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

  /**
   * A run in progress is stopped first, so nothing it finds is delivered after check-ins end. When
   * Hermes will not delete the job, it is paused instead, and the error says whether that worked.
   */
  private async remove(job: Routine) {
    try {
      if (job.running && this.runtime.stopRoutineRun) await this.runtime.stopRoutineRun(job.botId, job.id);
      await this.runtime.deleteRoutine(job.id, job.botId);
    } catch (error) {
      let paused = !job.enabled;
      if (!paused && this.runtime.setRoutineEnabled) {
        try { await this.runtime.setRoutineEnabled(job.botId, job.id, false); paused = true; } catch { /* Still running. */ }
      }
      throw new RemovalError(error, paused);
    }
    this.store.checkIns.removed(job.botId, job.id);
    this.store.routineRecipients(job.botId, job.id, []);
  }

  /** Whether any check-in job, recorded here or signed in Hermes, is on this assistant. A failed read counts as yes. */
  async checkInsOn(botId: string) {
    if (this.store.checkIns.current().some(job => job.botId === botId)) return true;
    try { return (await this.runtime.routines()).some(job => job.botId === botId && !!signedCheckInMember(this.store, job)); }
    catch { return true; }
  }

  /**
   * Records which routines in discovered events are check-ins before the events are stored, so a
   * check-in whose creation answer was lost, and that this server has not reconciled yet, is still
   * quiet. A read that fails leaves the events undiscovered for the next tick.
   */
  async identify(events: RuntimeEvent[]) {
    const unknown = events.filter(event => event.routineId && !this.store.checkIns.isCheckIn(event.botId, event.routineId));
    if (!unknown.length) return;
    const jobs = await this.runtime.routines();
    for (const event of unknown) {
      const job = jobs.find(row => row.botId === event.botId && row.id === event.routineId);
      const member = job && signedCheckInMember(this.store, job);
      if (member) this.store.checkIns.track({ botId: event.botId, jobId: event.routineId!, userId: member });
      // A job already gone cannot be checked. One that was named as a check-in is treated as one, which can only
      // keep a notification back, never send one.
      else if (!job && withoutBotTag(event.title).trim() === CHECK_IN_ROUTINE_NAME) (event as RuntimeEvent & { checkIn?: boolean }).checkIn = true;
    }
  }

  /**
   * Every assistant's roster, which Hermes enforces for its prompt, hand-offs and routine deliveries.
   * A personal assistant sees its owner's other personal assistants and the assistants the whole
   * household sees; a main assistant must ask its member before reaching the latter. A shared or
   * ownerless assistant sees only the household's. Another member's personal assistant is never
   * listed, and nor is an assistant whose sharing is changing.
   */
  policies(bots: Bot[], members: { id: string; name: string }[]): DelegationPolicies {
    const policies: DelegationPolicies = {};
    const target = (bot: Bot) => ({ id: bot.id, name: bot.name, ...(bot.description ? { description: bot.description } : {}) });
    for (const bot of bots) {
      const owner = bot.shared === false && bot.ownerId ? bot.ownerId : undefined;
      const others = bots.filter(other => other.id !== bot.id && !this.withdrawn.has(other.id));
      const household = others.filter(other => visible(other, undefined)).map(target);
      if (this.withdrawn.has(bot.id)) { policies[bot.id] = { member: "", main: false, owned: true, personal: [], shared: [] }; continue; }
      if (!owner) { policies[bot.id] = { member: "the household", main: false, owned: false, personal: [], shared: household }; continue; }
      const member = members.find(user => user.id === owner);
      // An owner who left the household keeps nothing reachable.
      if (!member) { policies[bot.id] = { member: "", main: false, owned: true, personal: [], shared: [] }; continue; }
      policies[bot.id] = { member: member.name, main: this.store.preferences(owner).mainBotId === bot.id, owned: true,
        personal: others.filter(other => mainEligible(other, owner)).map(target), shared: household };
    }
    return policies;
  }

  private async pushPolicies(bots: Bot[], members: { id: string; name: string }[], force = false) {
    if (!this.runtime.delegationPolicy) return;
    const policies = this.policies(bots, members);
    const key = JSON.stringify(policies);
    // Sent again now and then, in case the add-on restarted from an older copy.
    if (!force && key === this.policy.key && Date.now() - this.policy.at < policyRefresh) return;
    await this.runtime.delegationPolicy(policies);
    this.policy = { key, at: Date.now() };
  }

  private household() { return this.store.users().filter(user => allowedIdentity(this.config, user)); }

  /**
   * Before an assistant's sharing changes, Hermes stops listing it anywhere and stops it reaching
   * anyone, so no roster built for its old sharing outlives the change. Throws, and nothing should
   * change, when Hermes did not take that roster.
   */
  async withdraw(botId: string) {
    if (!this.runtime.delegationPolicy) return;
    this.withdrawn.add(botId);
    this.releasing.delete(botId);
    const bots = (await this.roster()) ?? this.bots;
    try { await this.pushPolicies(bots.map(bot => ({ ...bot, ...this.store.presentation(bot.id) })), this.household(), true); }
    catch (error) {
      this.log.warn({ error: error instanceof Error ? error.message : String(error) }, "Hermes did not take the withdrawn roster");
      throw httpError(502, "Hermes didn't update who this assistant can reach, so its sharing is unchanged. Try again.", { code: "roster_update_failed", expose: true });
    }
  }
  /** After the sharing change settles, either way: its roster follows its sharing again once Hermes takes it. */
  async release(botId: string) {
    if (!this.withdrawn.has(botId)) return;
    this.releasing.add(botId);
    await this.reconcile().catch(() => {});
  }
}

/** A deletion Hermes refused; `paused` says whether the job was at least stopped from running. */
export class RemovalError extends Error {
  constructor(readonly cause: unknown, readonly paused: boolean) {
    super(cause instanceof Error ? cause.message : "Hermes did not remove the routine.");
  }
}

/**
 * Making a personal assistant shared: when it is its owner's main assistant, or any check-in job is
 * still on it (recorded here or signed in Hermes, as after an earlier attempt that cleared the main
 * designation but could not remove the job), the owner confirms, the designation ends, and every
 * check-in job on it must be confirmed gone before the sharing changes.
 */
export async function endCheckInsBeforeSharing(store: Store, mains: MainAssistants, userId: string, botId: string, confirmed: boolean | undefined) {
  const value = store.preferences(userId);
  const main = value.mainBotId === botId;
  if (!main && !await mains.checkInsOn(botId)) return;
  if (!confirmed) throw httpError(409, main ? `This is your main assistant. Sharing it ends that${value.checkIns?.enabled ? " and turns off its check-ins" : ""}.`
    : "This assistant still has check-ins. Sharing it turns them off.", { code: "main_share_confirmation_required" });
  if (main) store.savePreferences(userId, { ...value, mainBotId: undefined, checkIns: value.checkIns && { ...value.checkIns, enabled: false } });
  await mains.reconcile().catch(() => {});
  if (await mains.checkInsOn(botId))
    throw httpError(502, "Hermes hasn't removed this assistant's check-ins yet, so it stays personal. Try again in a minute.", { code: "check_in_removal_pending", expose: true });
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
