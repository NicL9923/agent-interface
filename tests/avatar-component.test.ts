// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountRoot, stubMatchMedia } from "./ui-harness";
import { Avatar, motionOwner, silhouette } from "../src/components/Avatar";
import { avatarShapes, mascotFamilies, type ActivityState, type Avatar as AvatarConfig } from "../src/shared/types";
import { characterHeads, isCharacter, isSeasonal, seasonalAvatar } from "../src/components/character-avatars";

/** Every character drawn by the character module, in its everyday or seasonal colors. */
const characters = mascotFamilies.filter(isCharacter).map((family) => ({
  family,
  avatar: isSeasonal(family)
    ? seasonalAvatar(family)
    : { mode: "mascot", family, color: "#97683D", eyes: "round", accessory: "none" } as AvatarConfig,
}));

let container: HTMLDivElement;
let root: Root;
let now = 0;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let reduceMotion = false;
let reportVisibility: (visible: boolean) => void = () => {};

const render = (state: ActivityState, avatar?: AvatarConfig) =>
  act(async () => root.render(createElement(Avatar, { state, avatar, size: 64, name: "Ranch hand" })));
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
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      reportVisibility = (visible) => callback([{ isIntersecting: visible }]);
    }
    observe() {}
    disconnect() {}
  });
  // jsdom has no SVG geometry; a flat path is enough to exercise the rig.
  Object.assign(SVGElement.prototype, {
    getTotalLength: () => 100,
    getPointAtLength: (length: number) => ({ x: length, y: 0 }),
  });
  ({ container, root } = mountRoot());
});

describe("avatar animation loop", () => {
  it.each(characters)("animates the $family character while working", async ({ family, avatar }) => {
    await render("working", avatar);
    expect(container.querySelector('[role="img"]')?.getAttribute("data-family")).toBe(family);
    expect(container.querySelector("[data-character-feature]")).not.toBeNull();
    const before = svg();
    await advance(1);
    expect(svg()).not.toBe(before);
    expect(frames.size).toBeGreaterThan(0);
  });

  it("lets a small avatar sleep between frames but keeps a large one on every display refresh", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const tick = async () => {
        now += 1000 / 60;
        const queued = [...frames.values()];
        frames = new Map();
        await act(async () => queued.forEach((callback) => callback(now)));
      };
      await act(async () => root.render(createElement(Avatar, { state: "working", size: 40, name: "Ranch hand" })));
      // Past the 280 ms silhouette transition, which has its own frames.
      await advance(0.5);
      expect(frames.size).toBe(0);
      const before = svg();
      await act(async () => { vi.advanceTimersByTime(24); });
      expect(frames.size).toBe(1);
      await tick();
      expect(svg()).not.toBe(before);
      // Leaving the page must not leave a wake-up behind.
      act(() => root.unmount());
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(frames.size).toBe(0);
      await render("working");
      await advance(0.5);
      expect(frames.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sizes a portrait up front and loads it lazily, since list avatars are tiny copies of a large file", async () => {
    await render("idle", { mode: "portrait", src: "/api/files/portrait" } as AvatarConfig);
    const image = container.querySelector("img.avatar-portrait")!;
    expect([image.getAttribute("width"), image.getAttribute("height")]).toEqual(["64", "64"]);
    expect([image.getAttribute("loading"), image.getAttribute("decoding")]).toEqual(["lazy", "async"]);
  });

  it.each(characters)("keeps the $family character visible and still under reduced motion", async ({ avatar }) => {
    reduceMotion = true;
    await render("thinking", avatar);
    const before = svg();
    await advance(1);
    expect(svg()).toBe(before);
    expect(container.querySelector("[data-character-feature]")).not.toBeNull();
    expect(frames.size).toBe(0);
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Ranch hand: Thinking");
  });

  it.each<ActivityState>(["thinking", "working"])("keeps the avatar visible and animated while %s, then stops when unmounted", async (state) => {
    await render(state);
    const before = svg();
    await advance(1);
    expect(svg()).not.toBe(before);
    expect(container.querySelector(".avatar-body")?.parentElement?.getAttribute("opacity")).toBe("1");
    expect(frames.size).toBeGreaterThan(0);
    act(() => root.unmount());
    expect(frames.size).toBe(0);
  });

  it.each<ActivityState>(["disconnected", "interrupted"])("holds a %s avatar completely still", async (state) => {
    await render("working");
    await advance(0.5);
    await render(state);
    await advance(0.5);
    const frozen = svg();
    await advance(2);
    expect(svg()).toBe(frozen);
    expect(frames.size).toBe(0);
  });

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
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Ranch hand: Needs your help");
  });
});

it("keeps two bots that share a name apart in the motion conductor", () => {
  expect(motionOwner("ranch", "Helper", "a")).not.toBe(motionOwner("kitchen", "Helper", "b"));
  expect(motionOwner("ranch", "Helper", "a")).toBe(motionOwner("ranch", "Renamed", "b"));
  expect(motionOwner(undefined, "Welcome 1", "a")).toBe(motionOwner(undefined, "Welcome 1", "b"));
  expect(motionOwner(undefined, undefined, "a")).not.toBe(motionOwner(undefined, undefined, "b"));
});

describe("avatar silhouettes", () => {
  // The native copies of these outlines, faces and characters are checked in tests/avatar-art-parity.test.ts.
  it.each(avatarShapes)("draws %s as one closed outline", (shape) => {
    const d = silhouette(shape);
    if (shape !== "blob") expect(d).not.toBe(silhouette("blob"));
    // Morphing samples one continuous outline; native parses only absolute M L H V Q C Z.
    if (shape !== "circle") expect(d).toMatch(/^M[\d. -]+(?:[LHVQC][\d. -]+)+Z$/);
  });
});

describe("mascot characters", () => {
  it.each(Object.entries(characterHeads))("outlines %s as one closed native-parseable path", (_family, d) => {
    expect(d).toMatch(/^M[\d. -]+(?:[LHVQC][\d. -]+)+Z$/);
  });

  it("edges very light heads so they hold their shape on the cream surface", async () => {
    const edges = () => [...container.querySelectorAll("svg path[fill='none'][stroke-width='2.2']")];
    await render("idle", seasonalAvatar("ghost"));
    expect(edges()).toHaveLength(1);
    await render("idle", { mode: "mascot", family: "panda", color: "#292929", eyes: "round", accessory: "none" });
    expect(edges()).toHaveLength(1);
    await render("idle", seasonalAvatar("pumpkin"));
    expect(edges()).toHaveLength(0);
  });

  it("draws a black panda's glasses dark against its white face while its eyes stay light on the patches", async () => {
    await render("idle", { mode: "mascot", family: "panda", color: "#292929", eyes: "round", accessory: "glasses" });
    expect(container.querySelector("g[fill='#fff3db']")).not.toBeNull();
    const frames = [...container.querySelectorAll("ellipse[fill='none'][stroke-width='2.5'], path[fill='none'][stroke-width='2.5']")];
    expect(frames).toHaveLength(3);
    expect(frames.every((frame) => frame.getAttribute("stroke") === "#2b201b")).toBe(true);
  });

  it("gives each eye surround ink that contrasts with it", async () => {
    await render("idle", { mode: "mascot", family: "raccoon", color: "#8C8F99", eyes: "round", accessory: "none" });
    expect(container.querySelector("[data-character-feature='mask']")).not.toBeNull();
    expect(container.querySelector("g[fill='#fff3db']")).not.toBeNull();
    await render("idle", { mode: "mascot", family: "owl", color: "#292929", eyes: "round", accessory: "none" });
    expect(container.querySelectorAll("[data-character-feature='facial-disc']")).toHaveLength(2);
    expect(container.querySelector("g[fill='#2b201b']")).not.toBeNull();
  });
});
