import { describe, expect, it } from "vitest";
import {
  CELEBRATION,
  WORK_CYCLE,
  WORK_SPIN,
  animatesAt,
  avatarPose,
  blinkAt,
  expressionFor,
  faceInk,
  orbitArcs,
  project,
  restingPose,
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
});
