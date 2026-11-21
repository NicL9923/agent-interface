// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountRoot, stubMatchMedia } from "./ui-harness";
import { Avatar, motionOwner } from "../src/components/Avatar";
import { outside, shapes } from "../src/components/avatar-shapes";
import {
  avatarShapes,
  type ActivityState,
  type Avatar as AvatarConfig,
  type AvatarShape,
} from "../src/shared/types";

const shaped = (shape: AvatarShape, patch: Partial<AvatarConfig> = {}) =>
  ({
    mode: "geometric",
    shape,
    color: "#1084FE",
    eyes: "oval",
    accessory: "none",
    ...patch,
  }) as AvatarConfig;

let container: HTMLDivElement;
let root: Root;
let now = 0;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let reduceMotion = false;
let reportVisibility: (visible: boolean) => void = () => {};

const render = (state: ActivityState, avatar?: AvatarConfig) =>
  act(async () =>
    root.render(createElement(Avatar, { state, avatar, size: 64, name: "Ranch hand" })),
  );
/** Advances the controlled clock, running every frame callback that was queued. */
const advance = async (seconds: number) => {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    now += 1000 / 60;
    const queued = [...frames.values()];
    frames = new Map();
    await act(async () => queued.forEach((callback) => callback(now)));
  }
};
const svg = () => container.querySelector("svg")!.innerHTML;
const body = () => container.querySelector(".avatar-body")!.getAttribute("d")!;
/** Where each visible eye is drawn across the body, left to right. */
const eyeXs = () =>
  [...container.querySelectorAll("svg g[clip-path] g[fill] > g")]
    .map((eye) => Number(/translate\(([-\d.]+)/.exec(eye.getAttribute("transform")!)![1]))
    .sort((a, b) => a - b);

beforeEach(() => {
  now = 0;
  frames = new Map();
  reduceMotion = false;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => frames.delete(handle));
  stubMatchMedia(() => reduceMotion);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        reportVisibility = (visible) => callback([{ isIntersecting: visible }]);
      }
      observe() {}
      disconnect() {}
    },
  );
  // jsdom has no SVG geometry; a flat path is enough to exercise the rig. It runs 100 units for
  // each contour it was given, so a test can tell which contours were walked.
  Object.assign(SVGElement.prototype, {
    getTotalLength(this: SVGElement) {
      return 100 * (this.getAttribute("d")?.match(/M/g)?.length ?? 1);
    },
    getPointAtLength: (length: number) => ({ x: length, y: 0 }),
  });
  ({ container, root } = mountRoot());
});

describe("avatar animation loop", () => {
  it("lets a small avatar sleep between frames but keeps a large one on every display refresh", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const tick = async () => {
        now += 1000 / 60;
        const queued = [...frames.values()];
        frames = new Map();
        await act(async () => queued.forEach((callback) => callback(now)));
      };
      await act(async () =>
        root.render(createElement(Avatar, { state: "working", size: 40, name: "Ranch hand" })),
      );
      // Past the 280 ms silhouette transition, which has its own frames.
      await advance(0.5);
      expect(frames.size).toBe(0);
      const before = svg();
      await act(async () => {
        vi.advanceTimersByTime(24);
      });
      expect(frames.size).toBe(1);
      await tick();
      expect(svg()).not.toBe(before);
      // Leaving the page must not leave a wake-up behind.
      act(() => root.unmount());
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(frames.size).toBe(0);
      await render("working");
      await advance(0.5);
      expect(frames.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("samples a shape once however many avatars draw it", async () => {
    // Each sampling is 72 calls into the browser's path geometry, the main cost of a phone opening home.
    const sample = vi.spyOn(
      SVGElement.prototype as unknown as { getPointAtLength: (length: number) => DOMPoint },
      "getPointAtLength",
    );
    await act(async () =>
      root.render(
        createElement(
          "div",
          null,
          ...Array.from({ length: 20 }, (_, index) =>
            createElement(Avatar, { key: index, state: "idle", size: 40, name: "Hay shed" }),
          ),
        ),
      ),
    );
    await advance(0.5);
    expect(sample.mock.calls.length).toBeLessThanOrEqual(72);
  });

  it("draws several working avatars from one frame callback", async () => {
    await act(async () =>
      root.render(
        createElement(
          "div",
          null,
          createElement(Avatar, { state: "working", size: 64, name: "Ranch hand" }),
          createElement(Avatar, { state: "working", size: 64, name: "Foreman" }),
          createElement(Avatar, { state: "working", size: 64, name: "Wrangler" }),
        ),
      ),
    );
    // Past the silhouette transitions, which have their own frames.
    await advance(0.5);
    const poses = [...container.querySelectorAll("svg")].map((node) => node.innerHTML);
    expect(frames.size).toBe(1);
    await advance(0.5);
    expect(frames.size).toBe(1);
    expect([...container.querySelectorAll("svg")].map((node) => node.innerHTML)).not.toEqual(poses);
  });

  it("sizes a portrait up front and loads it lazily, since list avatars are tiny copies of a large file", async () => {
    await render("idle", { mode: "portrait", src: "/api/files/portrait" } as AvatarConfig);
    const image = container.querySelector("img.avatar-portrait")!;
    expect([image.getAttribute("width"), image.getAttribute("height")]).toEqual(["64", "64"]);
    expect([image.getAttribute("loading"), image.getAttribute("decoding")]).toEqual([
      "lazy",
      "async",
    ]);
  });

  it.each<ActivityState>(["thinking", "working"])(
    "keeps the avatar visible and animated while %s, then stops when unmounted",
    async (state) => {
      await render(state);
      const before = svg();
      await advance(1);
      expect(svg()).not.toBe(before);
      expect(container.querySelector(".avatar-body")?.parentElement?.getAttribute("opacity")).toBe(
        "1",
      );
      expect(frames.size).toBeGreaterThan(0);
      act(() => root.unmount());
      expect(frames.size).toBe(0);
    },
  );

  it.each<ActivityState>(["disconnected", "interrupted"])(
    "holds a %s avatar completely still",
    async (state) => {
      await render("working");
      await advance(0.5);
      await render(state);
      await advance(0.5);
      const frozen = svg();
      await advance(2);
      expect(svg()).toBe(frozen);
      expect(frames.size).toBe(0);
    },
  );

  it("stops after a failure settles", async () => {
    await render("failed");
    await advance(1.5);
    expect(frames.size).toBe(0);
  });

  it("pauses offscreen and resumes when visible", async () => {
    await render("working");
    await act(async () => reportVisibility(false));
    await advance(0.5);
    expect(frames.size).toBe(0);
    await act(async () => reportVisibility(true));
    await advance(0.2);
    expect(frames.size).toBeGreaterThan(0);
  });

  it("does not animate under reduced motion", async () => {
    reduceMotion = true;
    await render("working");
    const still = svg();
    await advance(1);
    expect(svg()).toBe(still);
    expect(frames.size).toBe(0);
  });

  it("names the assistant and its state for assistive technology", async () => {
    await render("blocked");
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Ranch hand: Needs your help",
    );
  });
});

it("keeps two bots that share a name apart in the motion conductor", () => {
  expect(motionOwner("ranch", "Helper", "a")).not.toBe(motionOwner("kitchen", "Helper", "b"));
  expect(motionOwner("ranch", "Helper", "a")).toBe(motionOwner("ranch", "Renamed", "b"));
  expect(motionOwner(undefined, "Welcome 1", "a")).toBe(motionOwner(undefined, "Welcome 1", "b"));
  expect(motionOwner(undefined, undefined, "a")).not.toBe(motionOwner(undefined, undefined, "b"));
});

describe("avatar shapes", () => {
  // The native copies of these outlines and faces are checked in tests/avatar-art-parity.test.ts.
  it("writes every outline as closed contours the native reader can parse", () => {
    // ios/AgentInterface/AvatarView.swift reads absolute M L H V Q C Z and nothing else, so an
    // arc or a relative command would draw a different shape there without failing.
    const contours = /^(?:M[\d. -]+(?:[LHVQC][\d. -]+)+Z ?)+$/;
    expect(avatarShapes.filter((shape) => !contours.test(shapes[shape].path))).toEqual([]);
  });

  it("keeps each face on its body, with room for the eyes at their largest", () => {
    // The eye sliders reach 1.5 times; a face anchored off its part would show clipped eyes.
    const cramped = avatarShapes.filter((shape) => {
      const { cx = 50, cy, scale, spacing = 30 * scale, radius = 42, top } = shapes[shape].face;
      return spacing / 2 + 5.5 * scale > radius || cy - 12.5 * scale <= top || cx < 30 || cx > 70;
    });
    expect(cramped).toEqual([]);
  });

  it("looks out from the part that carries the face, not the middle of the box", async () => {
    reduceMotion = true;
    await render("idle", shaped("mug"));
    const { cx, spacing } = shapes.mug.face;
    expect(cx).toBeLessThan(45);
    const [left, right] = eyeXs();
    expect(left).toBeCloseTo(cx! - spacing! / 2, 6);
    expect(right).toBeCloseTo(cx! + spacing! / 2, 6);
    await render("idle", shaped("blob"));
    expect(eyeXs().map((x) => Math.round(x * 1e6) / 1e6)).toEqual([35, 65]);
  });

  it("sets a hat on the head it belongs to", async () => {
    reduceMotion = true;
    await render("idle", shaped("mug", { accessory: "hat" }));
    const { cx, top, hat } = shapes.mug.face;
    // The crown is the only path filled with this brown.
    const crown = container.querySelector("svg path[fill='#3a2f28']")!.parentElement!;
    expect(crown.getAttribute("transform")).toBe(
      `translate(${cx} ${top + 15 * hat}) scale(${hat})`,
    );
  });

  it("keeps a turning face on a narrow body", async () => {
    // A rocket is 45 units wide. On the blob's 42-unit sphere its eyes would swing out past its hull.
    await render("working", shaped("rocket"));
    const { cx = 50, radius } = shapes.rocket.face;
    let farthest = 0;
    for (let frame = 0; frame < 5 * 60; frame++) {
      await advance(1 / 60);
      for (const x of eyeXs()) farthest = Math.max(farthest, Math.abs(x - cx));
    }
    expect(radius).toBeLessThan(25);
    // The scan and the spin both carry the eyes most of the way to the edge of the sphere.
    expect(farthest).toBeGreaterThan(radius! * 0.6);
    expect(farthest).toBeLessThanOrEqual(radius!);
  });

  it("morphs along the outside of a shape with a hole and lands on its real outline", async () => {
    await render("idle", shaped("blob"));
    await render("idle", shaped("mug"));
    await advance(0.1);
    // Mid-morph the body is the 72 samples. Walking the handle's hole as well would put them
    // on 200 units of path instead of the outside's 100.
    const samples = body()
      .slice(1, -1)
      .split(" L")
      .map((point) => Number(point.split(" ")[0]));
    expect(samples).toHaveLength(72);
    expect(Math.max(...samples)).toBeLessThan(100);
    await advance(0.4);
    expect(shapes.mug.path.match(/M/g)).toHaveLength(2);
    expect(body()).toBe(shapes.mug.path);
    expect(outside(shapes.mug.path)).toBe(shapes.mug.path.slice(0, shapes.mug.path.indexOf(" M")));
  });

  it("draws a shape from a newer release as the blob instead of failing", async () => {
    await render("idle", shaped("tesseract" as AvatarShape));
    expect(body()).toBe(shapes.blob.path);
  });

  it("edges a very light body so it holds its shape on the cream surface", async () => {
    const edges = () => [
      ...container.querySelectorAll("svg path[fill='none'][stroke-width='2.2']"),
    ];
    await render("idle", shaped("ghost", { color: "#F4F4F4" }));
    expect(edges().map((edge) => edge.getAttribute("d"))).toEqual([shapes.ghost.path]);
    await render("idle", shaped("ghost", { color: "#FF6700" }));
    expect(edges()).toHaveLength(0);
  });
});
