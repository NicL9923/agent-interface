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

export type SendRoute = "messages" | "steer" | "talk";
/** A turn event Hermes reported for an assistant: a turn began, streamed text or reasoning, or ended. */
export type TurnEvent = "start" | "text" | "end";
/** Why a record finished, as its log line names it. */
type Ended = "measured" | "turn" | "next-turn" | "deadline";

/** One send's measurement. The caller holds it from before the send reaches Hermes until Hermes answers. */
export interface SendRecord {
  readonly botId: string;
  readonly requestId: string;
  readonly arrival: number;
  /** The assistant turn it measures. Unset while it waits for its turn to start. */
  turn?: number;
  /** Bound to a turn that was already running when the send arrived: a steer, measured by that reply's next growth. */
  joined: boolean;
  /** How its turn ended before Hermes answered the send: its end was reported, or a newer turn started. */
  ended?: "turn" | "next-turn";
  firstFrame?: number;
  firstLive?: number;
  admission?: { route: SendRoute; steered: boolean; phases: Required<SendPhases>; timer: ReturnType<typeof setTimeout> };
}
/** What the tracker knows of one assistant's turns, from the turn events Hermes reports. */
interface Assistant {
  /** Turns started so far. A record bound to an older number is finished or ends at the next event. */
  turn: number;
  running: boolean;
  /** No record bound to the current turn still lacks its first frame, so a token needs no more work. */
  framed: boolean;
  records: SendRecord[];
}

/**
 * Times each admitted send from the request's arrival to the first streamed text of its turn and the
 * first live event of that turn written to an open event stream, then logs one line per send. Only
 * identifiers and durations are logged, never message text.
 *
 * The model. A record is one send, bound to one assistant turn.
 * - Created by begin(), before the send reaches Hermes, because Hermes starts the turn and may stream
 *   text before it answers. A steer, or a send while a turn is running, joins that running turn and is
 *   measured by its next growth. Any other send waits and binds to the next turn that starts.
 * - Hermes's answer confirms it with admitted(), or drops it with discard() when the send was not
 *   accepted. A joined send moves to the next turn when Hermes did not steer it, or when the running
 *   turn gives way before Hermes answers, as queued guidance drains into a new turn.
 * - Only frames and live events of its bound turn, after the send arrived, are recorded.
 * - It ends, logging one line: when both moments are recorded; when its turn ends; when a newer turn
 *   starts and its own end was never seen; or two minutes after admission. A turn that ended before
 *   Hermes answered ends the record at the answer.
 *
 * The turn and live-event hooks run on every token. Once every record bound to a turn has its first
 * frame, a token costs one map lookup and reads no clock.
 */
export class SendTimings {
  private assistants = new Map<string, Assistant>();
  constructor(private log: Log, private now: () => number = () => performance.now(), private giveUpMs = SEND_TIMING_GIVE_UP_MS) {}

  /** Starts measuring a send before it reaches Hermes. steering: it will join a running turn. */
  begin(botId: string, requestId: string, arrival: number, steering: boolean): SendRecord {
    const assistant = this.assistant(botId);
    const record: SendRecord = { botId, requestId, arrival, joined: false };
    if (steering || assistant.running) this.join(assistant, record);
    assistant.records.push(record);
    return record;
  }

  /** Hermes accepted the send. steered is its admission decision when it reports one. */
  admitted(record: SendRecord, route: SendRoute, steered: boolean, phases: Required<SendPhases>): void {
    const assistant = this.assistants.get(record.botId);
    if (!assistant?.records.includes(record)) return;
    if (!steered && record.joined) this.unbind(record);
    const timer = setTimeout(() => this.finish(record, "deadline"), this.giveUpMs);
    timer.unref?.();
    record.admission = { route, steered, phases, timer };
    if (record.ended) this.finish(record, record.ended);
    else if (record.firstFrame !== undefined && record.firstLive !== undefined) this.finish(record, "measured");
  }

  /** Hermes did not accept the send, or its answer was lost. Nothing is logged. */
  discard(record: SendRecord): void {
    const assistant = this.assistants.get(record.botId);
    if (assistant) assistant.records = assistant.records.filter(other => other !== record);
  }

  /** A turn event for this assistant. at is when a held frame arrived, for one reported late. */
  turn(botId: string, event: TurnEvent, at?: number): void {
    if (event === "text") {
      const assistant = this.assistants.get(botId);
      if (assistant === undefined || assistant.framed) return;
      this.text(assistant, at ?? this.now());
    } else if (event === "start") this.started(this.assistant(botId));
    else {
      const assistant = this.assistants.get(botId);
      if (assistant !== undefined) this.ended(assistant);
    }
  }

  /** A live event for this assistant was written to an open event stream. */
  written(botId: string): void {
    const assistant = this.assistants.get(botId);
    if (assistant === undefined || !assistant.records.length) return;
    const at = this.now();
    for (const record of [...assistant.records]) {
      if (!this.current(assistant, record) || record.firstLive !== undefined) continue;
      record.firstLive = at;
      if (record.admission && record.firstFrame !== undefined) this.finish(record, "measured");
    }
  }

  /** Stops every timer, as the app does on close. */
  close(): void {
    for (const assistant of this.assistants.values()) for (const record of assistant.records) clearTimeout(record.admission?.timer);
    this.assistants.clear();
  }

  private assistant(botId: string): Assistant {
    let assistant = this.assistants.get(botId);
    if (assistant === undefined) {
      assistant = { turn: 0, running: false, framed: true, records: [] };
      this.assistants.set(botId, assistant);
    }
    return assistant;
  }

  private current(assistant: Assistant, record: SendRecord): boolean {
    return record.turn === assistant.turn && record.ended === undefined;
  }

  private join(assistant: Assistant, record: SendRecord): void {
    record.turn = assistant.turn;
    record.joined = true;
    assistant.framed = false;
  }

  private unbind(record: SendRecord): void {
    record.turn = undefined;
    record.joined = false;
    record.firstFrame = record.firstLive = undefined;
  }

  private text(assistant: Assistant, at: number): void {
    let framed = true;
    for (const record of [...assistant.records]) {
      if (!this.current(assistant, record) || record.firstFrame !== undefined) continue;
      // A frame held from before this send arrived belongs to an earlier growth.
      if (at < record.arrival) { framed = false; continue; }
      record.firstFrame = at;
      if (record.admission && record.firstLive !== undefined) this.finish(record, "measured");
    }
    assistant.framed = framed;
  }

  private started(assistant: Assistant): void {
    assistant.turn++;
    assistant.running = true;
    for (const record of [...assistant.records]) {
      // A waiting send binds to the new turn, and so does one that joined a turn and has no answer yet:
      // Hermes started a turn after it arrived, so the earlier turn is not the one its answer joins.
      if (record.turn === undefined || record.joined && !record.admission) {
        record.turn = assistant.turn;
        record.joined = false;
        record.firstFrame = record.firstLive = undefined;
      } else if (record.ended === undefined) {
        // Its turn's end was never reported. A newer turn replaced it.
        if (record.admission) this.finish(record, "next-turn");
        else record.ended = "next-turn";
      }
    }
    assistant.framed = !assistant.records.some(record => this.current(assistant, record) && record.firstFrame === undefined);
  }

  private ended(assistant: Assistant): void {
    assistant.running = false;
    for (const record of [...assistant.records]) {
      if (!this.current(assistant, record)) continue;
      if (record.admission) this.finish(record, "turn");
      // A send that joined a running turn and has no answer yet may start or steer the next turn instead.
      else if (record.joined) this.unbind(record);
      else record.ended = "turn";
    }
    assistant.framed = true;
  }

  private finish(record: SendRecord, ended: Ended): void {
    const assistant = this.assistants.get(record.botId);
    if (!assistant?.records.includes(record) || !record.admission) return;
    assistant.records = assistant.records.filter(other => other !== record);
    clearTimeout(record.admission.timer);
    const { route, steered, phases: { arrival, hermesStart, admitted } } = record.admission;
    const since = (at: number | undefined) => at === undefined ? undefined : round(at - arrival);
    const live = record.firstLive !== undefined;
    this.log.info({ sendTiming: {
      route, botId: record.botId, requestId: record.requestId, steered,
      prepareMs: since(hermesStart), admissionMs: since(admitted),
      firstFrameMs: since(record.firstFrame), firstLiveMs: since(record.firstLive), ended,
      ...(ended === "deadline" ? { gaveUpAfterMs: this.giveUpMs } : {}),
    } }, live ? "Send timing" : ended === "deadline" ? "Send timing: no live event before the deadline" : "Send timing: no live event in its turn");
  }
}
