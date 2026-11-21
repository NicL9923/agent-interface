// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountRoot, stubMatchMedia } from "./ui-harness";
import { Avatar, motionOwner } from "../src/components/Avatar";
import { flattenOutline } from "../src/components/avatar-outline";
import { shapes } from "../src/components/avatar-shapes";
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
/** Each visible eye, left to right: its center, and how far its style reaches either side of it. */
const drawnEyes = (halfWidth = 5.5, halfHeight = 12.5) =>
  [...container.querySelectorAll("svg g[clip-path] g[fill] > g")]
    .map((eye) => {
      const [x, y] = /translate\(([-\d.]+) ([-\d.]+)/
        .exec(eye.getAttribute("transform")!)!
        .slice(1);
      const [sx, sy] = /scale\(([-\d.e]+) ([-\d.e]+)/
        .exec(eye.firstElementChild!.getAttribute("transform")!)!
        .slice(1);
      return { x: +x, y: +y, reach: halfWidth * +sx, rise: halfHeight * +sy };
    })
    .sort((a, b) => a.x - b.x);
const eyeXs = () => drawnEyes().map((eye) => eye.x);
/** Whether a point is on a shape's body: inside its outside contour, by the even-odd crossing count. */
function onBody(shape: AvatarShape, x: number, y: number) {
  const line = flattenOutline(shapes[shape].path);
  let inside = false;
  for (let i = 0, j = line.length - 1; i < line.length; j = i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[j];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}
/**
 * The eyes that leave the body. Every eye style is rounded, so it is the ends of its two axes that
 * reach farthest: the left and right of its middle, and its top and bottom.
 */
const eyesOffBody = (shape: AvatarShape, halfWidth?: number, halfHeight?: number) =>
  drawnEyes(halfWidth, halfHeight).filter(
    ({ x, y, reach, rise }) =>
      !onBody(shape, x - reach, y) ||
      !onBody(shape, x + reach, y) ||
      !onBody(shape, x, y - rise) ||
      !onBody(shape, x, y + rise),
  );

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

  // A lost connection is the app's state: the connection notice says it once, and a badge on every
  // assistant would say it again per face. A state that is the assistant's own still gets its badge.
  it.each([
    ["a drawn avatar", undefined],
    ["a portrait", { mode: "portrait", src: "/api/files/portrait" } as AvatarConfig],
  ])("puts no badge on %s for a lost connection", async (_name, avatar) => {
    await render("disconnected", avatar);
    expect(container.querySelector(".avatar-badge")).toBeNull();
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Ranch hand: Reconnecting",
    );
    await render("failed", avatar);
    expect(container.querySelector(".avatar-badge")).not.toBeNull();
  });

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

  it("draws every shape's eyes wholly on its body", async () => {
    reduceMotion = true;
    const clipped: string[] = [];
    for (const shape of avatarShapes) {
      await render("idle", shaped(shape));
      if (drawnEyes().length !== 2 || eyesOffBody(shape).length) clipped.push(shape);
    }
    expect(clipped).toEqual([]);
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

  it("keeps a working rocket's eyes on its hull as its face turns", async () => {
    // The blob's face turns on a 42-unit sphere. A rocket is 45 units wide, so on that sphere its
    // eyes would swing out past the hull and be cut off by it.
    await render("working", shaped("rocket"));
    let farthest = 0;
    const cut: number[] = [];
    for (let frame = 0; frame < 5 * 60; frame++) {
      await advance(1 / 60);
      if (eyesOffBody("rocket").length) cut.push(frame);
      for (const { x } of drawnEyes()) farthest = Math.max(farthest, Math.abs(x - 50));
    }
    expect(cut).toEqual([]);
    // The scan and the spin did carry the eyes out toward the edge, so the check above saw them there.
    expect(farthest).toBeGreaterThan(shapes.rocket.face.radius! * 0.8);
  });

  it("stops tuned eyes growing at the edge of the part the face sits on", async () => {
    const widest = { eyes: "visor", eyeWidth: 1.5, eyeHeight: 1.5, eyeSpacing: 1.5 } as const;
    // A visor at full width and spacing is 47 units across on a paint brush whose bristles are 43.
    await render("working", shaped("paint-brush", widest));
    const cut: number[] = [];
    let facing = 0;
    for (let frame = 0; frame < 5 * 60; frame++) {
      await advance(1 / 60);
      if (drawnEyes().length === 2) facing++;
      if (eyesOffBody("paint-brush", 10, 4.5).length) cut.push(frame);
    }
    expect(cut).toEqual([]);
    // Both eyes were there to be checked for most of it; they are out of sight only mid-spin.
    expect(facing).toBeGreaterThan(200);
    // The blob has room for them, so there they are as large and as far apart as chosen.
    reduceMotion = true;
    await render("idle", shaped("blob", widest));
    const [left, right] = drawnEyes(10, 4.5);
    expect(right.x - left.x).toBeCloseTo(45, 6);
    expect(left.reach).toBeGreaterThan(13);
  });

  it("morphs through 72 samples and lands on the real outline, hole and all", async () => {
    await render("idle", shaped("blob"));
    await render("idle", shaped("mug"));
    await advance(0.1);
    // Mid-morph the body is the samples on their way from one outside to the other.
    expect(body().split(" L")).toHaveLength(72);
    await advance(0.4);
    // The mug's second contour is its handle's hole, which the samples never carried.
    expect(shapes.mug.path.match(/M/g)).toHaveLength(2);
    expect(body()).toBe(shapes.mug.path);
  });

  it("draws an eye style it does not have as oval eyes instead of none", async () => {
    reduceMotion = true;
    await render("idle", shaped("blob"));
    const oval = svg();
    // Hermes metadata is not checked on the way in: a style from a newer release, the name of a
    // property every object inherits, and no style at all.
    for (const eyes of ["laser", "constructor", undefined]) {
      await render("idle", shaped("blob", { eyes } as Partial<AvatarConfig>));
      expect(drawnEyes()).toHaveLength(2);
      expect(svg()).toBe(oval);
    }
  });

  it("draws a shape it does not have as the blob instead of failing", async () => {
    // A newer release's shape, and the name of a property every object inherits, which Hermes
    // metadata could hold and a plain lookup would find.
    for (const shape of ["tesseract", "constructor", "toString"]) {
      await render("idle", shaped(shape as AvatarShape));
      expect(body()).toBe(shapes.blob.path);
    }
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

  it("edges a very light exclamation too, so a white assistant that needs help can be seen", async () => {
    reduceMotion = true;
    // The mark is the only circle the rig draws for a pill-eyed shape.
    const mark = () => container.querySelector("svg circle")!.closest("g[fill]")!;
    await render("blocked", shaped("ghost", { color: "#F4F4F4" }));
    expect(mark().getAttribute("fill")).toBe("#F4F4F4");
    expect([mark().getAttribute("stroke"), mark().getAttribute("stroke-width")]).toEqual([
      "#cdcdcd",
      "2.2",
    ]);
    await render("blocked", shaped("ghost", { color: "#FF6700" }));
    expect(mark().getAttribute("stroke")).toBeNull();
  });
});
