import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { avatarPose, expressionFor, motionSeed, pitchEyes, tickMarks } from "../src/components/avatar-motion";
import type { AvatarProp } from "../src/components/avatar-motion";
import type { ActivityState } from "../src/shared/types";

// AvatarView.swift repeats the motion model. These samples are its answer key, checked by
// ios/AgentInterfaceTests/AvatarMotionParityTests.swift.
const file = fileURLToPath(new URL("../ios/AgentInterfaceTests/Motion/avatar-motion.json", import.meta.url));
const instruction = "If the motion change is intended, run `UPDATE_MOTION=1 npx vitest run tests/avatar-motion-parity.test.ts`, commit the samples, and match AvatarView.swift until AvatarMotionParityTests passes.";
const round = (value: number) => Math.round(value * 1e6) / 1e6;
const rounded = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).map(([key, v]) => [key, typeof v === "number" ? round(v) : v]));
const states: ActivityState[] = ["idle", "thinking", "working", "waiting", "blocked", "done", "disconnected", "failed", "interrupted"];
const times = [0, 0.1, 0.37, 1, 1.7, 2.5, 3.22, 3.3, 3.45, 4.2, 5.1, 5.35, 5.6, 5.9, 6.2, 7.3, 11.5, 11.9, 12.3, 14, 20.5];
const names = ["Assistant", "Juniper", "Sage"];

function samples() {
  const poses: object[] = [];
  const add = (state: ActivityState, t: number, prop?: AvatarProp, seed = 0) =>
    poses.push({ state, t, ...(prop ? { prop } : {}), seed, pose: rounded(avatarPose(state, t, false, prop, seed)) });
  for (const state of states) for (const t of times) add(state, t);
  // Idle gestures depend on the seed; a long run at a fine step lands inside each kind.
  for (let t = 0; t < 40; t += 0.15) add("idle", round(t), undefined, motionSeed("Juniper"));
  for (const prop of ["search", "computer", "read", "write"] as const) for (const t of [0.4, 1.9, 3.3]) add("working", t, prop);
  return {
    seeds: Object.fromEntries(names.map((name) => [name, motionSeed(name)])),
    poses,
    expressions: states.flatMap((state) => times.map((t) => ({ state, t, expression: rounded(expressionFor(state, t)) }))),
    pitch: [0, 0.8, Math.PI / 2, 2.6, Math.PI, 4.4, 5.9].map((pitch) => ({ pitch: round(pitch), ...rounded(pitchEyes(pitch)) })),
    ticks: [[0, 1, 5], [0.4, 1, 5], [1, -1, 12], [1.2, 1, 2]].map(([level, side, top]) => ({ level, side, top, paths: tickMarks(level, side, top) })),
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
