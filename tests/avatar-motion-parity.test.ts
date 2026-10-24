import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AvatarConductor } from "../src/components/avatar-conductor";
import { avatarPose, expressionFor, gestureLength, IDLE_FRAME_MS, idleQuietAt, motionSeed, pitchEyes, ringOffset, soloPlan, tickMarks } from "../src/components/avatar-motion";
import type { AvatarProp, GestureKind, MotionPlan } from "../src/components/avatar-motion";
import type { ActivityState } from "../src/shared/types";

// AvatarView.swift repeats the motion model and the conductor. These samples are its answer key,
// checked by ios/AgentInterfaceTests/AvatarMotionParityTests.swift.
const file = fileURLToPath(new URL("../ios/AgentInterfaceTests/Motion/avatar-motion.json", import.meta.url));
const instruction = "If the motion change is intended, run `UPDATE_MOTION=1 npx vitest run tests/avatar-motion-parity.test.ts`, commit the samples, and match AvatarView.swift until AvatarMotionParityTests passes.";
const round = (value: number) => Math.round(value * 1e6) / 1e6;
const rounded = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).map(([key, v]) => [key, typeof v === "number" ? round(v) : v && typeof v === "object" ? rounded(v) : v])) as T;
const states: ActivityState[] = ["idle", "thinking", "working", "waiting", "blocked", "done", "disconnected", "failed", "interrupted"];
const times = [0, 0.1, 0.37, 1, 1.7, 2.5, 3.22, 3.3, 3.45, 4.2, 5.1, 5.35, 5.6, 5.9, 6.2, 7.3, 11.5, 11.9, 12.3, 14, 20.5];
const names = ["Assistant", "Juniper", "Sage"];
/** Each named gesture in the state that plays it, granted partway in, with an offset clock and a boop. */
const granted: [ActivityState, GestureKind][] = [
  ["idle", "tilt"], ["idle", "peek"], ["idle", "hop"], ["idle", "doubleTake"], ["working", "spin"],
  ["thinking", "idea"], ["thinking", "tumble"], ["done", "twirl"], ["done", "cheer"], ["failed", "shake"], ["blocked", "nudge"],
];
const offset = (kind: GestureKind, start = 2.3): MotionPlan =>
  ({ phase: 0.37, tempo: 1.08, boop: 0.1, gesture: { kind, side: -1, start }, previous: { kind: "idea", side: 1, start: -1 } });

/**
 * A scripted household for the conductor: each avatar's owner and its timeline of
 * [seconds, state or null when off screen, held prop]. Avatar 5 is a second view of owner A.
 */
const household: { owner: string; timeline: [number, ActivityState | null, boolean][] }[] = [
  { owner: "A", timeline: [[0, "idle", false], [12, "working", false], [30, "done", false], [34, "idle", false]] },
  { owner: "B", timeline: [[0, "working", false], [8, "working", true], [11, "working", false], [26, "done", false], [29, "thinking", false]] },
  { owner: "C", timeline: [[0, "thinking", false], [25, "working", false], [40, "failed", false], [45, "blocked", false]] },
  { owner: "D", timeline: [[0, "idle", false], [30, "done", false], [50, "waiting", false]] },
  { owner: "E", timeline: [[0, "idle", false], [20, null, false], [26, "idle", false], [30, "done", false], [33, "failed", false]] },
  { owner: "A", timeline: [[5, "idle", false], [12, "working", false], [30, "done", false], [34, "idle", false]] },
];
const scenario = { step: 0.05, steps: 1200, household };

/** Replays the household; Swift runs the same loop and must log the same cue changes. */
function conduct() {
  const conductor = new AvatarConductor();
  const views = household.map(() => ({ state: null as ActivityState | null, since: 0, entered: false, last: "" }));
  const log: object[] = [];
  for (let step = 0; step < scenario.steps; step++) {
    const now = step * scenario.step;
    household.forEach(({ owner, timeline }, avatar) => {
      const entry = timeline.filter(([at]) => at <= now).at(-1);
      const view = views[avatar];
      if (!entry || entry[1] === null) {
        view.state = null;
        return;
      }
      const [, state, held] = entry;
      if (state !== view.state) Object.assign(view, { entered: view.state !== null, since: now, state });
      const cue = conductor.cue(owner, state, view.since, view.entered, held, now);
      const out = rounded({ since: cue.since, ...cue.plan });
      const key = JSON.stringify(out);
      if (key !== view.last) log.push({ step, avatar, cue: out });
      view.last = key;
    });
  }
  return log;
}

function samples() {
  const poses: object[] = [];
  const add = (state: ActivityState, t: number, prop?: AvatarProp, plan: MotionPlan = soloPlan) =>
    poses.push({ state, t, ...(prop ? { prop } : {}), plan, pose: rounded(avatarPose(state, t, false, prop, plan)) });
  for (const state of states) for (const t of times) add(state, t);
  // A fine step lands inside every part of each gesture.
  for (const [state, kind] of granted) {
    const plan = offset(kind);
    for (let t = 0; t < 2.3 + gestureLength[kind] + 2.5; t += 0.07) add(state, round(t), undefined, plan);
  }
  for (const prop of ["search", "computer", "read", "write"] as const) for (const t of [0.4, 1.9, 3.3]) {
    add("working", t, prop);
    add("working", t, prop, offset("spin"));
  }
  const expressions: object[] = [];
  const express = (state: ActivityState, t: number, plan: MotionPlan = soloPlan) =>
    expressions.push({ state, t, plan, expression: rounded(expressionFor(state, t, plan)) });
  for (const state of states) for (const t of times) express(state, t);
  for (const t of times) {
    express("thinking", t, offset("idea", 4.8));
    express("thinking", t, offset("tumble", 5.5));
    express("done", t, offset("twirl", 1.2));
  }
  // When an idle avatar may draw slowly, over the wait until its next frame. Every 0.05 s for 12 s
  // crosses blinks, double blinks, gaze shifts, a gesture and an arrival.
  const ahead = round((IDLE_FRAME_MS + 20) / 1000);
  const quiet = [soloPlan, offset("tilt", 6.1)].map(plan => ({ plan, ahead,
    quiet: Array.from({ length: 240 }, (_, step) => idleQuietAt(round(step * 0.05), plan, ahead) ? 1 : 0).join("") }));
  return {
    seeds: Object.fromEntries(names.map((name) => [name, motionSeed(name)])),
    rings: Object.fromEntries(names.map((name) => [name, rounded(ringOffset(name))])),
    poses,
    expressions,
    quiet,
    pitch: [0, 0.8, Math.PI / 2, 2.6, Math.PI, 4.4, 5.9].map((pitch) => ({ pitch: round(pitch), ...rounded(pitchEyes(pitch)) })),
    ticks: [[0, 1, 5], [0.4, 1, 5], [1, -1, 12], [1.2, 1, 2]].map(([level, side, top]) => ({ level, side, top, paths: tickMarks(level, side, top) })),
    scenario,
    cues: conduct(),
  };
}

describe("native avatar motion samples", () => {
  it("match the web motion model", () => {
    // One sample per line keeps a motion change readable in review.
    const current = "{\n" + Object.entries(samples()).map(([key, value]) => Array.isArray(value)
      ? `${JSON.stringify(key)}: [\n${value.map((item) => " " + JSON.stringify(item)).join(",\n")}\n]`
      : `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(",\n") + "\n}\n";
    if (process.env.UPDATE_MOTION) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, current);
    }
    expect(existsSync(file), instruction).toBe(true);
    expect(readFileSync(file, "utf8") === current, instruction).toBe(true);
  });
});
