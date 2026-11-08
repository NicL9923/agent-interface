import { timingSafeEqual } from "node:crypto";
import { visiblePreferences } from "./bootstrap-routes.js";
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
import { ownChatOnly } from "./collaboration.js";
import { routineTargets } from "./delivery-targets.js";
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
    && context.every(ref => ref === "self" || ref === job.id)
    // Every other native setting must be unset; a runtime that cannot list them can't prove that.
    && Array.isArray(job.nativeOverrides) && job.nativeOverrides.length === 0;
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
  private bots: Bot[] = [];
  /** Assistants being made main: Hermes holds them to a main assistant's limits before the choice is recorded. */
  private readonly activating = new Set<string>();
  /**
   * Protection is the default while unknown: until a routine inventory succeeds after this server starts,
   * every member's personal assistant is held to a main assistant's limits. After one, an assistant keeps
   * them while the last inventory left a signed check-in on it, whether kept, just made, or one Hermes
   * refused to delete. Both change only inside a pass, in turn with every other routine and main change.
   */
  private inventoried = false;
  private checkInBots = new Set<string>();
  /** The roster protocol Hermes enforced at the last send; 0 when it enforces none. */
  private enforced = 0;
  /** Rosters go to Hermes one at a time, each built from who sees what when it is sent. */
  private publishing: Promise<unknown> = Promise.resolve();
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
    const capabilities = await this.runtime.capabilities();
    const failed = (userId: string, error: unknown) => { failures.push(error); members.add(userId); };
    // In turn with making assistants main and routine changes, so protection comes off only on what this pass saw.
    await serialDelivery(this.store, async () => {
      // A main assistant that was deleted, shared, or is no longer this member's own stops being one.
      for (const user of household) {
        const value = this.store.preferences(user.id);
        if (value.mainBotId && !mainEligible(bots.find(bot => bot.id === value.mainBotId), user.id)) this.clearMain(user.id);
      }
      if (capabilities.routines.supported) {
        try { await this.reconcileJobs(bots, household, failed); }
        catch (error) { failures.push(error); whole = true; }
      }
      // Routines Hermes says are unavailable, as it does while disconnected, prove nothing: only an
      // inventory that listed them changes protection.
      // The roster is guidance and a gate in Hermes, separate from anyone's check-ins.
      this.bots = bots;
      try { await this.publish(); } catch (error) { failures.push(error); }
    });
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
    // Every assistant a signed check-in is still on, or may be, after this pass: kept, just made, or not deleted.
    const remaining = new Set<string>();
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
      if (keep) remaining.add(keep.botId);
      for (const job of have) if (job !== keep) {
        try { await this.remove(job); }
        catch (error) { remaining.add(job.botId); failed(userId, error); if (!(error instanceof RemovalError && error.safe)) unsafe = true; }
      }
      if (!want) continue;
      const input = { botId: want.botId, name: CHECK_IN_ROUTINE_NAME, prompt: want.prompt, schedule: checkInSchedule(want.everyHours), enabled: true, recipientIds: [userId] };
      try {
        if (!keep) {
          if (unsafe) throw new Error("An earlier check-in is still running in Hermes, so no new one was made.");
          // A create whose answer is lost may still have made it.
          remaining.add(want.botId);
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
    this.checkInBots = remaining;
    this.inventoried = true;
  }

  /** Whether this assistant may have a check-in on it: unknown until an inventory succeeds, then what the last one left. */
  private holdsCheckIn(botId: string) {
    return !this.inventoried || this.checkInBots.has(botId);
  }

  /**
   * A run in progress is stopped first, so nothing it finds is delivered after check-ins end. When
   * Hermes will not delete the job, it is paused instead, and the error says whether that worked.
   */
  private async remove(job: Routine) {
    // A pause only stops future runs, so a run in progress must be seen to have ended.
    let settled = !job.running;
    try {
      if (job.running) {
        if (!this.runtime.stopRoutineRun) throw new Error("This Hermes can't stop a routine's run.");
        await this.runtime.stopRoutineRun(job.botId, job.id);
        settled = !(await this.runtime.routines()).find(row => row.botId === job.botId && row.id === job.id)?.running;
        if (!settled) throw new Error("The routine's run is still going.");
      }
      await this.runtime.deleteRoutine(job.id, job.botId);
    } catch (error) {
      let paused = !job.enabled;
      if (!paused && this.runtime.setRoutineEnabled) {
        try { await this.runtime.setRoutineEnabled(job.botId, job.id, false); paused = true; } catch { /* Still scheduled. */ }
      }
      throw new RemovalError(error, paused && settled);
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
      // An assistant being made main is held to its limits first, and a former one keeps them while a check-in is on it.
      const main = this.store.preferences(owner).mainBotId === bot.id || this.activating.has(bot.id) || this.holdsCheckIn(bot.id);
      policies[bot.id] = { member: member.name, main, owned: true,
        personal: others.filter(other => mainEligible(other, owner)).map(target), shared: household };
    }
    return policies;
  }

  /**
   * Sends every assistant's roster, after any send already going. It is built when its turn comes, from
   * the sharing this app records at that moment over the last roster Hermes reported, so a send can never
   * carry sharing older than one that went before it.
   */
  private publish(force = false): Promise<number> {
    const run = this.publishing.then(async () => {
      if (!this.runtime.delegationPolicy) return 0;
      const bots = this.bots.map(bot => ({ ...bot, ...this.store.presentation(bot.id) }));
      const policies = this.policies(bots, this.household());
      const key = JSON.stringify(policies);
      // Sent again now and then, in case the add-on restarted from an older copy.
      if (!force && key === this.policy.key && Date.now() - this.policy.at < policyRefresh) return this.enforced;
      this.enforced = await this.runtime.delegationPolicy(policies);
      this.policy = { key, at: Date.now() };
      return this.enforced;
    });
    this.publishing = run.catch(() => {});
    return run;
  }

  /**
   * Makes an assistant main only once Hermes enforces it. Its roster goes to Hermes as a main one first;
   * once Hermes holds it, `check` reads its routines, and only if both succeed does `commit` record the
   * choice. Any failure sends the roster back as it was and refuses; if Hermes won't take that either, it
   * keeps the stricter roster until the next pass. Callers run this in turn with routine changes.
   */
  async activate(botId: string, check: () => Promise<void>, commit: () => void) {
    const refused = () => httpError(502, "Hermes didn't take this assistant's limits as a main assistant, so nothing changed. Try again.", { code: "main_activation_failed", expose: true });
    if (!this.runtime.delegationPolicy) throw httpError(409, "This Hermes can't hold a main assistant's limits, so none can be chosen.", { code: "main_activation_failed" });
    const bots = await this.roster().catch(() => undefined);
    if (!bots?.some(bot => bot.id === botId)) throw refused();
    this.bots = bots;
    this.activating.add(botId);
    try {
      const enforced = await this.publish(true).catch(() => { throw refused(); });
      if (enforced < 2) throw httpError(409, "This Hermes add-on can't hold a main assistant's limits, so none can be chosen. Update the add-on first.", { code: "main_activation_failed" });
      await check();
      commit();
    } catch (error) {
      this.activating.delete(botId);
      await this.publish(true).catch(() => {});
      throw error;
    }
    this.activating.delete(botId);
  }

  private household() { return this.store.users().filter(user => allowedIdentity(this.config, user)); }

  /**
   * Before an assistant's sharing changes, Hermes stops listing it anywhere and stops it reaching
   * anyone, so no roster built for its old sharing outlives the change. Throws, and nothing should
   * change, when Hermes did not take that roster.
   */
  async withdraw(botId: string) {
    if (!this.runtime.delegationPolicy) return;
    this.bots = (await this.roster()) ?? this.bots;
    this.withdrawn.add(botId);
    try { await this.publish(true); }
    catch (error) {
      this.log.warn({ error: error instanceof Error ? error.message : String(error) }, "Hermes did not take the withdrawn roster");
      throw httpError(502, "Hermes didn't update who this assistant can reach, so its sharing is unchanged. Try again.", { code: "roster_update_failed", expose: true });
    }
  }
  /**
   * After the sharing change settles, either way, its roster follows its sharing again. If Hermes does
   * not take that now it keeps the withdrawn roster, which reaches less, until a later send succeeds.
   */
  async release(botId: string) {
    if (!this.withdrawn.delete(botId)) return;
    await this.publish(true).catch(() => {});
    await this.reconcile().catch(() => {});
  }
}

/** A deletion Hermes refused; `safe` says the job can no longer run: paused, with no run in progress. */
export class RemovalError extends Error {
  constructor(readonly cause: unknown, readonly safe: boolean) {
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
  // Decided and cleared in turn with every other main change, from the designation as it is then.
  const ending = await serialDelivery(store, async () => {
    const value = store.preferences(userId);
    const main = value.mainBotId === botId;
    if (!main && !await mains.checkInsOn(botId)) return false;
    if (!confirmed) throw httpError(409, main ? `This is your main assistant. Sharing it ends that${value.checkIns?.enabled ? " and turns off its check-ins" : ""}.`
      : "This assistant still has check-ins. Sharing it turns them off.", { code: "main_share_confirmation_required" });
    if (main) store.savePreferences(userId, { ...value, mainBotId: undefined, checkIns: value.checkIns && { ...value.checkIns, enabled: false } });
    return true;
  });
  if (!ending) return;
  await mains.reconcile().catch(() => {});
  if (await mains.checkInsOn(botId))
    throw httpError(502, "Hermes hasn't removed this assistant's check-ins yet, so it stays personal. Try again in a minute.",
      { code: "check_in_removal_pending", expose: true, preferences: visiblePreferences(store, userId) });
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
  /**
   * A main assistant's routines post only in its own chat. An assistant with a routine already posting
   * anywhere else, from before it was made main or outside WildBots, waits until that routine changes.
   * So does one with a run going or a delivery Hermes still holds, whatever its destination: each keeps
   * a copy of the routine as it was, which a change to the saved routine doesn't reach.
   */
  const assertRoutinesSettled = async (bot: Bot) => {
    if (!(await runtime.capabilities()).routines.supported) return;
    const unread = () => httpError(409, `WildBots couldn't check ${bot.name}'s routines, so it isn't your main assistant yet. Try again.`, { code: "main_routine_delivery" });
    let routines: Routine[];
    try { routines = (await runtime.routines()).filter(routine => routine.botId === bot.id); }
    catch { throw unread(); }
    const elsewhere = routines.filter(routine => !ownChatOnly(bot.id, routineTargets(routine)));
    if (elsewhere.length)
      throw httpError(409, `${bot.name} can't be your main assistant while these routines post outside its own chat: ${elsewhere.map(routine => `"${routine.name}"`).join(", ")}. Change where they deliver first.`,
        { code: "main_routine_delivery" });
    if (!runtime.routineDeliveries) throw unread();
    let held: { id: string; name: string }[];
    try { held = await runtime.routineDeliveries(bot.id); }
    catch { throw unread(); }
    const busy = new Set([...routines.filter(routine => routine.running || routine.inFlight).map(routine => routine.name),
      ...held.map(row => routines.find(routine => routine.id === row.id)?.name ?? (withoutBotTag(row.name).trim() || "A routine"))]);
    if (busy.size)
      throw httpError(409, `${[...busy].map(name => `"${name}"`).join(", ")} ${busy.size === 1 ? "is" : "are"} running or waiting to deliver, so ${bot.name} can't be your main assistant yet. Try again when ${busy.size === 1 ? "it finishes" : "they finish"}.`,
        { code: "main_routine_busy" });
  };
  // Clearing is an explicit null, never a missing field, so no client can clear it by not knowing it.
  apiRoute(app, "PUT /preferences/main", { body: z.object({ botId: id.nullable() }).strict() }, async (req, { botId }) => {
    const userId = signedIn(req).id;
    const commit = () => {
      const value = store.preferences(userId);
      // A new main assistant starts without check-ins; the member turns them on for it.
      const changed = value.mainBotId !== (botId ?? undefined);
      store.savePreferences(userId, { ...value, mainBotId: botId ?? undefined, ...(changed && value.checkIns ? { checkIns: { ...value.checkIns, enabled: false } } : {}) });
    };
    // Every request, a reaffirmation or a no-op included, decides from the designation as it is in its turn,
    // after any other main change, routine save or trigger ahead of it.
    const before = await serialDelivery(store, async () => {
      const current = store.preferences(userId).mainBotId;
      if (botId === null) { commit(); return current; }
      const bot = await eligibleBot(userId, botId);
      if (store.preferences(userId).mainBotId !== botId) await mains.activate(bot.id, () => assertRoutinesSettled(bot), commit);
      return current;
    });
    if (before && before !== botId) {
      // The old main's check-ins go now. Until Hermes confirms they are gone, that assistant keeps a main
      // assistant's limits in Hermes, and the member hears the change isn't finished.
      await mains.reconcile().catch(() => {});
      if (await mains.checkInsOn(before))
        throw httpError(502, "Your previous main assistant still has a check-in in Hermes, so it keeps a main assistant's limits until WildBots removes it. WildBots will keep trying.",
          { code: "main_clear_pending", expose: true, preferences: preferences(userId) });
    }
    return preferences(userId);
  });
  // Each member's latest check-ins save, so a failed setup's rollback never undoes a newer request, even
  // one that asked for identical settings.
  const checkInRevisions = new Map<string, number>();
  apiRoute(app, "PUT /preferences/check-ins", {
    before: () => requireCapability("routines"),
    body: z.object({ enabled: z.boolean(), everyHours: z.number(), timezone }).strict(),
  }, async (req, settings) => {
    const userId = signedIn(req).id;
    if (!validCheckInHours(settings.everyHours)) throw httpError(400, "Check in every 1 to 4 hours.", { code: "check_in_hours" });
    // Read, checked and written in turn with main changes, so a clear can't land between the read and the
    // write and be undone by it. Reconciled after the turn, since a pass takes its own.
    const revision = await serialDelivery(store, async () => {
      const mainBotId = store.preferences(userId).mainBotId;
      if (!mainBotId) throw httpError(409, "Choose a main assistant before turning on check-ins.", { code: "main_required" });
      if (settings.enabled) await eligibleBot(userId, mainBotId);
      store.savePreferences(userId, { ...store.preferences(userId), checkIns: settings });
      const saved = (checkInRevisions.get(userId) ?? 0) + 1;
      checkInRevisions.set(userId, saved);
      return saved;
    });
    let failed = await mains.reconcile().then(() => undefined, (error: unknown) => error);
    // A create whose answer was lost may still have made the job, which one more pass adopts.
    if (failed && settings.enabled && !store.checkIns.current().some(row => row.userId === userId))
      failed = await mains.reconcile().then(() => undefined, (error: unknown) => error);
    const job = store.checkIns.current().find(row => row.userId === userId);
    const mine = !!failed && (!(failed instanceof ReconcileError) || failed.affects(userId));
    if (settings.enabled && !job) {
      // Nothing runs, so the switch must not say it does, unless a later request saved since, even with the
      // same settings. A job Hermes made after all goes on the next pass.
      await serialDelivery(store, async () => {
        if (checkInRevisions.get(userId) !== revision) return;
        const now = store.preferences(userId);
        store.savePreferences(userId, { ...now, checkIns: { ...settings, enabled: false } });
      });
      void mains.reconcile().catch(() => {});
      throw httpError(502, "Hermes couldn't set up check-ins. Try again.", { code: "check_in_unavailable", expose: true, preferences: preferences(userId) });
    }
    if (!settings.enabled && job)
      throw httpError(502, "Check-ins are off, but Hermes hasn't removed the routine yet. WildBots will keep trying.", { code: "check_in_removal_pending", expose: true, preferences: preferences(userId) });
    // Running, but perhaps on the old frequency.
    if (mine && settings.enabled)
      throw httpError(502, "Hermes couldn't update check-ins yet. WildBots will keep trying.", { code: "check_in_unavailable", expose: true, preferences: preferences(userId) });
    return preferences(userId);
  });
}
