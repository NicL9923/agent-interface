import type { Log } from "./logging.js";
import type { AdmissionTurn, TurnWatcher } from "../shared/types.js";

/** How long after it begins a send's measurement is released, logged with whatever was correlated by then. */
export const SEND_TIMING_GIVE_UP_MS = 120_000;
/**
 * The unidentified turns, and the runs, a send keeps a first time for while it cannot yet tell which is its own,
 * and the sessions it keeps an unidentified earlier turn for. Past any of these, the send is uncorrelated.
 */
export const SEND_TIMING_HELD = 8;
/** Sessions whose current turn is tracked. Frames of other clients' sessions also arrive here. */
const SESSIONS = 16;

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
/**
 * Why a record finished, as its log line names it. Only "measured" carries both moments.
 * - uncorrelated: a moment could not be tied to the send's run. Hermes's answer named no run, an earlier
 *   turn of the run's session streamed text no read identified, more turns or runs streamed at once
 *   than a send holds, or turns on more sessions than it holds ended unidentified.
 * - next-run: a read found another run running on the assistant's session, so the send's run is over.
 * - deadline: two minutes passed after the send began.
 * - disconnected: the Hermes socket dropped while the record was open, so frames may have been missed.
 * - not-started: Hermes's answer says the send's turn did not start (`queued`, `none` or `unknown`), so no text
 *   or live event is its own turn's. Logged at the answer, with no moments after it.
 */
export type SendEnded = "measured" | "uncorrelated" | "next-run" | "deadline" | "disconnected" | "not-started";

/** One turn of one session: from its message.start, or the first frame seen of it, to its message.complete. */
interface Turn {
  readonly session: string;
  /** Turns in the order they were first seen, across sessions. */
  readonly seq: number;
  /**
   * The app run a fresh conversation read found open while this turn ran. null: the read found none, as for a
   * routine's turn. undefined: no read landed during it.
   */
  run?: string | null;
  /** The assistant whose read identified it. */
  botId?: string;
  /** Two reads named different runs, so neither is trusted. */
  conflicted: boolean;
  ended: boolean;
}
interface Session {
  turn?: Turn;
  /** The generation at which no open record needed anything more from the current turn. */
  framed: number;
}

/** One send's measurement. The caller holds it from before the send reaches Hermes until Hermes answers. */
export interface SendRecord {
  readonly botId: string;
  readonly requestId: string;
  readonly arrival: number;
  /** The run Hermes's answer named. Every moment recorded must belong to it. */
  runId?: string;
  firstFrame?: number;
  firstLive?: number;
  /** Until the send's first text is matched: its first text time after arrival on each turn not yet ruled out. */
  frames: Map<Turn, number>;
  /**
   * By session, the earliest turn with text after arrival that no read identified before it ended, or that two
   * reads disagreed on. It may have been the send's own, so a later turn of the send's run there cannot be its first.
   */
  blind: Map<string, number>;
  /** Before Hermes answers: the first live event written after arrival for each run. */
  lives: Map<string, number>;
  /** A moment can no longer be correlated. */
  lost: boolean;
  /** Released before Hermes answered. The answer logs this at once. */
  released?: "deadline" | "disconnected";
  admission?: { route: SendRoute; steered: boolean; phases: Required<SendPhases>; turn?: AdmissionTurn };
  timer?: ReturnType<typeof setTimeout>;
}

const messages: Record<SendEnded, string> = {
  measured: "Send timing",
  uncorrelated: "Send timing: a moment could not be tied to the send's run",
  "next-run": "Send timing: another run started before it was measured",
  deadline: "Send timing: gave up at the deadline",
  disconnected: "Send timing: Hermes disconnected while it was measured",
  "not-started": "Send timing: Hermes did not start the send's turn",
};

/**
 * Times each admitted send from the request's arrival to the first streamed text of its own run and the
 * first live event of that run written to an open event stream, then logs one line per admitted send.
 * Only identifiers and durations are logged, never message text.
 *
 * The model: correlate by identity, and omit what cannot be correlated. The order of events is never
 * evidence of which send they belong to.
 * - Identity. Hermes's admission answer names the send's run: its own request ID for a new task, or the
 *   running task's root for a steer. Session frames carry only a session ID. A live event carries the run
 *   of the conversation read it was built from. A fresh read, one with no turn starting or ending on its
 *   session between the read's start and now, names the session's open app run, which the runtime reports
 *   with run() and the running turn takes. That is the turn's own run except in the limit below.
 * - First live: the first live event written after arrival whose run equals the answer's run. Until the
 *   answer, the first time per run is kept, for at most SEND_TIMING_HELD runs.
 * - First text: the first text frame after arrival on a turn identified as the answer's run, provided no
 *   earlier turn with text after arrival on that session went unidentified: one that ended before a read
 *   landed in it, or that two reads disagreed on. Such a turn may have been the run's, so the later text
 *   is not its first and is omitted. Until a turn is identified, the send keeps its first text time
 *   there, for at most SEND_TIMING_HELD turns at once.
 * - A send whose turn did not start. A read names the session's open app run, which is not always the
 *   running turn's: a send preempts an idle compaction, an unrelated native turn starts before the add-on
 *   reads the session's state, and Hermes queues the send as a new task behind it or puts it into that turn.
 *   A read during the native turn names the send's run, so that turn's text would be recorded as the send's.
 *   An add-on says so in its answer (`turn`, see AdmissionTurn). A send Hermes
 *   put into the running turn (`joined`) is measured as a steer, with steered true. One whose turn did not
 *   start at all (`queued`, `none`, `unknown`) logs at the answer, ended "not-started", with no moments: a
 *   queued text may be merged or dropped, so no later turn is its own either. Limit, not guarded: an older
 *   add-on answers that sequence with no turn, and the line can end "measured" with steered false.
 * - A steer is measured by its run's next growth after it arrived. Native steering answers "queued" for an
 *   ordinary steer too, and queued text drains into a later turn of the same run, so a steer and a queued
 *   send cannot be told apart. Both are measured on their run, past turn boundaries.
 * - Lifetime. begin() creates the record before Hermes is asked, since Hermes may stream before it
 *   answers. Every record has a deadline from then. admitted() confirms it with the answer's run, and
 *   discard() drops one Hermes did not accept. It ends, logging one line with an `ended` reason (see
 *   SendEnded): when both moments are recorded; when a moment becomes uncorrelated; when a fresh read
 *   finds another run running for the assistant, since its runs follow each other; at the deadline; or
 *   when the socket drops, which also forgets every tracked turn and held time. A record released before
 *   Hermes answered logs at the answer.
 *
 * The frame hook runs on every token. Once no open record needs more from a session's current turn, a
 * token costs one map lookup and reads no clock.
 */
export class SendTimings implements TurnWatcher {
  private records = new Set<SendRecord>();
  private sessions = new Map<string, Session>();
  private turns = 0;
  /** Advances when a record begins, the one event after which a current turn may be needed again. */
  private generation = 0;
  constructor(private log: Log, private now: () => number = () => performance.now(), private giveUpMs = SEND_TIMING_GIVE_UP_MS) {}

  /** Starts measuring a send before it reaches Hermes. */
  begin(botId: string, requestId: string, arrival: number): SendRecord {
    const record: SendRecord = { botId, requestId, arrival, frames: new Map(), blind: new Map(), lives: new Map(), lost: false };
    record.timer = setTimeout(() => this.expire(record), this.giveUpMs);
    record.timer.unref?.();
    this.records.add(record);
    this.generation++;
    return record;
  }

  /**
   * Hermes accepted the send into runId. steered is its admission decision when it reports one, and turn what
   * its answer said about the send's turn, when it says.
   */
  admitted(record: SendRecord, route: SendRoute, steered: boolean, phases: Required<SendPhases>, runId: string | undefined,
    turn?: AdmissionTurn): void {
    if (record.admission) return;
    record.admission = { route, steered: steered || turn === "joined", phases, ...(turn ? { turn } : {}) };
    if (record.released) return this.write(record, record.released);
    if (!this.records.has(record)) return;
    if (turn === "queued" || turn === "none" || turn === "unknown") return this.finish(record, "not-started");
    if (runId === undefined) return this.finish(record, "uncorrelated");
    record.runId = runId;
    record.firstLive = record.lives.get(runId);
    record.lives.clear();
    if (record.lost) return this.finish(record, "uncorrelated");
    this.resolve(record);
    this.settle(record);
  }

  /** Hermes did not accept the send, or its answer was lost. Nothing is logged. */
  discard(record: SendRecord): void {
    this.release(record);
  }

  frame(sessionId: string, event: "start" | "text" | "end"): void {
    if (event === "text") {
      const session = this.sessions.get(sessionId);
      if (session !== undefined && session.framed === this.generation) return;
      this.text(sessionId, session);
    } else if (event === "start") {
      this.open(this.session(sessionId), sessionId);
    } else {
      const turn = this.sessions.get(sessionId)?.turn;
      if (turn && !turn.ended) this.turnEnded(turn);
    }
  }

  run(sessionId: string, botId: string, runId: string | undefined, running: boolean): void {
    let turn = this.sessions.get(sessionId)?.turn;
    if (!turn || turn.ended) {
      // A read between turns says nothing about a turn. One mid-turn whose start was not seen opens it here.
      if (!running) return;
      turn = this.open(this.session(sessionId), sessionId);
    }
    const run = runId ?? null;
    if (turn.run === undefined) { turn.run = run; turn.botId = botId; }
    else if (turn.run !== run && !turn.conflicted) {
      turn.conflicted = true;
      // A send may have skipped its text as another run's, so none may take a later first text there.
      for (const record of this.records) this.blind(record, turn);
    }
    for (const record of this.records) {
      // An assistant's runs follow each other, so another one running means this send's run is over.
      if (record.admission && record.botId === botId && runId !== undefined && runId !== record.runId) this.finish(record, "next-run");
      else if (record.frames.has(turn)) this.resolve(record);
    }
  }

  disconnected(): void {
    for (const record of this.records) {
      if (record.admission) this.finish(record, "disconnected");
      else { this.release(record); record.released = "disconnected"; }
    }
    this.sessions.clear();
  }

  /** A live event of runId for this assistant was written to an open event stream. */
  written(botId: string, runId: string | undefined): void {
    let at: number | undefined;
    for (const record of this.records) {
      if (record.botId !== botId || record.firstLive !== undefined || record.lost) continue;
      if (record.runId !== undefined) {
        if (runId !== record.runId) continue;
        record.firstLive = at ??= this.now();
        this.settle(record);
      } else if (runId !== undefined && !record.lives.has(runId)) {
        if (record.lives.size >= SEND_TIMING_HELD) this.lose(record);
        else record.lives.set(runId, at ??= this.now());
      }
    }
  }

  /** Stops every timer, as the app does on close. */
  close(): void {
    for (const record of this.records) clearTimeout(record.timer);
    this.records.clear();
    this.sessions.clear();
  }

  /** The session, made the most recent. The least recent is forgotten past the limit, its turn ended unseen. */
  private session(sessionId: string): Session {
    const session = this.sessions.get(sessionId) ?? { framed: -1 };
    this.sessions.delete(sessionId);
    if (this.sessions.size >= SESSIONS) {
      const [oldest, forgotten] = this.sessions.entries().next().value!;
      this.sessions.delete(oldest);
      if (forgotten.turn && !forgotten.turn.ended) this.turnEnded(forgotten.turn);
    }
    this.sessions.set(sessionId, session);
    return session;
  }

  /** A new turn on the session. One still running there ended without its end being seen. */
  private open(session: Session, sessionId: string): Turn {
    if (session.turn && !session.turn.ended) this.turnEnded(session.turn);
    session.turn = { session: sessionId, seq: ++this.turns, conflicted: false, ended: false };
    session.framed = -1;
    return session.turn;
  }

  private text(sessionId: string, known: Session | undefined): void {
    if (!this.records.size) return;
    const session = known ?? this.session(sessionId);
    // Text with no running turn seen belongs to a turn whose start was missed.
    const turn = session.turn && !session.turn.ended ? session.turn : this.open(session, sessionId);
    let at: number | undefined;
    for (const record of this.records) {
      if (record.firstFrame !== undefined || record.lost || record.frames.has(turn) || this.ruledOut(record, turn)) continue;
      if (turn.conflicted) { this.blind(record, turn); continue; }
      if (record.frames.size >= SEND_TIMING_HELD) { this.lose(record); continue; }
      record.frames.set(turn, at ??= this.now());
      this.resolve(record);
    }
    session.framed = this.generation;
  }

  /** Identified as a turn that is not this send's run. */
  private ruledOut(record: SendRecord, turn: Turn): boolean {
    if (turn.conflicted || turn.run === undefined) return false;
    return turn.run === null || turn.botId !== record.botId || record.runId !== undefined && turn.run !== record.runId;
  }

  private turnEnded(turn: Turn): void {
    turn.ended = true;
    for (const record of this.records) {
      if (!record.frames.has(turn) || turn.run !== undefined && !turn.conflicted) continue;
      this.blind(record, turn);
      this.resolve(record);
    }
  }

  private blind(record: SendRecord, turn: Turn): void {
    record.frames.delete(turn);
    if (record.lost || record.blind.has(turn.session)) return;
    // Forgetting a session's uncertainty could credit its later text to the send, so give up instead.
    if (record.blind.size >= SEND_TIMING_HELD) return this.lose(record);
    record.blind.set(turn.session, turn.seq);
  }

  /** Takes the first text time of the send's own run, unless an unidentified turn before it may have been the run's. */
  private resolve(record: SendRecord): void {
    if (record.runId === undefined || record.firstFrame !== undefined || record.lost) return;
    for (const [turn, at] of record.frames) {
      if (this.ruledOut(record, turn)) { record.frames.delete(turn); continue; }
      // A conflicted turn never holds an entry: it blinds its session instead.
      if (turn.run !== record.runId) continue;
      if ((record.blind.get(turn.session) ?? Infinity) < turn.seq) return this.lose(record);
      record.firstFrame = at;
      record.frames.clear();
      return this.settle(record);
    }
  }

  private lose(record: SendRecord): void {
    record.lost = true;
    record.frames.clear();
    record.blind.clear();
    if (record.admission) this.finish(record, "uncorrelated");
  }

  private settle(record: SendRecord): void {
    if (record.admission && record.firstFrame !== undefined && record.firstLive !== undefined) this.finish(record, "measured");
  }

  private expire(record: SendRecord): void {
    if (record.admission) return this.finish(record, "deadline");
    this.release(record);
    record.released = "deadline";
  }

  private release(record: SendRecord): void {
    this.records.delete(record);
    clearTimeout(record.timer);
    record.frames.clear();
    record.blind.clear();
    record.lives.clear();
  }

  private finish(record: SendRecord, ended: SendEnded): void {
    if (!this.records.has(record)) return;
    this.release(record);
    this.write(record, ended);
  }

  private write(record: SendRecord, ended: SendEnded): void {
    const { route, steered, turn, phases: { arrival, hermesStart, admitted } } = record.admission!;
    const since = (at: number | undefined) => at === undefined ? undefined : round(at - arrival);
    this.log.info({ sendTiming: {
      route, botId: record.botId, requestId: record.requestId, steered, ...(turn ? { turn } : {}),
      prepareMs: since(hermesStart), admissionMs: since(admitted),
      firstFrameMs: since(record.firstFrame), firstLiveMs: since(record.firstLive), ended,
      ...(ended === "deadline" ? { gaveUpAfterMs: this.giveUpMs } : {}),
    } }, messages[ended]);
  }
}
