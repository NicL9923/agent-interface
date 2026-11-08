import type { ActivityState } from "../shared/types";
import {
  CELEBRATION,
  GLANCE_LEAD,
  IDLE_GESTURE,
  THINK_PONDER,
  WORK_SCAN,
  frozenStates,
  gestureLength,
  gestureLook,
  hash,
  type GestureKind,
  type MotionPlan,
} from "./avatar-motion";

// The conductor decides which named gesture each bot plays and when, so no two bots on a page
// ever show the same look at once, and gives each bot its own pace for its continuous loops.
// AvatarView.swift mirrors it as AvatarConductor; tests/avatar-motion-parity.test.ts checks both.
// Time is seconds on one clock the caller supplies.

/** Seconds kept clear between two bots' turns at one look, so turns never touch. */
export const TURN_GAP = 0.3;
/** A completion celebrates within this long of finishing, or skips the celebration. */
export const CELEBRATION_DELAY = CELEBRATION + TURN_GAP;
const BOOP_DELAY = 0.25;
const SHAKE_DELAY = 0.3;
/** Entry gestures belong to a state the avatar just entered, not one it scrolled back to. */
const ENTRY_GRACE = 0.25;
/** A track nobody has asked about for this long is off screen; its future turns are given back. */
export const LEASE = 0.5;
/** How long a finished turn still counts when an idle bot looks for a fresh gesture. */
const MEMORY = 8;
/** A held prop replaces the working spin for this long after the last frame that held it. */
const CALM = 0.25;
const idleKinds: GestureKind[] = ["tilt", "peek", "hop", "doubleTake"];
/**
 * Filler gestures that can move later at no cost before they start. A thinking beat cannot,
 * because its glance comes first.
 */
const movable = new Set<GestureKind>([...idleKinds, "spin", "nudge"]);

/** Each bot on screen gets a distinct voice, and each voice its own phase and pace. */
export const voicePhase = (voice: number) => (voice * 0.618034) % 1;
export const voiceTempo = (voice: number) => 0.9 + 0.2 * ((voice * 0.7548777 + 0.5) % 1);

interface Turn {
  track: Track;
  kind: GestureKind;
  start: number;
  end: number;
}

/** What one bot is doing in one state. Every avatar of that bot in that state reads the same cue. */
export interface Cue {
  /** When the bot entered the state; the plan's times count from here. */
  readonly since: number;
  readonly plan: MotionPlan;
}

class Track implements Cue {
  plan: MotionPlan;
  /** The current or next gesture. */
  turn?: Turn;
  boop?: Turn;
  count = 0;
  /** Whether a celebration or shake may still be booked. */
  entryOpen: boolean;
  /** Whether a celebration or shake took this track's booked turn, so it must book again. */
  bumped = false;
  calmUntil = -Infinity;
  constructor(
    readonly owner: string,
    readonly state: ActivityState,
    readonly since: number,
    readonly voice: number,
    public seen: number,
  ) {
    this.plan = { phase: voicePhase(voice), tempo: voiceTempo(voice) };
    this.entryOpen = seen - since <= ENTRY_GRACE;
  }
  /** Noise that differs per bot and per gesture. */
  noise(n: number) {
    return hash(this.voice * 31 + this.count * 7 + n);
  }
}

export class AvatarConductor {
  private tracks = new Map<string, Map<ActivityState, Track>>();
  private voices = new Map<string, number>();
  private turns: Turn[] = [];
  private swept = -Infinity;

  /**
   * The cue for `owner` in `state`. `owner` names the bot, so its avatars share one cue; `since`
   * is when this avatar entered the state, `entered` whether that was a change rather than a
   * mount, and `held` whether it holds a prop instead of spinning. Call once per frame.
   */
  cue(owner: string, state: ActivityState, since: number, entered: boolean, held: boolean, now: number): Cue {
    if (now - this.swept >= LEASE / 2) this.sweep(now);
    let states = this.tracks.get(owner);
    if (!states) this.tracks.set(owner, (states = new Map()));
    let track = states.get(state);
    if (!track) states.set(state, (track = this.open(owner, state, since, entered, now)));
    track.seen = now;
    if (held) this.calm(track, now);
    if (track.bumped) this.rebook(track, now);
    if (!track.turn || now >= track.turn.end) this.advance(track, now);
    return track;
  }

  private open(owner: string, state: ActivityState, since: number, entered: boolean, now: number) {
    let voice = this.voices.get(owner);
    if (voice === undefined) {
      const taken = new Set(this.voices.values());
      for (voice = 0; taken.has(voice); voice++);
      this.voices.set(owner, voice);
    }
    const track = new Track(owner, state, since, voice, now);
    if (entered && track.entryOpen && !frozenStates.includes(state)) {
      track.boop = this.book(track, ["boop"], since, since + BOOP_DELAY);
      if (track.boop) track.plan.boop = track.boop.start - since;
    }
    return track;
  }

  /** Books this track's next gesture once the last one is over. */
  private advance(track: Track, now: number) {
    const { since, plan } = track;
    const last = track.turn;
    let kinds: GestureKind[];
    let from: number;
    let latest = Infinity;
    switch (track.state) {
      case "idle":
        // A gesture every 6 to 12 s, the first after the arrival settles.
        from = last ? last.start + IDLE_GESTURE * (0.67 + 0.66 * track.noise(1))
          : Math.max(since + 2.5 + 4 * track.noise(1), now + 1 + 2 * track.noise(2));
        kinds = this.freshest(track);
        break;
      case "working":
        if (now < track.calmUntil) return;
        from = (last ? last.end : since) + WORK_SCAN * plan.tempo;
        kinds = ["spin"];
        break;
      case "thinking":
        // Beats alternate, and the glance before each one must still be ahead.
        from = Math.max((last ? last.end : since) + THINK_PONDER * plan.tempo, now + GLANCE_LEAD);
        kinds = track.count % 2 === 0 ? ["idea", "tumble"] : ["tumble", "idea"];
        break;
      case "blocked":
        from = last ? last.start + 2.6 * plan.tempo : since;
        kinds = ["nudge"];
        break;
      case "done":
      case "failed":
        if (!track.entryOpen) return;
        track.entryOpen = false;
        from = since;
        latest = since + (track.state === "done" ? CELEBRATION_DELAY : SHAKE_DELAY);
        kinds = track.state === "done" ? ["twirl", "cheer"] : ["shake"];
        break;
      default:
        return;
    }
    // A completion or failure answers an event, so it may move filler that has not started yet.
    const turn = this.book(track, kinds, Math.max(from, now), latest, latest < Infinity ? now : undefined);
    if (!turn) return;
    // Thinking sides alternate, so each loop starts where the last one looked.
    const side = track.state === "thinking"
      ? (hash(track.voice * 31 + 5) < 0.5 ? -1 : 1) * (track.count % 2 === 0 ? 1 : -1)
      : track.noise(3) < 0.5 ? -1 : 1;
    track.count++;
    track.turn = turn;
    plan.previous = plan.gesture;
    plan.gesture = { kind: turn.kind, side, start: turn.start - since };
  }

  /** Idle kinds, least recently seen on another bot first, with this bot's last one at the end. */
  private freshest(track: Track) {
    const seen = (kind: GestureKind) => {
      if (kind === track.turn?.kind) return Infinity;
      let latest = -Infinity;
      for (const turn of this.turns)
        if (turn.track.owner !== track.owner && gestureLook[turn.kind] === gestureLook[kind]) latest = Math.max(latest, turn.end);
      return latest;
    };
    const rotate = Math.floor(track.noise(4) * idleKinds.length);
    return idleKinds
      .map((kind, i) => ({ kind, seen: seen(kind), order: (i + rotate) % idleKinds.length }))
      .sort((a, b) => a.seen - b.seen || a.order - b.order)
      .map(({ kind }) => kind);
  }

  /**
   * Books the kind that can start soonest at or after `from`, preferring earlier kinds on a tie,
   * as long as it starts by `latest`. With `bumpAt`, filler booked to start after then moves
   * out of the way instead.
   */
  private book(track: Track, kinds: GestureKind[], from: number, latest: number, bumpAt?: number) {
    let best: Turn | undefined;
    for (const kind of kinds) {
      const start = this.earliest(track.owner, kind, from, bumpAt);
      // The tolerance keeps a turn that ends exactly on the bound from rounding past it.
      if (start <= latest + 1e-9 && (!best || start < best.start))
        best = { track, kind, start, end: start + gestureLength[kind] };
    }
    if (!best) return undefined;
    if (bumpAt !== undefined) {
      const taken = best;
      const bumped = this.turns.filter((turn) => this.movable(turn, bumpAt) && this.clashes(turn, taken));
      for (const turn of bumped) turn.track.bumped = true;
      if (bumped.length) this.turns = this.turns.filter((turn) => !bumped.includes(turn));
    }
    this.turns.push(best);
    return best;
  }

  /** Whether another bot's turn would show the same look within the gap of `taken`. */
  private clashes(turn: Turn, taken: Turn) {
    return turn.track.owner !== taken.track.owner && gestureLook[turn.kind] === gestureLook[taken.kind] &&
      taken.start < turn.end + TURN_GAP && taken.end + TURN_GAP > turn.start;
  }
  private movable(turn: Turn, at: number) {
    return turn.start > at && movable.has(turn.kind);
  }

  /** A bumped track books its gesture again, as soon as it fits after where it was. */
  private rebook(track: Track, now: number) {
    track.bumped = false;
    const old = track.turn, gesture = track.plan.gesture;
    if (!old || !gesture) return;
    const kinds = track.state === "idle" ? this.freshest(track) : [old.kind];
    const turn = this.book(track, kinds, Math.max(old.start, now), Infinity)!;
    track.turn = turn;
    track.plan.gesture = { kind: turn.kind, side: gesture.side, start: turn.start - track.since };
  }

  /** The first start at or after `from` when no other bot shows this kind's look, gap included. */
  private earliest(owner: string, kind: GestureKind, from: number, bumpAt?: number) {
    const look = gestureLook[kind];
    const length = gestureLength[kind];
    let start = from;
    for (let moved = true; moved;) {
      moved = false;
      for (const turn of this.turns) {
        if (turn.track.owner === owner || gestureLook[turn.kind] !== look) continue;
        if (bumpAt !== undefined && this.movable(turn, bumpAt)) continue;
        if (start < turn.end + TURN_GAP && start + length + TURN_GAP > turn.start) {
          start = turn.end + TURN_GAP;
          moved = true;
        }
      }
    }
    return start;
  }

  /** A held prop replaces the spin: drop a booked spin and end one under way. */
  private calm(track: Track, now: number) {
    track.calmUntil = now + CALM;
    const turn = track.turn;
    if (track.state !== "working" || !turn || now >= turn.end) return;
    this.yieldTurn(turn, now);
    track.plan.gesture = undefined;
    track.bumped = false;
  }

  /** Gives back what is left of a turn: all of it if it has not started. */
  private yieldTurn(turn: Turn, now: number) {
    if (turn.start > now) {
      this.turns = this.turns.filter((other) => other !== turn);
      turn.start = now;
    }
    turn.end = Math.min(turn.end, now);
  }

  /** Closes tracks nobody has asked about lately and forgets turns too old to matter. */
  private sweep(now: number) {
    this.swept = now;
    for (const [owner, states] of this.tracks) {
      for (const [state, track] of states) {
        if (now - track.seen <= LEASE) continue;
        states.delete(state);
        for (const turn of [track.turn, track.boop]) if (turn && turn.end > now) this.yieldTurn(turn, now);
      }
      if (!states.size) {
        this.tracks.delete(owner);
        this.voices.delete(owner);
      }
    }
    let kept = 0;
    for (const turn of this.turns) if (turn.end > now - MEMORY) this.turns[kept++] = turn;
    this.turns.length = kept;
  }
}

/** The page's conductor; every animated avatar asks it for its cue each frame. */
export const avatarConductor = new AvatarConductor();
