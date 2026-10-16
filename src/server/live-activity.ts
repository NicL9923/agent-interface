import type { ActivityState, Bot, Conversation, Runtime } from "../shared/types.js";
import { allowedIdentity, type Config } from "./config.js";
import type { LiveActivityRegistration, Store } from "./store.js";
import { visible } from "./bot-access.js";
import { FailureTracker, quietLog, type Log } from "./logging.js";

/** One row of the aggregate Live Activity. docs/native-api.md is the contract the iOS app decodes. */
export type LivePhase = "starting" | "thinking" | "working" | "waiting" | "blocked" | "done" | "failed" | "interrupted";
export interface LiveRow {
  botId: string;
  name: string;
  phase: LivePhase;
  status: string;
  detail?: string;
  /** Unix epoch seconds. ActivityKit would decode a Date from the 2001 epoch. */
  since?: number;
  color?: string;
}
export interface LiveState {
  title: string;
  activeCount: number;
  attentionCount: number;
  updatedAt: number;
  rows: LiveRow[];
}
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
    return this.build(userId, await this.runtime.listBots(), new Map(), armed, previous);
  }

  async tick() {
    if (!this.send || !this.config.apns) return;
    const registrations = this.store.liveActivities(this.config.apns.environment, this.now()).filter(registration => {
      const user = this.store.getUser(registration.userId);
      return !!user && allowedIdentity(this.config, user);
    });
    if (!registrations.length) return;
    const roster = await this.runtime.listBots();
    const conversations = new Map<string, Promise<Conversation | undefined>>();
    for (const registration of registrations) {
      try {
        await this.deliver(registration, await this.build(registration.userId, roster, conversations, registration, registration.lastState));
      } catch (error) {
        this.push.failure(error);
      }
    }
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
      const result = error as { statusCode?: number; reason?: string };
      if (result.statusCode === 410 || result.statusCode === 413 || (result.statusCode === 400 && ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(result.reason ?? ""))) {
        this.store.removeLiveActivity(registration.userId, registration.deviceId, registration.token);
        return;
      }
      // Keep the previous state so the change is retried after a backoff.
      this.store.liveActivityFailed(registration.deviceId, registration.token, this.now());
      throw error;
    }
  }

  private async build(
    userId: string, roster: Bot[], conversations: Map<string, Promise<Conversation | undefined>>,
    armed?: Pick<LiveActivityRegistration, "armed" | "armedAt">, previous?: LiveState,
  ): Promise<LiveState> {
    const now = this.now();
    const follows = new Set(this.store.preferences(userId).followBots);
    const arming = armed && now - armed.armedAt < ARMED_MS ? new Set(armed.armed) : new Set<string>();
    const shown = new Map(previous?.rows.map(row => [row.botId, row]));
    const conversation = (botId: string) => {
      // An unreadable conversation falls back to the roster state instead of dropping the person's whole aggregate.
      if (!conversations.has(botId)) conversations.set(botId, Promise.resolve().then(() => this.runtime.conversation(botId)).catch(() => undefined));
      return conversations.get(botId)!;
    };
    const rows: LiveRow[] = [];
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
    // Reserve room for the APNs envelope. JSON byte length includes Unicode and escapes;
    // shed previews first, then rows, while retaining the real aggregate counts.
    while (Buffer.byteLength(JSON.stringify(state)) > 3500) {
      const preview = [...state.rows].reverse().find(row => row.detail !== undefined);
      if (preview) delete preview.detail;
      else state.rows.pop();
    }
    return state;
  }
}

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
