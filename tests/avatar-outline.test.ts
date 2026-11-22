import { describe, expect, it } from "vitest";
import {
  alignSamples,
  OUTLINE_SAMPLES,
  sampleOutline,
  signedArea,
  type Points,
} from "../src/components/avatar-outline";
import { shapes } from "../src/components/avatar-shapes";
import { avatarShapes } from "../src/shared/types";

const area = (points: Points) => Math.abs(signedArea(points));
const between = (from: Points, to: Points, t: number) =>
  from.map(([x, y], i) => [x + (to[i][0] - x) * t, y + (to[i][1] - y) * t]);

describe("the samples a shape morphs along", () => {
  it("walks only the outside of an outline, evenly, in every command the outlines use", () => {
    // A 40 by 20 box drawn with a line, a horizontal, a vertical, a flat quadratic and a flat
    // cubic, then a hole. Its outside is 120 units round, so 72 samples sit 5/3 apart.
    const box = sampleOutline(
      "M10 10 L30 10 H50 V30 Q30 30 10 30 C10 25 10 15 10 10Z M20 15 L20 25 L40 25Z",
    );
    expect(box).toHaveLength(OUTLINE_SAMPLES);
    expect(area(box)).toBeCloseTo(2 * 40 * 20, 6);
    const steps = box.map(([x, y], i) => {
      const [nx, ny] = box[(i + 1) % box.length];
      return Math.hypot(nx - x, ny - y);
    });
    // Three samples fall on a corner's diagonal, which cuts it short of 5/3.
    expect(steps.filter((step) => Math.abs(step - 5 / 3) < 1e-6).length).toBeGreaterThanOrEqual(68);
    const near = (value: number, edge: number) => Math.abs(value - edge) < 1e-9;
    // Every sample is on the box's edge: none strays to the hole inside it.
    expect(
      box.filter(([x, y]) => !(near(x, 10) || near(x, 50) || near(y, 10) || near(y, 30))),
    ).toEqual([]);
  });

  it("starts at the top and runs clockwise, wherever and whichever way the outline was drawn", () => {
    const square = [
      [10, 10],
      [30, 10],
      [50, 10],
      [50, 30],
      [50, 50],
      [30, 50],
      [10, 50],
      [10, 30],
    ];
    const aligned = alignSamples(square);
    expect(aligned[0]).toEqual([30, 10]);
    expect(aligned[1]).toEqual([50, 10]);
    // The same square drawn counter-clockwise from its bottom right corner.
    const turned = [...square.slice(4), ...square.slice(0, 4)].reverse();
    expect(signedArea(turned)).toBeLessThan(0);
    expect(alignSamples(turned)).toEqual(aligned);
    expect(alignSamples(aligned)).toEqual(aligned);
  });

  it("starts between two equally central samples at the higher one", () => {
    // A step in the top edge: [29, 10] and [31, 22] are each 1 unit from the middle at x 30.
    const stepped = [
      [10, 10],
      [29, 10],
      [31, 22],
      [50, 22],
      [50, 50],
      [10, 50],
    ];
    expect(alignSamples(stepped)[0]).toEqual([29, 10]);
    // And the same when the lower of the two comes first round the outline.
    expect(alignSamples(stepped.map(([x, y]) => [60 - x, y]))[0]).toEqual([31, 10]);
  });

  it("keeps every shape's samples: the blob's start where its outline does, a drop's reversed", () => {
    expect(sampleOutline(shapes.blob.path)[0]).toEqual([50, 3]);
    // The drop is drawn counter-clockwise from its tip. Unaligned, a blob would turn inside out on
    // its way to a drop.
    const drop = sampleOutline(shapes.drop.path);
    expect(drop[0]).toEqual([50, 7]);
    expect(drop[18][0]).toBeGreaterThan(50);
    expect(sampleOutline(shapes.blob.path)).toBe(sampleOutline(shapes.blob.path));
  });

  it("morphs between any two shapes without the body collapsing on the way", () => {
    // Sample i of one shape moves to sample i of the other. Before the samples were aligned, a
    // blob halfway to a reindeer had a quarter of the reindeer's area and its eyes were outside it.
    const thin: string[] = [];
    for (const from of avatarShapes)
      for (const to of avatarShapes) {
        const [a, b] = [sampleOutline(shapes[from].path), sampleOutline(shapes[to].path)];
        if (area(between(a, b, 0.5)) < 0.8 * Math.min(area(a), area(b)))
          thin.push(`${from} to ${to}`);
      }
    expect(thin).toEqual([]);
  });
});
