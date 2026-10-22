import type { ActivityState } from "../shared/types";

// Pure motion model for the avatar rig. Rendering lives in Avatar.tsx; the native
// client mirrors these numbers in AvatarView.swift. Time is seconds since the
// avatar entered its current state. Which named gestures play, and when, arrives
// as a MotionPlan from the conductor (avatar-conductor.ts), which keeps any two
// bots from playing the same one at once.

export const TAU = Math.PI * 2;
export const CELEBRATION = 1.8;
/** One working loop at an even pace: a scan, then a spin. */
export const WORK_CYCLE = 3.8;
export const WORK_SPIN = 0.95;
/** One sweep of the working scan, which is also the usual wait between spins. */
export const WORK_SCAN = WORK_CYCLE - WORK_SPIN;
/** Pondering between thinking beats, and the beat itself: an idea or a tumble. */
export const THINK_PONDER = 5;
export const THINK_BEAT = 1.4;
/** One thinking loop: ponder one way, glance the other, then a beat. */
export const THINK_CYCLE = THINK_PONDER + THINK_BEAT;
/** The eyes glance toward the beat's side this long before the beat. */
export const GLANCE_LEAD = 1.8;
/** Radius of the imaginary sphere the face is painted on, in body units. */
export const FACE_RADIUS = 42;

/**
 * Named gestures. Idle avatars tilt, peek, hop or double take; working ones spin; thinking ones
 * end each loop in an idea or a tumble; a completion twirls or cheers; a failure shakes; a block
 * nudges its exclamation mark; and any state change can boop.
 */
export type GestureKind =
  | "tilt" | "peek" | "hop" | "doubleTake"
  | "spin" | "idea" | "tumble" | "twirl" | "cheer"
  | "shake" | "nudge" | "boop";
export const IDLE_GESTURE_LENGTH = 1.4;
export const gestureLength: Record<GestureKind, number> = {
  tilt: IDLE_GESTURE_LENGTH, peek: IDLE_GESTURE_LENGTH, hop: IDLE_GESTURE_LENGTH, doubleTake: IDLE_GESTURE_LENGTH,
  spin: WORK_SPIN, idea: THINK_BEAT, tumble: THINK_BEAT, twirl: CELEBRATION, cheer: CELEBRATION,
  shake: 0.45, nudge: 0.5, boop: 0.45,
};
/**
 * Gestures that read alike share a look: a working spin and a completion twirl both spin with
 * trails, a cheer is two hops, and a double take and an idea both pop wide eyes and marks.
 * Only one bot at a time may show a look.
 */
export const gestureLook: Record<GestureKind, string> = {
  tilt: "tilt", peek: "peek", hop: "hop", cheer: "hop", doubleTake: "marks", idea: "marks",
  spin: "spin", twirl: "spin", tumble: "tumble", shake: "shake", nudge: "nudge", boop: "boop",
};
/** A granted gesture: what, toward which side (-1 left, 1 right), and when, in seconds since state entry. */
export interface Gesture {
  kind: GestureKind;
  side: number;
  start: number;
}
export interface MotionPlan {
  /** The current or next gesture in this state. */
  gesture?: Gesture;
  /** The gesture before it, whose expression may still be easing out. */
  previous?: Gesture;
  /** When the state-change boop starts, if it plays at all. */
  boop?: number;
  /** This bot's own offset and pace for its continuous loops, so bots never move in step. */
  phase: number;
  tempo: number;
}
/** A lone avatar with no gestures, as in a still preview or a pure-model test. */
export const soloPlan: MotionPlan = { phase: 0, tempo: 1 };
/** The clock that drives a bot's continuous loops: wander, breath, scan, sway and blinks. */
export const motionClock = (t: number, plan: MotionPlan) => t * plan.tempo + 60 * plan.phase;
/** Seconds into `gesture` at t, or -1 when it is not playing then. */
function into(gesture: Gesture | undefined, t: number, kind?: GestureKind) {
  if (!gesture || (kind && gesture.kind !== kind)) return -1;
  const u = t - gesture.start;
  return u >= 0 && u < gestureLength[gesture.kind] ? u : -1;
}

const clamp = (value: number, min = 0, max = 1) => Math.min(Math.max(value, min), max);
export const smoothstep = (t: number) => {
  const x = clamp(t);
  return x * x * (3 - 2 * x);
};
const easeInOut = (t: number) => {
  const x = clamp(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};
const easeOut = (t: number) => 1 - (1 - clamp(t)) ** 3;
/** Deterministic noise so motion is varied but reproducible in tests. */
export const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export interface Pose {
  yaw: number;
  lift: number;
  shiftX: number;
  roll: number;
  scaleX: number;
  scaleY: number;
  gazeX: number;
  gazeY: number;
  blink: number;
  trails: number;
  sweep: number;
  symbolTilt: number;
  /** Vertical turn of the face, in radians; a full turn rolls the eyes over the top and back. */
  pitch: number;
  /** Momentary eye size, for a pop of surprise. */
  eyeScale: number;
  /** Emphasis marks beside the head, from 0 (none) to 1. */
  ticks: number;
  /** Which side the marks appear on: -1 left, 1 right. */
  tickSide: number;
}
export const restingPose: Pose = {
  yaw: 0, lift: 0, shiftX: 0, roll: 0, scaleX: 1, scaleY: 1,
  gazeX: 0, gazeY: 0, blink: 1, trails: 0, sweep: 0, symbolTilt: 0,
  pitch: 0, eyeScale: 1, ticks: 0, tickSide: 1,
};

/** States whose meaning is "nothing is happening right now" never move. */
export const frozenStates: ActivityState[] = ["disconnected", "interrupted"];

/** Whether the rig still needs animation frames at time t. A failure moves until its shake ends. */
export function animatesAt(state: ActivityState, t: number, plan: MotionPlan = soloPlan) {
  if (frozenStates.includes(state)) return false;
  if (state === "failed") return t < 0.6 || into(plan.gesture, t) >= 0;
  return true;
}

export function blinkAt(t: number) {
  const period = 4.6;
  let openness = 1;
  for (const k of [Math.floor(t / period) - 1, Math.floor(t / period)]) {
    const at = k * period + 1.4 + hash(k) * 2.4;
    for (const start of hash(k + 7) > 0.72 ? [at, at + 0.28] : [at]) {
      const d = t - start;
      if (d >= 0 && d < 0.16) openness = Math.min(openness, 1 - Math.sin((Math.PI * d) / 0.16) * 0.92);
    }
  }
  return openness;
}

function wander(t: number, span = 2.8) {
  const target = (segment: number) => hash(segment + 13) < 0.35
    ? [0, 0]
    : [hash(segment) * 2 - 1, (hash(segment + 31) * 2 - 1) * 0.5];
  const segment = Math.floor(t / span);
  const blend = smoothstep((t - segment * span) / 0.24);
  const from = target(segment - 1);
  const to = target(segment);
  return [from[0] + (to[0] - from[0]) * blend, from[1] + (to[1] - from[1]) * blend];
}

/** Rises from 0 past 1 and settles, for marks and eyes that pop into place. */
export function popIn(t: number) {
  const x = clamp(t);
  return 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
}
/** 0 to 1 over [start, end], eased. */
const span = (t: number, start: number, end: number) => smoothstep((t - start) / (end - start));
/** Up then back down over [start, end]: 0 at both ends, 1 in the middle. */
const hump = (t: number, start: number, end: number) => t <= start || t >= end ? 0 : Math.sin((Math.PI * (t - start)) / (end - start));

/**
 * Thinking: eyes shrink to dots and look up to one side, then dart to the other with the body
 * following a beat later. Each loop ends in a beat: a squash and pop of wide eyes with emphasis
 * marks (an idea), or a hop that rolls the face over the top (a tumble). The beat's side is
 * where the eyes end up, and the next loop starts looking there.
 */
function thinkPose(pose: Pose, t: number, c: number, beat?: Gesture) {
  const side = beat?.side ?? 1;
  // The eyes switch sides in 0.14 s; the head follows over 0.4 s.
  const glance = beat ? beat.start - GLANCE_LEAD : 0;
  const toward = (from: number, to: number) => beat ? 2 * span(t, glance + from, glance + to) - 1 : -1;
  const eyes = side * toward(0, 0.14);
  const head = side * toward(0.06, 0.46);
  const drift = Math.sin(c * 1.1);
  pose.gazeX = eyes * (0.5 + 0.12 * drift);
  pose.gazeY = -0.8 + 0.08 * Math.sin(c * 0.9);
  pose.yaw = head * 0.2;
  pose.roll = head * 5 + drift * 1.2;
  const b = Math.sin(c * 2.1);
  pose.scaleY *= 1 + 0.016 * b;
  pose.scaleX *= 1 - 0.01 * b;
  pose.lift = -1.5 - b;
  const u = into(beat, t);
  if (u < 0) return pose;
  // Both beats start from a squash that gathers the body.
  const squash = hump(u, 0, 0.42);
  pose.scaleY *= 1 - 0.08 * squash;
  pose.scaleX *= 1 + 0.05 * squash;
  if (beat!.kind === "idea") {
    const pop = hump(u, 0.3, 0.85);
    pose.scaleY *= 1 + 0.07 * pop;
    pose.scaleX *= 1 - 0.035 * pop;
    pose.lift -= 4 * pop;
    // The idea lands facing forward with wide eyes, marks on the side it was looking.
    const forward = span(u, 0.25, 0.5) * (1 - span(u, 1.05, 1.4));
    pose.gazeX *= 1 - 0.8 * forward;
    pose.gazeY += 0.55 * forward;
    pose.yaw *= 1 - forward;
    pose.roll *= 1 - 0.7 * forward;
    pose.eyeScale = u < 0.3 ? 1 : 1 + 0.22 * hump(u, 0.3, 1.3) ** 0.6;
    pose.ticks = u < 0.32 ? 0 : popIn((u - 0.32) / 0.3) * (1 - span(u, 0.95, 1.3));
    pose.tickSide = side;
  } else {
    const s = clamp((u - 0.3) / 0.8);
    pose.pitch = TAU * easeInOut(s);
    pose.lift -= 3.5 * Math.sin(Math.PI * s);
    pose.gazeY *= 1 - hump(u, 0.3, 1.1);
  }
  return pose;
}

/** Seconds between idle gestures, on average. */
export const IDLE_GESTURE = 9;
/** A stable number per name, for motion that cannot go through the conductor, such as a portrait's ring. */
export function motionSeed(name: string) {
  let seed = 0;
  for (let i = 0; i < name.length; i++) seed = (seed * 31 + name.charCodeAt(i)) % 997;
  return seed;
}
/** A portrait ring's offset into its turn, as a fraction, and its pace, so rings never turn in step. */
export function ringOffset(name: string) {
  const seed = motionSeed(name);
  return { phase: hash(seed + 41), pace: 0.9 + 0.2 * hash(seed + 43) };
}
/**
 * Now and then an idle avatar does something small: a curious head tilt, a peek to one side,
 * a hop, or a double take with emphasis marks. Each lasts about 1.4 s.
 */
function idleGesture(pose: Pose, t: number, gesture?: Gesture) {
  const g = into(gesture, t);
  if (g < 0) return pose;
  const side = gesture!.side;
  const e = span(g, 0, 0.25) * (1 - span(g, 1.05, 1.4));
  switch (gesture!.kind) {
    case "tilt": // A curious tilt toward one side, eyes a little wider.
      pose.roll += side * 13 * e;
      pose.gazeX += (side * 0.6 - pose.gazeX) * e;
      pose.gazeY += (-0.3 - pose.gazeY) * e;
      pose.eyeScale = 1 + 0.12 * e;
      break;
    case "peek": // A peek: the head turns a quarter so the far eye shrinks.
      pose.yaw += (side * 0.55 - pose.yaw) * e;
      pose.gazeX += (side * 0.9 - pose.gazeX) * e;
      pose.shiftX += side * 1.5 * e;
      break;
    case "hop": { // A hop: gather, spring up, land.
      const gather = hump(g, 0, 0.22) + hump(g, 0.62, 0.86);
      const air = hump(g, 0.18, 0.66);
      pose.scaleY *= 1 - 0.09 * gather + 0.06 * air;
      pose.scaleX *= 1 + 0.06 * gather - 0.03 * air;
      pose.lift -= 7 * air;
      pose.eyeScale = 1 + 0.1 * air;
      pose.blink = 1;
      break;
    }
    case "doubleTake": { // A double take: a glance, back, then wide eyes and marks.
      const glance = hump(g, 0, 0.3);
      pose.gazeX += (side * 0.9 - pose.gazeX) * glance;
      pose.yaw += side * 0.25 * glance;
      const take = span(g, 0.32, 0.42) * (1 - span(g, 1.05, 1.4));
      pose.eyeScale = g < 0.32 ? 1 : 1 + 0.26 * popIn((g - 0.32) / 0.25) * (1 - span(g, 1.05, 1.4));
      pose.gazeX *= 1 - take;
      pose.lift -= 2.5 * hump(g, 0.32, 0.6);
      pose.ticks = g < 0.36 ? 0 : popIn((g - 0.36) / 0.3) * (1 - span(g, 0.95, 1.3));
      pose.tickSide = side;
      pose.blink = 1;
    }
  }
  return pose;
}

/** A short damped "boop" that acknowledges a state change, starting `u` seconds ago. */
function arrival(u: number) {
  return u < 0 ? 1 : 1 + 0.07 * Math.exp(-u * 7) * Math.sin(u * 24);
}

/** A completion's double spin with trails, marks popping at the end. */
function twirl(pose: Pose, u: number) {
  const s = u / CELEBRATION;
  pose.yaw = TAU * 2 * easeOut(s);
  pose.sweep = pose.yaw;
  pose.trails = s < 0.8 ? 1 : (1 - s) / 0.2;
  pose.lift += -7 * Math.abs(Math.sin(Math.PI * s * 2)) * (1 - s * 0.4);
  pose.roll += 14 * Math.sin(s * TAU * 1.5) * (1 - s);
  pose.scaleY *= 1 - 0.06 * Math.sin(TAU * 2 * s) * (1 - s);
  pose.blink = 1;
  pose.ticks = s < 0.82 ? 0 : popIn((u - CELEBRATION * 0.82) / 0.3);
}
/** A completion's other celebration: two hops leaning one way then the other, marks on landing. */
function cheer(pose: Pose, u: number, side: number) {
  const first = hump(u, 0.16, 0.56);
  const second = hump(u, 0.68, 1.08);
  const air = first + second;
  const gather = hump(u, 0, 0.2) + hump(u, 0.52, 0.72) + hump(u, 1.04, 1.24);
  pose.scaleY *= 1 - 0.1 * gather + 0.07 * air;
  pose.scaleX *= 1 + 0.07 * gather - 0.035 * air;
  pose.lift -= 8 * air;
  pose.roll += side * 9 * (first - second);
  pose.eyeScale = 1 + 0.14 * air;
  pose.blink = 1;
  pose.ticks = u < 1.1 ? 0 : popIn((u - 1.1) / 0.3);
}

/** A small tool the avatar holds while Hermes runs a recognizable kind of tool. */
export type AvatarProp = "search" | "computer" | "read" | "write";
const propTools: [AvatarProp, RegExp][] = [
  ["search", /search|find|grep|lookup|fetch|extract|browse|browser|navigate|crawl|scrape|vision/],
  ["computer", /terminal|shell|bash|exec|process|code|computer|ssh|command/],
  ["read", /read|view|skill|open|load|list/],
  ["write", /write|patch|edit|create|save|update|note|todo|memory|remind|draft|generate/],
];
/** Picks a prop from a Hermes tool name; unknown tools keep the plain working motion. */
export function avatarProp(tool?: string): AvatarProp | undefined {
  const name = tool?.toLowerCase();
  return name ? propTools.find(([, pattern]) => pattern.test(name))?.[0] : undefined;
}

/** Where the held prop sits in avatar units, and its tilt in degrees. */
export function propMotion(prop: AvatarProp, t: number) {
  switch (prop) {
    case "search": return { x: 72 + Math.sin(t * 1.6) * 9, y: 70 + Math.sin(t * 3.2) * 2.5, rotate: -8 + Math.sin(t * 1.6) * 6 };
    case "computer": return { x: 50, y: 88 - Math.abs(Math.sin(t * 9)) * 0.5, rotate: 0 };
    case "read": return { x: 50, y: 86 + Math.sin(t * 1.4) * 1, rotate: Math.sin(t * 0.7) * 2 };
    case "write": return { x: 74 + Math.sin(t * 7) * 2.5, y: 78 + Math.cos(t * 7) * 1.2 + Math.sin(t * 0.9) * 2, rotate: 0 };
  }
}

/** Replaces the working scan and spin with a calm pose that watches the prop. */
function propPose(pose: Pose, prop: AvatarProp, t: number) {
  const motion = propMotion(prop, t);
  // Reading eyes sweep across a line, then hop back to start the next one.
  const line = (rate: number) => {
    const u = (t * rate) % 1;
    return u < 0.85 ? -0.6 + 1.2 * (u / 0.85) : 0.6 - 1.2 * smoothstep((u - 0.85) / 0.15);
  };
  const b = Math.sin(t * 1.9);
  pose.scaleY *= 1 + 0.014 * b;
  pose.scaleX *= 1 - 0.008 * b;
  pose.lift = -0.8 * b;
  if (prop === "search") {
    pose.gazeX = (motion.x - 72) / 12;
    pose.gazeY = 0.4;
    pose.roll = (motion.x - 72) * 0.25;
  } else if (prop === "write") {
    pose.gazeX = 0.55 + Math.sin(t * 7) * 0.12;
    pose.gazeY = 0.7;
    pose.roll = 3;
  } else {
    pose.gazeX = line(prop === "computer" ? 0.7 : 0.4);
    pose.gazeY = 0.85;
    pose.lift += prop === "computer" ? -Math.abs(Math.sin(t * 9)) * 0.5 : 0;
  }
  pose.yaw = pose.gazeX * 0.12;
  return pose;
}

/**
 * The pose at t seconds into `state`. `plan` says which named gestures this bot plays and when,
 * and the pace of its continuous loops; without one the avatar only runs its loops.
 */
export function avatarPose(state: ActivityState, t: number, reduce: boolean, prop?: AvatarProp, plan: MotionPlan = soloPlan): Pose {
  if (reduce || frozenStates.includes(state)) return restingPose;
  const c = motionClock(t, plan);
  const g = plan.gesture;
  const pop = plan.boop === undefined ? 1 : arrival(t - plan.boop);
  const pose: Pose = { ...restingPose, blink: blinkAt(c), scaleX: pop, scaleY: pop };
  const breathe = (rate: number, depth: number) => {
    const b = Math.sin(c * rate);
    pose.scaleY *= 1 + depth * b;
    pose.scaleX *= 1 - depth * 0.6 * b;
    return b;
  };
  switch (state) {
    case "idle": {
      const b = breathe(1.7, 0.012);
      const [x, y] = wander(c);
      // The eyes lead; the head turns and leans after them.
      const [hx] = wander(c - 0.18);
      pose.lift = -0.6 * b;
      pose.roll = Math.sin(c * 0.55) * 1.6 + hx * 2.5;
      pose.gazeX = x;
      pose.gazeY = y;
      pose.yaw = hx * 0.2;
      return idleGesture(pose, t, g);
    }
    case "thinking":
      return thinkPose(pose, t, c, g);
    case "working": {
      if (prop) return propPose(pose, prop, c);
      // The scan eases in, because this bot's scan may enter partway through a sweep.
      const scan = Math.sin((TAU * c) / WORK_SCAN) * smoothstep(t / 0.5);
      pose.yaw = 0.6 * scan;
      pose.gazeX = 0.5 * scan;
      pose.lift = -Math.abs(Math.sin(c * 6.5)) * 1.6;
      pose.roll = Math.sin(c * 6.5) * 1.2;
      const u = into(g, t, "spin");
      if (u >= 0) {
        // The scan hands over to the spin and takes back after it, so a spin can start anywhere.
        const s = u / WORK_SPIN;
        const keep = 1 - span(u, 0, 0.2) * (1 - span(u, WORK_SPIN - 0.2, WORK_SPIN));
        pose.sweep = TAU * easeInOut(s);
        pose.yaw = pose.sweep + pose.yaw * keep;
        pose.gazeX *= keep;
        pose.roll *= keep;
        pose.trails = Math.sin(Math.PI * s);
        pose.lift = pose.lift * keep - 3 * Math.sin(Math.PI * s);
        pose.blink = 1;
      }
      break;
    }
    case "waiting": {
      const b = breathe(1.1, 0.018);
      pose.lift = 0.8 + 0.8 * b;
      pose.roll = Math.sin(c * 0.4) * 2.5;
      pose.gazeX = Math.sin(c * 0.35) * 0.4;
      pose.gazeY = 0.6;
      break;
    }
    case "blocked": {
      const w = into(g, t, "nudge");
      pose.symbolTilt = w < 0 ? 0 : 9 * Math.sin((w / 0.5) * TAU * 2) * (1 - w / 0.5);
      break;
    }
    case "done": {
      const b = breathe(1.5, 0.012);
      pose.lift = -0.5 * b;
      pose.roll = Math.sin(c * 0.7) * 2;
      // A celebration may wait its turn; one that never got a turn settles without marks.
      const u = g ? t - g.start : -1;
      pose.tickSide = g?.side ?? 1;
      if (g && u >= 0 && u < CELEBRATION) {
        if (g.kind === "cheer") cheer(pose, u, g.side);
        else twirl(pose, u);
      } else if (u >= CELEBRATION) {
        pose.ticks = 1 - span(u, CELEBRATION + 0.3, CELEBRATION + 0.7);
      }
      break;
    }
    case "failed": {
      const u = into(g, t, "shake");
      pose.shiftX = u < 0 ? 0 : 3 * Math.sin(u * 42) * (1 - u / 0.45);
      pose.lift = 1.5 * smoothstep(t / 0.3);
      pose.scaleY *= 1 - 0.03 * smoothstep(t / 0.3);
      pose.blink = 1;
      break;
    }
  }
  return pose;
}

export interface Expression {
  /** Eye openness multiplier. */
  open: number;
  /** Degrees each eye leans toward the center; positive reads as worried. */
  tilt: number;
  /** 0 = normal eyes, 1 = closed happy arcs. */
  happy: number;
  /** Mascot mouth curve: -1 frown, 0 flat, 1 smile. */
  mouth: number;
  /** 0 = the style's own eyes, 1 = small round dots, as when concentrating. */
  dot: number;
}
/** Whether `beat` is an idea in its wide-eyed moment at t. */
const ideaAt = (beat: Gesture | undefined, t: number) =>
  beat?.kind === "idea" && t - beat.start > 0.2 && t - beat.start < 1.1;
export function expressionFor(state: ActivityState, t: number, plan: MotionPlan = soloPlan): Expression {
  switch (state) {
    case "thinking": {
      // Dots while pondering; the idea beat opens them wide again.
      const idea = ideaAt(plan.gesture, t) || ideaAt(plan.previous, t);
      return { open: idea ? 1.1 : 1, tilt: 0, happy: 0, mouth: idea ? 0.9 : 0.1, dot: idea ? 0 : 1 };
    }
    case "working": return { open: 0.82, tilt: 0, happy: 0, mouth: 0.3, dot: 0 };
    case "waiting": return { open: 0.36, tilt: 0, happy: 0, mouth: 0, dot: 0 };
    case "blocked": return { open: 1.1, tilt: 0, happy: 0, mouth: -0.2, dot: 0 };
    // Excited until most of the way through a celebration, which may have waited its turn.
    case "done": return t < (plan.gesture?.start ?? 0) + CELEBRATION * 0.75
      ? { open: 1.1, tilt: 0, happy: 0, mouth: 1, dot: 0 }
      : { open: 1, tilt: 0, happy: 1, mouth: 1, dot: 0 };
    case "failed": return { open: 0.62, tilt: 14, happy: 0, mouth: -1, dot: 0 };
    case "disconnected": return { open: 0.7, tilt: 0, happy: 0, mouth: 0, dot: 0 };
    case "interrupted": return { open: 0.5, tilt: 0, happy: 0, mouth: 0, dot: 0 };
    default: return { open: 1, tilt: 0, happy: 0, mouth: 0.6, dot: 0 };
  }
}
/** Frame-rate independent approach toward a target expression. */
export function approach(current: Expression, target: Expression, dt: number): Expression {
  const k = 1 - Math.exp(-dt / 0.09);
  return {
    open: current.open + (target.open - current.open) * k,
    tilt: current.tilt + (target.tilt - current.tilt) * k,
    happy: current.happy + (target.happy - current.happy) * k,
    mouth: current.mouth + (target.mouth - current.mouth) * k,
    dot: current.dot + (target.dot - current.dot) * k,
  };
}

/**
 * Projects a face feature `dx` units from the face center onto a sphere turned
 * by `yaw`. Features on the far side report `visible: false`.
 */
export function project(dx: number, yaw: number, radius = FACE_RADIUS) {
  const angle = yaw + Math.asin(clamp(dx / radius, -1, 1));
  const depth = Math.cos(angle);
  return { x: radius * Math.sin(angle), scale: Math.max(depth, 0.02), visible: depth > 0.02 };
}
/**
 * The eyes' height on the face sphere turned by `pitch`: `y` from the face center, the vertical
 * squash, and whether they face the viewer. A full turn rolls them over the top and back from below.
 */
export function pitchEyes(pitch: number, radius = FACE_RADIUS) {
  const depth = Math.cos(pitch);
  return { y: -radius * Math.sin(pitch), scale: Math.max(depth, 0.02), visible: depth > 0.02 };
}
/** Near features look a little larger than far ones as the face turns. */
export const perspective = (depth: number) => 0.86 + 0.14 * depth;
/**
 * Emphasis marks: three short strokes fanning out from beside the top of the head on `side`,
 * growing with `level`. Returned as path data in avatar units.
 */
export function tickMarks(level: number, side: number, top: number) {
  if (level <= 0.01) return [];
  const cx = 50 + side * 34;
  const cy = Math.max(top, 4) + 8;
  return [-84, -52, -20].map((degrees) => {
    const a = (degrees * Math.PI) / 180;
    const dx = Math.cos(a) * side;
    const dy = Math.sin(a);
    const r0 = 6 + 3 * level;
    const r1 = r0 + 9 * level;
    const f = (v: number) => v.toFixed(2);
    return `M${f(cx + dx * r0)} ${f(cy + dy * r0)} L${f(cx + dx * r1)} ${f(cy + dy * r1)}`;
  });
}

/**
 * Splits a trail segment on a tilted orbit into the arcs behind and in front of
 * the body, so trails wrap around the avatar instead of floating on top of it.
 */
export function orbitArcs(head: number, length: number, rx: number, ry: number, tilt: number, cx = 50, cy = 52) {
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const back: string[] = [];
  const front: string[] = [];
  let run: [number, number][] = [];
  let runFront: boolean | null = null;
  const flush = () => {
    if (run.length > 1)
      (runFront ? front : back).push("M" + run.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(" L"));
    run = [];
  };
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const psi = head - length + (length * i) / steps;
    const lx = rx * Math.cos(psi);
    const ly = ry * Math.sin(psi);
    const point: [number, number] = [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];
    const isFront = Math.sin(psi) >= 0;
    if (runFront !== null && isFront !== runFront) {
      const last = run.at(-1);
      flush();
      if (last) run.push(last);
    }
    runFront = isFront;
    run.push(point);
  }
  flush();
  return { back, front };
}

function luminance(color: string) {
  const hex = color.replace("#", "");
  const value = parseInt(hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex, 16);
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return null;
  const channel = (shift: number) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const lightInk = { geometric: "#fff9ee", mascot: "#fff3db" };
const darkInk = "#2b201b";

/**
 * Readable eye color for any body color, including custom picks. Each style keeps
 * its signature ink (cream cutouts, dark mascot eyes) while it holds at least 2:1;
 * otherwise the stronger ink wins. Every palette color keeps its signature ink.
 */
export function faceInk(color: string, mascot = false) {
  const body = luminance(color);
  const light = mascot ? lightInk.mascot : lightInk.geometric;
  const preferred = mascot ? darkInk : light;
  const other = mascot ? light : darkInk;
  if (body === null) return preferred;
  const score = (ink: string) => contrast(body, luminance(ink)!);
  return score(preferred) >= 2 || score(preferred) >= score(other) ? preferred : other;
}

/** Very light bodies get a soft edge so they keep their shape on the light theme's cream surface. */
export function bodyEdge(color: string) {
  const body = luminance(color);
  return body !== null && body > 0.7 ? tint(color, -0.16) : null;
}

/** Mixes a hex color toward white (positive) or black (negative). */
export function tint(color: string, amount: number) {
  const value = parseInt(color.replace("#", ""), 16);
  if (Number.isNaN(value) || color.replace("#", "").length !== 6) return color;
  const target = amount > 0 ? 255 : 0;
  const mix = (shift: number) => {
    const c = (value >> shift) & 255;
    return Math.round(c + (target - c) * Math.abs(amount)).toString(16).padStart(2, "0");
  };
  return `#${mix(16)}${mix(8)}${mix(0)}`;
}
