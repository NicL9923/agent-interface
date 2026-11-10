import type { Log } from "./logging.js";

/** How long a turn waits for its first live event before its timing is logged without one. */
export const SEND_TIMING_GIVE_UP_MS = 120_000;

/** Where a send's request spent its time, in milliseconds. Each moment is measured from the request's arrival. */
export interface SendPhases {
  /** performance.now() when the request arrived. */
  arrival: number;
  /** When the runtime's submit or steer was called, after sign-in, validation and capability checks. */
  hermesStart?: number;
  /** When the runtime's submit or steer resolved with Hermes's admission answer. */
  admitted?: number;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

/** Server-Timing for a send. Phases Hermes never reached are left out. */
export function sendTimingHeader(phases: SendPhases, now: number): string {
  const metric = (name: string, ms: number) => `${name};dur=${round(ms)}`;
  const { arrival, hermesStart, admitted } = phases;
  return [
    ...(hermesStart !== undefined ? [metric("prepare", hermesStart - arrival)] : []),
    ...(hermesStart !== undefined && admitted !== undefined ? [metric("hermes", admitted - hermesStart)] : []),
    metric("total", now - arrival),
  ].join(", ");
}

interface Turn {
  route: "messages" | "steer" | "talk";
  botId: string;
  requestId: string;
  steered: boolean;
  phases: Required<SendPhases>;
  firstFrame?: number;
  timer: ReturnType<typeof setTimeout>;
}
/** The admitted turns of one assistant still waiting for their first live event. */
interface Waiting { turns: Turn[]; framed: boolean }

/**
 * Times each admitted send from the request's arrival to the first streamed text Hermes sent for that
 * assistant and the first live event the server wrote to an open event stream, then logs one line per
 * turn. Only identifiers and durations are logged, never message text.
 *
 * The streamed-text and live-event hooks run on every token. Once each waiting turn has its first frame,
 * a frame costs one map lookup, and once the first live event is written the assistant leaves the map.
 */
export class SendTimings {
  private waiting = new Map<string, Waiting>();
  constructor(private log: Log, private now: () => number = () => performance.now(), private giveUpMs = SEND_TIMING_GIVE_UP_MS) {}

  /** Starts waiting for an admitted turn's first live event. */
  admitted(route: Turn["route"], botId: string, requestId: string, steered: boolean, phases: Required<SendPhases>): void {
    const entry = this.waiting.get(botId) ?? { turns: [], framed: false };
    const turn: Turn = { route, botId, requestId, steered, phases, timer: undefined as never };
    turn.timer = setTimeout(() => this.giveUp(turn), this.giveUpMs);
    turn.timer.unref?.();
    entry.turns.push(turn);
    // Only frames after this turn's admission count for it.
    entry.framed = false;
    this.waiting.set(botId, entry);
  }

  /** A streamed text or reasoning frame for this assistant arrived from Hermes. */
  frame(botId: string): void {
    const entry = this.waiting.get(botId);
    if (entry === undefined || entry.framed) return;
    entry.framed = true;
    const at = this.now();
    for (const turn of entry.turns) turn.firstFrame ??= at;
  }

  /** A live event for this assistant was written to an open event stream. */
  written(botId: string): void {
    const entry = this.waiting.get(botId);
    if (entry === undefined) return;
    this.waiting.delete(botId);
    const at = this.now();
    for (const turn of entry.turns) {
      clearTimeout(turn.timer);
      this.report(turn, at);
    }
  }

  /** Stops every timer, as the app does on close. */
  close(): void {
    for (const entry of this.waiting.values()) for (const turn of entry.turns) clearTimeout(turn.timer);
    this.waiting.clear();
  }

  private giveUp(turn: Turn): void {
    const entry = this.waiting.get(turn.botId);
    if (entry === undefined) return;
    entry.turns = entry.turns.filter(other => other !== turn);
    if (!entry.turns.length) this.waiting.delete(turn.botId);
    this.report(turn);
  }

  private report(turn: Turn, live?: number): void {
    const { arrival, hermesStart, admitted } = turn.phases;
    const since = (at: number | undefined) => at === undefined ? undefined : round(at - arrival);
    this.log.info({ sendTiming: {
      route: turn.route, botId: turn.botId, requestId: turn.requestId, steered: turn.steered,
      prepareMs: since(hermesStart), admissionMs: since(admitted),
      firstFrameMs: since(turn.firstFrame), firstLiveMs: since(live),
      ...(live === undefined ? { gaveUpAfterMs: this.giveUpMs } : {}),
    } }, live === undefined ? "Send timing: no live event before the deadline" : "Send timing");
  }
}
