import type { ActivityState, Bot, Conversation, Runtime } from "../shared/types.js";
import { allowedIdentity, type Config } from "./config.js";
import type { CoveredRun, LiveActivityRegistration, LiveActivityStartRegistration, Store } from "./store.js";
import { visible } from "./bot-access.js";
import { FailureTracker, quietLog, type Log } from "./logging.js";
import { ApnsError } from "./apns.js";

import type { LivePhase, LiveRow, LiveState } from "../shared/live-activity.js";
export type { LivePhase, LiveRow, LiveState } from "../shared/live-activity.js";

export type LiveActivitySender = (target: { token: string; environment: "sandbox" | "production" }, payload: object, priority: 5 | 10) => Promise<void>;

const status: Record<LivePhase, string> = {
  starting: "Starting", thinking: "Thinking", working: "Working", waiting: "Needs approval",
  blocked: "Needs input", done: "Done", failed: "Failed", interrupted: "Stopped",
};
const rank: Record<LivePhase, number> = { waiting: 0, blocked: 0, failed: 1, interrupted: 1, starting: 2, thinking: 2, working: 2, done: 3 };
const activeStates = new Set<ActivityState>(["thinking", "working", "waiting", "blocked"]);
const terminal = (phase: LivePhase) => phase === "done" || phase === "failed" || phase === "interrupted";
const attention = (phase: LivePhase) => phase === "waiting" || phase === "blocked";
const seconds = (ms: number) => Math.floor(ms / 1000);
const fit = (value: string | undefined, limit: number) => {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const characters = [...text];
  return characters.length <= limit ? text : characters.slice(0, limit - 1).join("") + "…";
};

/** Starting rows wait this long for Hermes to report the run, and the activity never ends sooner. */
export const ARMED_MS = 120_000;
/** Finished rows stay beside others' running work this long. */
export const FINISHED_MS = 15 * 60_000;
const THROTTLE_MS = 15_000;
const HEARTBEAT_MS = 5 * 60_000;
const STALE_S = 15 * 60;
const DISMISS_S = 5 * 60;
const MAX_ROWS = 4;

/**
 * Builds each person's aggregate of assistant work and pushes it to their devices' Live
 * Activities. Rows follow the notification rule: run participants and followers, and a
 * private assistant only for its owner.
 */
export class LiveActivities {
  readonly push: FailureTracker;
  constructor(
    private store: Store,
    private runtime: Pick<Runtime, "listBots" | "conversation">,
    private config: Config,
    private send?: LiveActivitySender,
    private log: Log = quietLog,
    private now: () => number = Date.now,
  ) {
    this.push = new FailureTracker(log, "Live Activity delivery");
  }

  /** The current aggregate for one person, as the app shows before or without a push. */
  async state(userId: string, armed?: Pick<LiveActivityRegistration, "armed" | "armedAt">, previous?: LiveState) {
    return (await this.build(userId, await this.runtime.listBots(), new Map(), armed, previous)).state;
  }

  async tick() {
    if (!this.send || !this.config.apns) return;
    const allowed = ({ userId }: { userId: string }) => {
      const user = this.store.getUser(userId);
      return !!user && allowedIdentity(this.config, user);
    };
    const registrations = this.store.liveActivities(this.config.apns.environment, this.now()).filter(allowed);
    const starts = this.store.liveActivityStarts(this.config.apns.environment, this.now()).filter(allowed);
    if (!registrations.length && !starts.length) return;
    const roster = await this.runtime.listBots();
    const conversations = new Map<string, Promise<Conversation | undefined>>();
    const startFor = new Map(starts.map(start => [start.deviceId, start]));
    for (const registration of registrations) {
      try {
        const { state, active } = await this.build(registration.userId, roster, conversations, registration, registration.lastState);
        // Remember what this activity covers before delivery, which forgets a dismissed one, so
        // dismissing it keeps that work off the Lock Screen.
        const start = startFor.get(registration.deviceId);
        if (start) this.store.liveActivityStartCovered(start.deviceId, start.token, remember(start.started, active));
        await this.deliver(registration, state);
      } catch (error) {
        this.push.failure(error);
      }
    }
    if (!starts.length) return;
    const running = this.store.liveActivityDevices();
    for (const start of starts) {
      try {
        if (running.has(start.deviceId)) continue;
        const { state, active } = await this.build(start.userId, roster, conversations);
        await this.begin(start, state, active);
      } catch (error) {
        this.push.failure(error);
      }
    }
  }

  /**
   * Starts the device's activity by push when work begins that the app did not start itself, such
   * as a routine or a message sent from the web. Work an earlier activity already showed, including
   * one the person dismissed, does not start another; only a newly running assistant does.
   */
  private async begin(listed: LiveActivityStartRegistration, state: LiveState, active: CoveredRun[]) {
    // Building the state waited on Hermes. Meanwhile another account may have taken the token over,
    // the session may have ended, the app may have started or registered its own activity.
    const start = this.store.liveActivityStart(listed.deviceId);
    if (!start || start.token !== listed.token || start.userId !== listed.userId || start.scope !== listed.scope
      || this.store.liveActivityDevices().has(start.deviceId)) return;
    // The app dismissed its activity before any pass recorded what it showed: whatever runs now
    // was on it, or began within a pass of it, so it stays off the Lock Screen.
    if (start.dismissed) {
      this.store.liveActivityStartCovered(start.deviceId, start.token, remember(start.started, active));
      return;
    }
    // Coverage lasts only while that run does: an assistant's next run is new work, even when it
    // began between two passes. A run first seen before Hermes named it takes its name now.
    const covered = remember(start.started, active).filter(run => start.started.some(old => sameRun(old, run)));
    if (JSON.stringify(covered) !== JSON.stringify(start.started)) this.store.liveActivityStartCovered(start.deviceId, start.token, covered);
    if (!active.length) return;
    const now = this.now();
    // The app starts its own activity right after a send; a pushed one would be a duplicate.
    if (now - start.localAt < ARMED_MS || covered.length === active.length) return;
    const hero = state.rows.find(row => !terminal(row.phase));
    const aps = {
      timestamp: seconds(now), event: "start", "content-state": state, "stale-date": seconds(now) + STALE_S,
      "attributes-type": "AssistantsActivityAttributes", attributes: { scope: start.scope },
      // iOS requires an alert to start an activity. Without a sound it only lights the Lock Screen.
      // Approval details stay in the signed-in chat, as in notifications.
      alert: { title: state.title, body: hero?.status ?? "Working" },
      // Asks iOS 18 for the new activity's update token and wakes the app to register it.
      "input-push-token": 1,
    };
    // The scope and alert ride beside the state; shed previews and rows to stay inside APNs' limit.
    shed(state, 3500 - Buffer.byteLength(JSON.stringify({ ...aps, "content-state": undefined })));
    try {
      await this.send!({ token: start.token, environment: start.environment }, { aps }, 10);
      this.push.success();
    } catch (error) {
      const apns = error instanceof ApnsError ? error : undefined;
      if (apns && rejected(apns)) {
        this.store.removeLiveActivityStartToken(start.deviceId, start.token);
        return;
      }
      this.store.liveActivityStartFailed(start.deviceId, start.token, now);
      throw error;
    }
    this.store.liveActivityStartCovered(start.deviceId, start.token, active);
  }

  private async deliver(registration: LiveActivityRegistration, state: LiveState) {
    const now = this.now(), previous = registration.sentState;
    this.store.liveActivityObserved(registration.deviceId, registration.token, state, state.rows.filter(row => row.phase !== "starting").map(row => row.botId));
    registration.armed = registration.armed.filter(id => state.rows.some(row => row.botId === id && row.phase === "starting"));
    // A just-sent message keeps the activity open until Hermes reports it or the grace period passes.
    const armed = registration.armed.length > 0 && now - registration.armedAt < ARMED_MS;
    if (!state.activeCount && !armed) {
      // Only finished work remains: show it a few minutes more, then the system removes the card.
      const rows = state.rows.filter(row => terminal(row.phase));
      const final = { ...state, rows, title: rows.length ? state.title : "All caught up" };
      await this.post(registration, { aps: { timestamp: seconds(now), event: "end", "content-state": final, "dismissal-date": seconds(now) + DISMISS_S } }, 10);
      this.store.removeLiveActivity(registration.userId, registration.deviceId, registration.token);
      return;
    }
    const changed = !previous || signature(previous) !== signature(state);
    const urgent = !previous || state.attentionCount > previous.attentionCount || state.activeCount !== previous.activeCount
      || state.rows.some(row => terminal(row.phase) && !previous.rows.some(old => old.botId === row.botId && old.phase === row.phase));
    const since = now - registration.sentAt;
    if (!(changed && (urgent || since >= THROTTLE_MS)) && since < HEARTBEAT_MS) return;
    const rising = !!previous && state.attentionCount > previous.attentionCount;
    await this.post(registration, { aps: { timestamp: seconds(now), event: "update", "content-state": state, "stale-date": seconds(now) + STALE_S } }, rising ? 10 : 5);
    this.store.liveActivitySent(registration.deviceId, registration.token, state, now);
  }

  private async post(registration: LiveActivityRegistration, payload: object, priority: 5 | 10) {
    try {
      await this.send!({ token: registration.token, environment: registration.environment }, payload, priority);
      this.push.success();
    } catch (error) {
      const apns = error instanceof ApnsError ? error : undefined;
      if (apns && rejected(apns)) {
        this.store.removeLiveActivity(registration.userId, registration.deviceId, registration.token);
        return;
      }
      // Keep the previous state so the change is retried after a backoff.
      this.store.liveActivityFailed(registration.deviceId, registration.token, this.now());
      throw error;
    }
  }

  /** The person's aggregate, and every running assistant in it, including rows it has no room for. */
  private async build(
    userId: string, roster: Bot[], conversations: Map<string, Promise<Conversation | undefined>>,
    armed?: Pick<LiveActivityRegistration, "armed" | "armedAt">, previous?: LiveState,
  ): Promise<{ state: LiveState; active: CoveredRun[] }> {
    const now = this.now();
    const follows = new Set(this.store.preferences(userId).followBots);
    const arming = armed && now - armed.armedAt < ARMED_MS ? new Set(armed.armed) : new Set<string>();
    const shown = new Map(previous?.rows.map(row => [row.botId, row]));
    const conversation = (botId: string) => {
      // An unreadable conversation falls back to the roster state instead of dropping the person's whole aggregate.
      if (!conversations.has(botId)) conversations.set(botId, Promise.resolve().then(() => this.runtime.conversation(botId, { history: false })).catch(() => undefined));
      return conversations.get(botId)!;
    };
    const rows: LiveRow[] = [];
    const runs = new Map<string, string>();
    for (const bot of roster) {
      // Keep canonical IDs intact. An oversized ID cannot fit into a usable ActivityKit row.
      if (Buffer.byteLength(bot.id) > 256) continue;
      const presentation = this.store.presentation(bot.id);
      if (!visible(presentation, userId)) continue;
      const before = shown.get(bot.id);
      const candidate = activeStates.has(bot.activity) || arming.has(bot.id) || (before && !terminal(before.phase));
      let row: LiveRow | undefined;
      if (candidate) {
        const current = await conversation(bot.id);
        const state = current?.activity.state ?? bot.activity;
        const mine = arming.has(bot.id) || follows.has(bot.id) || !!before
          || (!!current?.activity.runId && this.store.participants(current.activity.runId).includes(userId));
        if (mine && activeStates.has(state)) {
          const phase = state as LivePhase;
          if (current?.activity.runId) runs.set(bot.id, current.activity.runId);
          row = { botId: bot.id, name: bot.name, phase, status: status[phase], detail: fit(current?.activity.detail, 80),
            since: before?.phase === phase && before.since ? before.since : seconds(now) };
        } else if (mine && before && !terminal(before.phase) && before.phase !== "starting" || arming.has(bot.id) && finishedSince(bot, armed!.armedAt)) {
          const phase: LivePhase = state === "failed" || state === "interrupted" ? state : "done";
          row = { botId: bot.id, name: bot.name, phase, status: status[phase], detail: fit(phase === "done" ? bot.lastMessage?.text : current?.activity.detail, 80), since: seconds(now) };
        } else if (arming.has(bot.id) && (!before || before.phase === "starting" || terminal(before.phase))) {
          row = { botId: bot.id, name: bot.name, phase: "starting", status: status.starting, since: before?.phase === "starting" ? before.since : seconds(armed!.armedAt) };
        }
      } else if (before && terminal(before.phase) && now - (before.since ?? 0) * 1000 < FINISHED_MS) {
        row = { ...before, name: bot.name };
      }
      if (!row) continue;
      row.name = fit(row.name, 80) ?? "Assistant";
      // Hermes carries the avatar when it supports metadata; otherwise the app stores it.
      const avatar = bot.avatar ?? presentation.avatar;
      if (avatar && avatar.mode !== "portrait" && /^#[0-9a-f]{6}$/i.test(avatar.color ?? "")) row.color = avatar.color;
      rows.push(row);
    }
    rows.sort((a, b) => rank[a.phase] - rank[b.phase] || (b.since ?? 0) - (a.since ?? 0));
    const active = rows.filter(row => !terminal(row.phase));
    const waiting = rows.filter(row => attention(row.phase));
    const state: LiveState = { title: fit(title(rows, active.length, waiting.length), 80) ?? "Assistant activity", activeCount: active.length, attentionCount: waiting.length,
      updatedAt: seconds(now), rows: rows.slice(0, MAX_ROWS) };
    // Reserve room for the APNs envelope.
    return { state: shed(state, 3500), active: active.map(row => runs.has(row.botId) ? { botId: row.botId, runId: runs.get(row.botId) } : { botId: row.botId }) };
  }
}

/**
 * Fits a state into `limit` bytes of JSON, which counts Unicode and escapes. Previews go first,
 * then rows, while the real aggregate counts stay.
 */
function shed(state: LiveState, limit: number) {
  while (Buffer.byteLength(JSON.stringify(state)) > limit) {
    const preview = [...state.rows].reverse().find(row => row.detail !== undefined);
    if (preview) delete preview.detail;
    else if (state.rows.pop() === undefined) break;
  }
  return state;
}
/**
 * The running entries, each keeping the run ID an earlier pass knew when Hermes did not report one
 * this time, as when its conversation could not be read. Losing it would let the coverage match
 * the assistant's next run.
 */
const remember = (previous: CoveredRun[], active: CoveredRun[]) => active.map(run => {
  const runId = run.runId ?? previous.find(old => old.botId === run.botId && old.runId)?.runId;
  return runId ? { botId: run.botId, runId } : { botId: run.botId };
});
/** The same run, or the same assistant while either side did not know the run yet. */
const sameRun = (a: CoveredRun, b: CoveredRun) => a.botId === b.botId && (a.runId === b.runId || !a.runId || !b.runId);
/** Apple refused the token itself, or the payload can never fit: retrying cannot help. */
const rejected = (apns: ApnsError) => apns.apnsStatus === 410 || apns.apnsStatus === 413
  || (apns.apnsStatus === 400 && ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(apns.reason ?? ""));

/** A run that started and finished between two looks still counts as done. */
const finishedSince = (bot: Bot, armedAt: number) => !activeStates.has(bot.activity) && !!bot.lastMessage?.at && Date.parse(bot.lastMessage.at) > armedAt;
// The timestamp moves every push; only the content decides whether to send again.
const signature = (state: LiveState) => JSON.stringify({ ...state, updatedAt: 0 });

function title(rows: LiveRow[], active: number, waiting: number) {
  if (waiting) return waiting === 1 ? `${rows[0].name} needs you` : `${waiting} assistants need you`;
  if (active === 1) {
    const row = rows.find(value => !terminal(value.phase))!;
    return `${row.name} is ${row.status.toLowerCase()}`;
  }
  if (active) return `${active} assistants working`;
  if (rows.length === 1) return rows[0].phase === "done" ? `${rows[0].name} finished` : `${rows[0].name} ${rows[0].status.toLowerCase()}`;
  return rows.length ? "Assistants finished" : "All caught up";
}
