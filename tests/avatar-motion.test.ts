import { describe, expect, it } from "vitest";
import {
  CELEBRATION,
  IDLE_GESTURE,
  THINK_CYCLE,
  WORK_CYCLE,
  WORK_SPIN,
  animatesAt,
  avatarPose,
  avatarProp,
  blinkAt,
  expressionFor,
  faceInk,
  motionSeed,
  orbitArcs,
  pitchEyes,
  project,
  restingPose,
  tickMarks,
} from "../src/components/avatar-motion";
import type { ActivityState } from "../src/shared/types";
import { avatarColors } from "../src/components/Avatar";

const samples = (from: number, to: number, step = 0.02) =>
  Array.from({ length: Math.round((to - from) / step) }, (_, i) => from + i * step);

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
  });

  it("keeps the face forward while working until a spin turns it away", () => {
    const scanEnd = WORK_CYCLE - WORK_SPIN;
    for (const t of samples(0, scanEnd)) {
      const pose = avatarPose("working", t, false);
      expect(project(0, pose.yaw).visible).toBe(true);
      expect(pose.trails).toBe(0);
    }
    const spin = samples(scanEnd, WORK_CYCLE).map((t) => avatarPose("working", t, false));
    expect(spin.some((pose) => !project(0, pose.yaw).visible)).toBe(true);
    expect(Math.max(...spin.map((pose) => pose.trails))).toBeGreaterThan(0.9);
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
    const celebrating = samples(0, CELEBRATION).map((t) => avatarPose("done", t, false));
    expect(Math.max(...celebrating.map((pose) => pose.trails))).toBe(1);
    const after = avatarPose("done", CELEBRATION + 2, false);
    expect(after.trails).toBe(0);
    expect(project(0, after.yaw).visible).toBe(true);
    expect(expressionFor("done", CELEBRATION + 2).happy).toBe(1);
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
    const ponder = samples(0, 5).map((t) => ({ pose: avatarPose("thinking", t, false), face: expressionFor("thinking", t) }));
    expect(ponder.every(({ pose, face }) => pose.gazeY < -0.6 && face.dot === 1 && pose.ticks === 0)).toBe(true);
    // The eyes switch sides partway, and the head turns after them.
    expect(Math.sign(avatarPose("thinking", 2, false).gazeX)).toBe(-Math.sign(avatarPose("thinking", 4, false).gazeX));
    const idea = samples(5.3, 6.3).map((t) => avatarPose("thinking", t, false));
    expect(Math.max(...idea.map((pose) => pose.eyeScale))).toBeGreaterThan(1.15);
    expect(Math.max(...idea.map((pose) => pose.ticks))).toBeGreaterThan(0.95);
    expect(expressionFor("thinking", 5.6).dot).toBe(0);
    expect(avatarPose("thinking", THINK_CYCLE - 0.01, false).ticks).toBe(0);
  });

  it("rolls the face over the top on every other thinking beat", () => {
    const tumble = samples(THINK_CYCLE + 5, THINK_CYCLE * 2).map((t) => avatarPose("thinking", t, false));
    expect(tumble.some((pose) => !pitchEyes(pose.pitch).visible)).toBe(true);
    expect(tumble.every((pose) => pose.ticks === 0)).toBe(true);
    expect(pitchEyes(avatarPose("thinking", THINK_CYCLE * 2 - 0.01, false).pitch).y).toBeCloseTo(0, 6);
  });

  it("never jumps the gaze between thinking loops", () => {
    const poses = samples(0, THINK_CYCLE * 4, 0.01).map((t) => avatarPose("thinking", t, false));
    const jumps = poses.slice(1).map((pose, i) => Math.abs(pose.gazeX - poses[i].gazeX));
    // The eyes dart in 0.14 s, about 0.15 per 10 ms at most.
    expect(Math.max(...jumps)).toBeLessThan(0.2);
  });

  it("gestures now and then while idle, at times of its own", () => {
    const gesturing = (seed: number) => samples(0, IDLE_GESTURE * 4, 0.05)
      .filter((t) => {
        const pose = avatarPose("idle", t, false, undefined, seed);
        return pose.eyeScale > 1.01 || Math.abs(pose.roll) > 4 || pose.lift < -2 || Math.abs(pose.yaw) > 0.3;
      });
    const a = gesturing(motionSeed("Juniper")), b = gesturing(motionSeed("Sage"));
    expect(a.length).toBeGreaterThan(0);
    expect(a.length / (IDLE_GESTURE * 4 / 0.05)).toBeLessThan(0.2);
    expect(a).not.toEqual(b);
    expect(samples(0, 2, 0.05).every((t) => avatarPose("idle", t, false, undefined, motionSeed("Juniper")).eyeScale === 1)).toBe(true);
  });

  it("draws emphasis marks fanning out on the chosen side", () => {
    expect(tickMarks(0, 1, 5)).toEqual([]);
    const right = tickMarks(1, 1, 5), left = tickMarks(1, -1, 5);
    expect(right).toHaveLength(3);
    const x = (d: string) => Number(d.slice(1).split(" ")[0]);
    expect(right.every((d) => x(d) > 50) && left.every((d) => x(d) < 50)).toBe(true);
  });
});
