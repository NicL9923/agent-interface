// @vitest-environment jsdom
import { expect, it } from "vitest";
import { gazeToward, withGaze } from "../src/components/avatar-attention";
import { mergeLeaving, type Shown } from "../src/app/use-leaving";
import { tapeSteps, toolGlyph } from "../src/app/work-tape";
import { botTint, tintProps } from "../src/app/bot-tint";
import type { Bot, ToolCall } from "../src/shared/types";

it("aims a gaze at a point, weaker when it is close and never past a full turn", () => {
  expect(gazeToward({ x: 0, y: 0 }, { x: 520, y: 0 })).toEqual({ x: 1, y: 0 });
  expect(gazeToward({ x: 0, y: 0 }, { x: 130, y: 0 }).x).toBeCloseTo(0.5);
  const down = gazeToward({ x: 100, y: 100 }, { x: 100, y: 1000 });
  expect(down.x).toBeCloseTo(0);
  expect(down.y).toBeCloseTo(0.8);
  expect(gazeToward({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 0, y: 0 });
});

it("blends a gaze into a pose in proportion to its pull and leaves a still gaze alone", () => {
  const pose = { gazeX: 0.4, gazeY: -0.2, yaw: 0.05, blink: 1 };
  expect(withGaze(pose, { x: 0, y: 0 })).toBe(pose);
  const full = withGaze(pose, { x: 1, y: 0 });
  expect(full.gazeX).toBeCloseTo(0.95);
  expect(full.yaw).toBeCloseTo(0.19);
  expect(full.blink).toBe(1);
  const half = withGaze(pose, { x: -0.5, y: 0 });
  expect(half.gazeX).toBeCloseTo(0.4 + (-0.475 - 0.4) * 0.5);
});

it("keeps a departing item at its place while it leaves, then drops it", () => {
  const key = (item: string) => item;
  let shown: Shown<string>[] = mergeLeaving([], ["a", "b", "c"], key, 0, 400);
  shown = mergeLeaving(shown, ["a", "c"], key, 100, 400);
  expect(shown.map(entry => [entry.key, entry.leavingSince])).toEqual([["a", undefined], ["b", 100], ["c", undefined]]);
  // Still leaving later on, from the time it started.
  shown = mergeLeaving(shown, ["a", "c", "d"], key, 300, 400);
  expect(shown.map(entry => [entry.key, entry.leavingSince])).toEqual([["a", undefined], ["b", 100], ["c", undefined], ["d", undefined]]);
  expect(mergeLeaving(shown, ["a", "c", "d"], key, 500, 400).map(entry => entry.key)).toEqual(["a", "c", "d"]);
  // An item that returns stops leaving; with no exit time nothing lingers.
  expect(mergeLeaving(shown, ["a", "b"], key, 320, 400).find(entry => entry.key === "b")?.leavingSince).toBeUndefined();
  expect(mergeLeaving(shown, [], key, 320, 0)).toEqual([]);
});

it("draws each tool with its family's glyph and folds old steps into a count", () => {
  expect(["web_search", "browser_navigate", "terminal", "read_file", "patch", "delegate_task", "mystery"].map(toolGlyph))
    .toEqual(["search", "computer", "terminal", "file", "pencil", "robot", "sparkle"]);
  const calls = Array.from({ length: 15 }, (_, index) => ({ id: `c${index}`, name: "terminal", status: "completed" }) as ToolCall);
  const { shown, folded } = tapeSteps(calls);
  expect(folded).toBe(3);
  expect(shown.map(call => call.id)).toEqual(calls.slice(3).map(call => call.id));
  expect(tapeSteps(calls.slice(0, 2))).toEqual({ shown: calls.slice(0, 2), folded: 0 });
});

it("tints a chat with a drawn avatar's color, and never with a photo or an unexpected value", () => {
  const drawn = { avatar: { mode: "mascot", family: "fox", color: "#C46F2C", eyes: "round", accessory: "none" } } as Bot;
  expect(botTint(drawn)).toBe("#C46F2C");
  expect(tintProps(drawn)).toEqual({ "data-tint": "", style: { "--bot-tint": "#C46F2C" } });
  expect(botTint({ avatar: { mode: "portrait", src: "/a.png", origin: "uploaded" } } as Bot)).toBeUndefined();
  expect(botTint({ avatar: { mode: "geometric", shape: "blob", color: "red; background: url(x)", eyes: "round", accessory: "none" } } as unknown as Bot)).toBeUndefined();
  expect(tintProps(undefined)).toEqual({});
});
