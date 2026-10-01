import type { ActivityState } from "../shared/types";

// Pure motion model for the avatar rig. Rendering lives in Avatar.tsx; the native
// client mirrors these numbers in AvatarView.swift. Time is seconds since the
// avatar entered its current state, so entry gestures replay on every change.

export const TAU = Math.PI * 2;
export const CELEBRATION = 1.8;
export const WORK_CYCLE = 3.8;
export const WORK_SPIN = 0.95;
/** Radius of the imaginary sphere the face is painted on, in body units. */
export const FACE_RADIUS = 42;

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
const hash = (n: number) => {
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
}
export const restingPose: Pose = {
  yaw: 0, lift: 0, shiftX: 0, roll: 0, scaleX: 1, scaleY: 1,
  gazeX: 0, gazeY: 0, blink: 1, trails: 0, sweep: 0, symbolTilt: 0,
};

/** States whose meaning is "nothing is happening right now" never move. */
export const frozenStates: ActivityState[] = ["disconnected", "interrupted"];

/** Whether the rig still needs animation frames at time t. */
export function animatesAt(state: ActivityState, t: number) {
  if (frozenStates.includes(state)) return false;
  if (state === "failed") return t < 0.6;
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

/** A short damped "boop" that acknowledges every state change. */
function arrival(t: number) {
  return 1 + 0.07 * Math.exp(-t * 7) * Math.sin(t * 24);
}

export function avatarPose(state: ActivityState, t: number, reduce: boolean): Pose {
  if (reduce || frozenStates.includes(state)) return restingPose;
  const pop = arrival(t);
  const pose: Pose = { ...restingPose, blink: blinkAt(t), scaleX: pop, scaleY: pop };
  const breathe = (rate: number, depth: number) => {
    const b = Math.sin(t * rate);
    pose.scaleY *= 1 + depth * b;
    pose.scaleX *= 1 - depth * 0.6 * b;
    return b;
  };
  switch (state) {
    case "idle": {
      const b = breathe(1.7, 0.012);
      const [x, y] = wander(t);
      pose.lift = -0.6 * b;
      pose.roll = Math.sin(t * 0.55) * 1.6;
      pose.gazeX = x;
      pose.gazeY = y;
      pose.yaw = x * 0.16;
      break;
    }
    case "thinking": {
      const b = breathe(2.1, 0.018);
      pose.gazeX = Math.sin(t * 1.3) * 0.5;
      pose.gazeY = -0.8;
      pose.yaw = Math.sin(t * 1.3) * 0.18;
      pose.roll = -5 + Math.sin(t * 1.3) * 2;
      pose.lift = -1.5 - b;
      break;
    }
    case "working": {
      const u = t % WORK_CYCLE;
      const scanEnd = WORK_CYCLE - WORK_SPIN;
      if (u < scanEnd) {
        const scan = Math.sin((TAU * u) / scanEnd);
        pose.yaw = 0.6 * scan;
        pose.gazeX = 0.5 * scan;
        pose.lift = -Math.abs(Math.sin(t * 6.5)) * 1.6;
        pose.roll = Math.sin(t * 6.5) * 1.2;
      } else {
        const s = (u - scanEnd) / WORK_SPIN;
        pose.yaw = TAU * easeInOut(s);
        pose.sweep = pose.yaw;
        pose.trails = Math.sin(Math.PI * s);
        pose.lift = -3 * Math.sin(Math.PI * s);
        pose.blink = 1;
      }
      break;
    }
    case "waiting": {
      const b = breathe(1.1, 0.018);
      pose.lift = 0.8 + 0.8 * b;
      pose.roll = Math.sin(t * 0.4) * 2.5;
      pose.gazeX = Math.sin(t * 0.35) * 0.4;
      pose.gazeY = 0.6;
      break;
    }
    case "blocked": {
      const w = t % 2.6;
      pose.symbolTilt = w < 0.5 ? 9 * Math.sin((w / 0.5) * TAU * 2) * (1 - w / 0.5) : 0;
      break;
    }
    case "done": {
      if (t < CELEBRATION) {
        const s = t / CELEBRATION;
        pose.yaw = TAU * 2 * easeOut(s);
        pose.sweep = pose.yaw;
        pose.trails = s < 0.8 ? 1 : (1 - s) / 0.2;
        pose.lift = -7 * Math.abs(Math.sin(Math.PI * s * 2)) * (1 - s * 0.4);
        pose.roll = 14 * Math.sin(s * TAU * 1.5) * (1 - s);
        pose.scaleY *= 1 - 0.06 * Math.sin(TAU * 2 * s) * (1 - s);
        pose.blink = 1;
      } else {
        const b = breathe(1.5, 0.012);
        pose.lift = -0.5 * b;
        pose.roll = Math.sin(t * 0.7) * 2;
      }
      break;
    }
    case "failed":
      pose.shiftX = t < 0.45 ? 3 * Math.sin(t * 42) * (1 - t / 0.45) : 0;
      pose.lift = 1.5 * smoothstep(t / 0.3);
      pose.scaleY *= 1 - 0.03 * smoothstep(t / 0.3);
      pose.blink = 1;
      break;
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
}
export function expressionFor(state: ActivityState, t: number): Expression {
  switch (state) {
    case "working": return { open: 0.82, tilt: 0, happy: 0, mouth: 0.3 };
    case "waiting": return { open: 0.36, tilt: 0, happy: 0, mouth: 0 };
    case "blocked": return { open: 1.1, tilt: 0, happy: 0, mouth: -0.2 };
    case "done": return t < CELEBRATION * 0.75
      ? { open: 1.1, tilt: 0, happy: 0, mouth: 1 }
      : { open: 1, tilt: 0, happy: 1, mouth: 1 };
    case "failed": return { open: 0.62, tilt: 14, happy: 0, mouth: -1 };
    case "disconnected": return { open: 0.7, tilt: 0, happy: 0, mouth: 0 };
    case "interrupted": return { open: 0.5, tilt: 0, happy: 0, mouth: 0 };
    default: return { open: 1, tilt: 0, happy: 0, mouth: 0.6 };
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
