import { describe, expect, it } from "vitest";
import {
  CELEBRATION,
  IDLE_GESTURE_LENGTH,
  THINK_BEAT,
  THINK_CYCLE,
  THINK_PONDER,
  WORK_CYCLE,
  WORK_SCAN,
  WORK_SPIN,
  animatesAt,
  avatarPose,
  avatarProp,
  blinkAt,
  expressionFor,
  faceInk,
  orbitArcs,
  pitchEyes,
  project,
  restingPose,
  tickMarks,
  type GestureKind,
  type MotionPlan,
} from "../src/components/avatar-motion";
import { AvatarConductor } from "../src/components/avatar-conductor";
import type { ActivityState } from "../src/shared/types";
import { avatarColors } from "../src/components/Avatar";

const samples = (from: number, to: number, step = 0.02) =>
  Array.from({ length: Math.round((to - from) / step) }, (_, i) => from + i * step);
/** A plan granting one gesture, as the conductor would. */
const plan = (kind: GestureKind, start: number, side = -1): MotionPlan => ({ phase: 0, tempo: 1, gesture: { kind, side, start } });

describe("avatar motion", () => {
  it.each<ActivityState>(["disconnected", "interrupted"])("never moves while %s", (state) => {
    expect(animatesAt(state, 0)).toBe(false);
    for (const t of samples(0, 6, 0.37)) expect(avatarPose(state, t, false)).toEqual(restingPose);
  });

  it("holds every state still under reduced motion", () => {
    for (const state of ["idle", "working", "done", "blocked"] as const)
      for (const t of [0, 1.3, 7]) expect(avatarPose(state, t, true)).toEqual(restingPose);
  });

  it("stops a failure's shake after its entry", () => {
    expect(animatesAt("failed", 0.2)).toBe(true);
    expect(animatesAt("failed", 1)).toBe(false);
    // A shake that waited its turn keeps the frames coming until it ends.
    const late = plan("shake", 0.3);
    expect(animatesAt("failed", 0.7, late)).toBe(true);
    expect(Math.max(...samples(0.3, 0.75, 0.01).map((t) => Math.abs(avatarPose("failed", t, false, undefined, late).shiftX)))).toBeGreaterThan(1);
    expect(avatarPose("failed", 0.1, false, undefined, late).shiftX).toBe(0);
  });

  it("keeps the face forward while working until a spin turns it away", () => {
    const spinning = plan("spin", WORK_SCAN);
    for (const t of samples(0, WORK_SCAN)) {
      const pose = avatarPose("working", t, false, undefined, spinning);
      expect(project(0, pose.yaw).visible).toBe(true);
      expect(pose.trails).toBe(0);
    }
    const spin = samples(WORK_SCAN, WORK_CYCLE).map((t) => avatarPose("working", t, false, undefined, spinning));
    expect(spin.some((pose) => !project(0, pose.yaw).visible)).toBe(true);
    expect(Math.max(...spin.map((pose) => pose.trails))).toBeGreaterThan(0.9);
    // Without a granted spin the scan just carries on.
    expect(samples(0, WORK_CYCLE * 3).every((t) => avatarPose("working", t, false).trails === 0)).toBe(true);
  });

  it("hands the scan to a spin and back without a jump, wherever the spin starts", () => {
    for (const start of [1.1, 2.3, 4.05]) {
      const p = { phase: 0.37, tempo: 1.08, gesture: { kind: "spin" as const, side: 1, start } };
      const poses = samples(start - 0.3, start + WORK_SPIN + 0.3, 0.002).map((t) => avatarPose("working", t, false, undefined, p));
      // Yaw may wrap by a whole turn when the spin finishes.
      const jumps = poses.slice(1).map((pose, i) => {
        const d = Math.abs(pose.yaw - poses[i].yaw);
        return Math.min(d, Math.abs(d - Math.PI * 2));
      });
      expect(Math.max(...jumps)).toBeLessThan(0.1);
    }
  });

  it.each([
    ["web_search", "search"], ["browser_navigate", "search"], ["search_files", "search"],
    ["terminal", "computer"], ["execute_code", "computer"],
    ["read_file", "read"], ["skill_view", "read"],
    ["write_file", "write"], ["patch", "write"], ["calendar.create_event", "write"],
    ["send_message", undefined], [undefined, undefined],
  ])("holds a fitting prop for %s", (tool, prop) => {
    expect(avatarProp(tool)).toBe(prop);
  });

  it("watches a held prop calmly instead of spinning away", () => {
    for (const prop of ["search", "computer", "read", "write"] as const) {
      const poses = samples(0, WORK_CYCLE * 2).map((t) => avatarPose("working", t, false, prop));
      expect(poses.every((pose) => project(0, pose.yaw).visible && pose.trails === 0)).toBe(true);
      expect(Math.max(...poses.map((pose) => pose.gazeX)) - Math.min(...poses.map((pose) => pose.gazeX))).toBeGreaterThan(0.1);
      expect(avatarPose("working", 1.3, true, prop)).toEqual(restingPose);
    }
  });

  it("settles a completion into a calm, happy face", () => {
    const twirl = plan("twirl", 0);
    const celebrating = samples(0, CELEBRATION).map((t) => avatarPose("done", t, false, undefined, twirl));
    expect(Math.max(...celebrating.map((pose) => pose.trails))).toBe(1);
    const after = avatarPose("done", CELEBRATION + 2, false, undefined, twirl);
    expect(after.trails).toBe(0);
    expect(project(0, after.yaw).visible).toBe(true);
    expect(expressionFor("done", CELEBRATION + 2, twirl).happy).toBe(1);
  });

  it("cheers with two hops and marks instead of a twirl", () => {
    const cheer = plan("cheer", 0.6);
    const poses = samples(0.6, 0.6 + CELEBRATION).map((t) => avatarPose("done", t, false, undefined, cheer));
    expect(poses.every((pose) => pose.trails === 0 && project(0, pose.yaw).visible)).toBe(true);
    expect(Math.min(...poses.map((pose) => pose.lift))).toBeLessThan(-6);
    expect(Math.max(...poses.map((pose) => pose.ticks))).toBeGreaterThan(0.95);
    expect(poses.at(-1)!.tickSide).toBe(-1);
  });

  it("stays excited while a celebration waits its turn", () => {
    const late = plan("twirl", 1.5);
    expect(avatarPose("done", 1, false, undefined, late).trails).toBe(0);
    expect(expressionFor("done", 1.9, late).happy).toBe(0);
    expect(expressionFor("done", 1.5 + CELEBRATION, late).happy).toBe(1);
    // A completion that never got a turn settles quietly.
    expect(samples(0, 4).every((t) => avatarPose("done", t, false).ticks === 0)).toBe(true);
  });

  it("blinks briefly every few seconds", () => {
    const openness = samples(0, 12, 0.01).map(blinkAt);
    expect(Math.min(...openness)).toBeLessThan(0.2);
    expect(openness.filter((value) => value < 1).length / openness.length).toBeLessThan(0.15);
  });

  it("hides features on the far side of the face", () => {
    expect(project(15, 0)).toMatchObject({ visible: true });
    expect(project(15, Math.PI).visible).toBe(false);
  });

  it("splits trails into arcs behind and in front of the body", () => {
    const arcs = orbitArcs(1.5 * Math.PI, Math.PI, 58, 13, 0);
    expect(arcs.back.length).toBeGreaterThan(0);
    expect(arcs.front.length).toBeGreaterThan(0);
  });

  it("chooses readable eyes for custom colors", () => {
    expect(faceInk("#1084FE")).toBe("#fff9ee");
    expect(faceInk("#FFE45C")).toBe("#2b201b");
    expect(faceInk("#FF9800", true)).toBe("#2b201b");
    expect(faceInk("#111111", true)).toBe("#fff3db");
    expect(faceInk("not-a-color")).toBe("#fff9ee");
    expect(faceInk("#C3C3C3")).toBe("#2b201b");
    for (const color of avatarColors) expect(faceInk(color)).toBe("#fff9ee");
  });

  it("ponders with dot eyes looking up, then pops wide-eyed with marks", () => {
    const idea = plan("idea", THINK_PONDER);
    const ponder = samples(0, THINK_PONDER).map((t) => ({ pose: avatarPose("thinking", t, false, undefined, idea), face: expressionFor("thinking", t, idea) }));
    expect(ponder.every(({ pose, face }) => pose.gazeY < -0.6 && face.dot === 1 && pose.ticks === 0)).toBe(true);
    // The eyes switch to the beat's side ahead of it, and the head turns after them.
    expect(Math.sign(avatarPose("thinking", 2, false, undefined, idea).gazeX)).toBe(1);
    expect(Math.sign(avatarPose("thinking", 4, false, undefined, idea).gazeX)).toBe(-1);
    const beat = samples(5.3, 6.3).map((t) => avatarPose("thinking", t, false, undefined, idea));
    expect(Math.max(...beat.map((pose) => pose.eyeScale))).toBeGreaterThan(1.15);
    expect(Math.max(...beat.map((pose) => pose.ticks))).toBeGreaterThan(0.95);
    expect(beat.every((pose) => pose.tickSide === -1)).toBe(true);
    expect(expressionFor("thinking", 5.6, idea).dot).toBe(0);
    expect(avatarPose("thinking", THINK_CYCLE - 0.01, false, undefined, idea).ticks).toBe(0);
  });

  it("rolls the face over the top on a tumble beat", () => {
    const tumble = plan("tumble", 2);
    const poses = samples(2, 2 + THINK_BEAT).map((t) => avatarPose("thinking", t, false, undefined, tumble));
    expect(poses.some((pose) => !pitchEyes(pose.pitch).visible)).toBe(true);
    expect(poses.every((pose) => pose.ticks === 0)).toBe(true);
    expect(pitchEyes(avatarPose("thinking", 2 + THINK_BEAT - 0.01, false, undefined, tumble).pitch).y).toBeCloseTo(0, 6);
  });

  it("never jumps the gaze between thinking loops the conductor books", () => {
    const conductor = new AvatarConductor();
    const kinds = new Set<string>();
    const poses = samples(0, THINK_CYCLE * 6, 0.01).map((now) => {
      const { since, plan: p } = conductor.cue("Juniper", "thinking", 0, false, false, now);
      if (p.gesture) kinds.add(p.gesture.kind);
      return avatarPose("thinking", now - since, false, undefined, p);
    });
    expect([...kinds].sort()).toEqual(["idea", "tumble"]);
    const jumps = poses.slice(1).map((pose, i) => Math.abs(pose.gazeX - poses[i].gazeX));
    // The eyes dart in 0.14 s, about 0.15 per 10 ms at most.
    expect(Math.max(...jumps)).toBeLessThan(0.2);
  });

  it.each(["tilt", "peek", "hop", "doubleTake"] as const)("plays an idle %s only while it is granted", (kind) => {
    const granted = plan(kind, 3);
    const moved = (t: number) => {
      const a = avatarPose("idle", t, false, undefined, granted), b = avatarPose("idle", t, false);
      return Math.abs(a.roll - b.roll) + Math.abs(a.yaw - b.yaw) + Math.abs(a.lift - b.lift) + Math.abs(a.eyeScale - b.eyeScale);
    };
    expect(Math.max(...samples(3, 3 + IDLE_GESTURE_LENGTH).map(moved))).toBeGreaterThan(0.2);
    expect([...samples(0, 3), ...samples(3 + IDLE_GESTURE_LENGTH, 8)].every((t) => moved(t) === 0)).toBe(true);
  });

  it("runs each bot's loops at its own phase and pace", () => {
    const a = { phase: 0, tempo: 1 }, b = { phase: 0.618, tempo: 0.95 };
    for (const state of ["idle", "working", "thinking", "waiting"] as const) {
      const apart = samples(1, 6, 0.1).filter((t) => {
        const p = avatarPose(state, t, false, undefined, a), q = avatarPose(state, t, false, undefined, b);
        return Math.abs(p.gazeX - q.gazeX) + Math.abs(p.roll - q.roll) + Math.abs(p.lift - q.lift) > 0.05;
      });
      expect(apart.length, state).toBeGreaterThan(40);
    }
  });

  it("draws emphasis marks fanning out on the chosen side", () => {
    expect(tickMarks(0, 1, 5)).toEqual([]);
    const right = tickMarks(1, 1, 5), left = tickMarks(1, -1, 5);
    expect(right).toHaveLength(3);
    const x = (d: string) => Number(d.slice(1).split(" ")[0]);
    expect(right.every((d) => x(d) > 50) && left.every((d) => x(d) < 50)).toBe(true);
  });
});
