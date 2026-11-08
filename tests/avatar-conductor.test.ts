import { describe, expect, it } from "vitest";
import {
  AvatarConductor,
  CELEBRATION_DELAY,
  LEASE,
  TURN_GAP,
  voicePhase,
  voiceTempo,
} from "../src/components/avatar-conductor";
import { WORK_SCAN, gestureLength, gestureLook, type GestureKind, type MotionPlan } from "../src/components/avatar-motion";
import type { ActivityState } from "../src/shared/types";

const frame = 1 / 30;

/** A deterministic random source, so a failing household can be replayed. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gestures a plan shows at t seconds into its state, as the pose function would play them. */
function showing(plan: MotionPlan, t: number) {
  const shown: GestureKind[] = [];
  const g = plan.gesture;
  if (g && t >= g.start && t < g.start + gestureLength[g.kind]) shown.push(g.kind);
  if (plan.boop !== undefined && t >= plan.boop && t < plan.boop + gestureLength.boop) shown.push("boop");
  return shown;
}

interface Avatar {
  owner: string;
  state: ActivityState;
  since: number;
  entered: boolean;
  held: boolean;
  visible: boolean;
}

/**
 * Checks every frame that no look is on two bots at once, and that turns at one look by
 * different bots stay TURN_GAP apart. Returns how often each kind was seen.
 */
function watch(conductor: AvatarConductor, avatars: Avatar[], now: number, last: Map<string, { owner: string; at: number }>, seen: Map<GestureKind, number>) {
  const owners = new Map<string, string>();
  for (const avatar of avatars) {
    if (!avatar.visible) continue;
    const { since, plan } = conductor.cue(avatar.owner, avatar.state, avatar.since, avatar.entered, avatar.held, now);
    for (const kind of showing(plan, now - since)) {
      const look = gestureLook[kind];
      const other = owners.get(look);
      if (other && other !== avatar.owner) throw new Error(`${avatar.owner} and ${other} both show ${look} at ${now.toFixed(3)}`);
      owners.set(look, avatar.owner);
      const previous = last.get(look);
      if (previous && previous.owner !== avatar.owner && now - previous.at < TURN_GAP - 1e-6)
        throw new Error(`${avatar.owner} shows ${look} ${(now - previous.at).toFixed(3)} s after ${previous.owner} at ${now.toFixed(3)}`);
      last.set(look, { owner: avatar.owner, at: now });
      seen.set(kind, (seen.get(kind) ?? 0) + 1);
    }
  }
}

describe("avatar conductor", () => {
  it("never lets two bots show the same look at once, over a long busy day", () => {
    const conductor = new AvatarConductor();
    const next = random(7);
    const states: ActivityState[] = ["idle", "idle", "idle", "working", "working", "thinking", "thinking", "waiting", "blocked", "done", "failed"];
    // Ten bots in home rows, three of them also open in a chat header. Home rows show a finished
    // bot as idle, as the sidebar does, so one bot can be in two states at once.
    const bots = Array.from({ length: 10 }, (_, i) => ({ name: `Bot ${i}`, state: "idle" as ActivityState, since: 0, held: false }));
    const avatars = (now: number): Avatar[] => bots.flatMap((bot, i) => {
      const home: Avatar = { owner: bot.name, state: bot.state === "done" ? "idle" : bot.state, since: bot.since, entered: bot.since > 0, held: false, visible: i !== 9 || Math.floor(now / 40) % 2 === 0 };
      const header: Avatar = { owner: bot.name, state: bot.state, since: bot.since, entered: bot.since > 0, held: bot.held, visible: true };
      return i < 3 ? [home, header] : [home];
    });
    const last = new Map<string, { owner: string; at: number }>();
    const seen = new Map<GestureKind, number>();
    for (let n = 0; n < 15 * 60 * 30; n++) {
      const now = n * frame;
      // Every two minutes most of the household changes state together.
      const together = n > 0 && n % (120 * 30) === 0;
      const shared = states[Math.floor(next() * states.length)];
      for (const bot of bots) {
        if (together ? next() < 0.7 : next() < frame / 9) {
          const state = together ? shared : states[Math.floor(next() * states.length)];
          if (state !== bot.state) Object.assign(bot, { state, since: now });
        }
        if (bot.state === "working" && next() < frame / 4) bot.held = !bot.held;
      }
      watch(conductor, avatars(now), now, last, seen);
    }
    // Every kind of gesture actually played, so the check above was not vacuous.
    for (const kind of Object.keys(gestureLength) as GestureKind[]) expect(seen.get(kind) ?? 0, kind).toBeGreaterThan(0);
  });

  it("gives every avatar of one bot the same cue", () => {
    const conductor = new AvatarConductor();
    const home = conductor.cue("Juniper", "idle", 0, false, false, 0);
    for (let now = 0; now < 3; now += frame) conductor.cue("Juniper", "idle", 0, false, false, now);
    // A chat header opened later joins the bot's motion instead of starting its own.
    const header = conductor.cue("Juniper", "idle", 3, false, false, 3);
    expect(header).toBe(home);
    expect(header.since).toBe(0);
    for (let now = 3; now < 30; now += frame) {
      expect(conductor.cue("Juniper", "idle", 0, false, false, now)).toBe(conductor.cue("Juniper", "idle", 3, false, false, now));
    }
    expect(home.plan.gesture).toBeDefined();
  });

  it("gives bots on screen together their own phase and pace", () => {
    const conductor = new AvatarConductor();
    const plans = Array.from({ length: 8 }, (_, i) => conductor.cue(`Bot ${i}`, "working", 0, true, false, 0).plan);
    for (const [i, a] of plans.entries())
      for (const b of plans.slice(i + 1)) {
        const phase = Math.abs(a.phase - b.phase);
        const apart = Math.min(phase, 1 - phase) > 0.05 || Math.abs(a.tempo - b.tempo) > 0.03;
        expect(apart, `${a.phase}/${a.tempo} vs ${b.phase}/${b.tempo}`).toBe(true);
      }
    expect(voicePhase(0)).toBe(0);
    expect(voiceTempo(0)).toBe(1);
  });

  it("frees a bot's voice when it leaves, so the next bot reuses it", () => {
    const conductor = new AvatarConductor();
    conductor.cue("Sage", "idle", 0, false, false, 0);
    const first = conductor.cue("Juniper", "idle", 0, false, false, 0).plan;
    // Sage keeps asking; Juniper leaves and Rowan arrives after the lease.
    for (let now = 0; now <= LEASE * 3; now += frame) conductor.cue("Sage", "idle", 0, false, false, now);
    const rowan = conductor.cue("Rowan", "idle", LEASE * 3, false, false, LEASE * 3 + frame).plan;
    expect([rowan.phase, rowan.tempo]).toEqual([first.phase, first.tempo]);
  });

  it("delays a celebration by a bounded amount, or skips it, when several bots finish at once", () => {
    const conductor = new AvatarConductor();
    const since = 100;
    const cues = Array.from({ length: 6 }, (_, i) => conductor.cue(`Bot ${i}`, "done", since, true, false, since));
    const starts = cues.map((cue) => cue.plan.gesture?.start);
    const celebrated = starts.filter((start) => start !== undefined) as number[];
    expect(celebrated.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...celebrated)).toBeLessThanOrEqual(CELEBRATION_DELAY + 1e-9);
    expect(celebrated.filter((start) => start === 0)).toHaveLength(2);
    expect(new Set(cues.map((cue) => cue.plan.gesture?.kind).filter(Boolean))).toEqual(new Set(["twirl", "cheer"]));
    // The rest settle quietly, and nothing new is booked later.
    for (let now = since; now < since + 6; now += frame) {
      const last = new Map<string, { owner: string; at: number }>();
      watch(conductor, cues.map((_, i) => ({ owner: `Bot ${i}`, state: "done", since, entered: true, held: false, visible: true })), now, last, new Map());
    }
    expect(cues.map((cue) => cue.plan.gesture?.start)).toEqual(starts);
  });

  it("moves a booked spin out of the way of a completion instead of making it wait", () => {
    const conductor = new AvatarConductor();
    const avatars: Avatar[] = [
      { owner: "Sage", state: "working", since: 0, entered: false, held: false, visible: true },
      { owner: "Rowan", state: "working", since: 0, entered: false, held: false, visible: true },
    ];
    const last = new Map<string, { owner: string; at: number }>();
    for (let now = 0; now < 1; now += frame) watch(conductor, avatars, now, last, new Map());
    // Spins are booked ahead; at least one lands where a twirl starting now would be.
    const spin = (owner: string) => conductor.cue(owner, "working", 0, false, false, 1).plan.gesture!.start;
    const booked = avatars.map(({ owner }) => spin(owner));
    const end = 1 + CELEBRATION_DELAY;
    expect(booked.some((start) => start < end)).toBe(true);
    const twirl = conductor.cue("Juniper", "done", 1, true, false, 1).plan.gesture!;
    expect(twirl).toMatchObject({ kind: "twirl", start: 0 });
    // A spin in the twirl's way books again after it; the scan carries on until then.
    avatars.forEach(({ owner }, i) => {
      if (booked[i] < end) expect(spin(owner)).toBeGreaterThanOrEqual(end - 1e-9);
      else expect(spin(owner)).toBe(booked[i]);
    });
    const done = { owner: "Juniper", state: "done" as const, since: 1, entered: true, held: false, visible: true };
    for (let now = 1; now < 12; now += frame) watch(conductor, [...avatars, done], now, last, new Map());
  });

  it("extends the scan when another bot is spinning, and every working bot still spins", () => {
    const conductor = new AvatarConductor();
    const spins = new Map<string, Set<number>>();
    const last = new Map<string, { owner: string; at: number }>();
    for (let now = 0; now < 60; now += frame) {
      const avatars = [0, 1, 2, 3].map((i) => ({ owner: `Bot ${i}`, state: "working" as const, since: 0, entered: true, held: false, visible: true }));
      watch(conductor, avatars, now, last, new Map());
      for (const { owner } of avatars) {
        const start = conductor.cue(owner, "working", 0, true, false, now).plan.gesture?.start;
        if (start !== undefined) spins.set(owner, (spins.get(owner) ?? new Set()).add(start));
      }
    }
    for (const starts of spins.values()) {
      const sorted = [...starts].sort((a, b) => a - b);
      expect(sorted.length).toBeGreaterThan(8);
      // Spins come no sooner than a full scan apart, and never wait more than everyone's turns.
      const gaps = sorted.slice(1).map((start, i) => start - sorted[i]);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(gestureLength.spin + WORK_SCAN * 0.9 - 1e-9);
      expect(Math.max(...gaps)).toBeLessThan(4 * (gestureLength.spin + TURN_GAP) + WORK_SCAN * 1.1);
    }
  });

  it("drops the spin while a prop is held and resumes a full scan after", () => {
    const conductor = new AvatarConductor();
    const sage = (now: number, held = false) => conductor.cue("Sage", "working", 0, false, held, now).plan.gesture;
    expect(sage(0)?.kind).toBe("spin");
    for (let now = 0; now < 2.9; now += frame) sage(now);
    // Picking up a magnifying glass mid-spin ends the spin for every avatar of the bot.
    sage(2.9, true);
    expect(sage(2.9)).toBeUndefined();
    // Another bot may spin right after the gap, with nothing left of Sage's turn.
    const other = conductor.cue("Juniper", "working", 0, false, false, 2.9).plan.gesture!;
    expect(other.start).toBeLessThan(2.9 + TURN_GAP + 1e-9);
    // Put down at 4 s, the next spin comes a full scan after the cut-short one.
    for (let now = 2.9; now < 4; now += frame) sage(now, true);
    let later = sage(4);
    for (let now = 4; !later; now += frame) later = sage(now);
    expect(later.start).toBeGreaterThanOrEqual(2.9 + WORK_SCAN * 0.9);
  });

  it("gives back an off-screen bot's booked turn after its lease", () => {
    const conductor = new AvatarConductor();
    const booked = conductor.cue("Sage", "working", 0, false, false, 0).plan.gesture!;
    expect(booked.start).toBeCloseTo(WORK_SCAN);
    // Sage scrolls away at once; after the lease Juniper takes the same slot instead of waiting.
    const juniper = conductor.cue("Juniper", "working", 0, false, false, LEASE + 0.1).plan.gesture!;
    expect(juniper.start).toBeCloseTo(WORK_SCAN);
  });

  it("picks an idle gesture that a neighbor did not just play", () => {
    for (let trial = 0; trial < 20; trial++) {
      const conductor = new AvatarConductor();
      const a = `A${trial}`, b = `B${trial}`;
      let first: GestureKind | undefined;
      let second: GestureKind | undefined;
      for (let now = 0; now < 40 && !second; now += frame) {
        const ga = conductor.cue(a, "idle", 0, false, false, now).plan.gesture;
        first ??= ga && now >= ga.start ? ga.kind : undefined;
        // B arrives once A has played its first gesture.
        if (!first) continue;
        const gb = conductor.cue(b, "idle", now, false, false, now).plan.gesture;
        second = gb?.kind;
      }
      expect(second).toBeDefined();
      expect(gestureLook[second!]).not.toBe(gestureLook[first!]);
    }
  });

  it("boops on a state change but not when an avatar mounts", () => {
    const conductor = new AvatarConductor();
    expect(conductor.cue("Sage", "idle", 0, false, false, 0).plan.boop).toBeUndefined();
    expect(conductor.cue("Sage", "working", 5, true, false, 5).plan.boop).toBe(0);
    // A second bot changing in the same instant boops after a short wait or not at all.
    const boop = conductor.cue("Juniper", "working", 5, true, false, 5).plan.boop;
    expect(boop).toBeUndefined();
    // Frozen states never move, so they never boop.
    expect(conductor.cue("Rowan", "disconnected", 10, true, false, 10).plan.boop).toBeUndefined();
  });
});
