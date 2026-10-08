// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Avatar, faces, silhouette } from "../src/components/Avatar";
import { avatarShapes, type ActivityState, type Avatar as AvatarConfig } from "../src/shared/types";
import { seasonalAvatar, seasonalChoices } from "../src/components/seasonal-avatars";

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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  now = 0;
  frames = new Map();
  reduceMotion = false;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => frames.delete(handle));
  vi.stubGlobal("matchMedia", () => ({
    matches: reduceMotion,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("avatar animation loop", () => {
  it.each(seasonalChoices)("animates the $label character while working", async ({ family }) => {
    await render("working", seasonalAvatar(family));
    expect(container.querySelector('[role="img"]')?.getAttribute("data-family")).toBe(family);
    expect(container.querySelector("[data-seasonal-feature]")).not.toBeNull();
    const before = svg();
    await advance(1);
    expect(svg()).not.toBe(before);
    expect(frames.size).toBeGreaterThan(0);
  });

  it.each(seasonalChoices)("keeps the $label character visible and still under reduced motion", async ({ family }) => {
    reduceMotion = true;
    await render("thinking", seasonalAvatar(family));
    const before = svg();
    await advance(1);
    expect(svg()).toBe(before);
    expect(container.querySelector("[data-seasonal-feature]")).not.toBeNull();
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
    root = createRoot(container);
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

describe("avatar silhouettes", () => {
  // jsdom rewrites import.meta.url, so read from the project root.
  const native = (file: string) => readFileSync(resolve("ios/AgentInterface", file), "utf8");
  const swift = native("AvatarView.swift");

  it("lists the same shapes natively", () => {
    const list = native("Models.swift").match(/static let shapes = \[([^\]]*)\]/)![1];
    expect([...list.matchAll(/"(\w+)"/g)].map((m) => m[1])).toEqual([...avatarShapes]);
  });

  it.each(avatarShapes)("draws %s as one closed outline with a matching native face", (shape) => {
    const d = silhouette(shape);
    if (shape !== "blob") expect(d).not.toBe(silhouette("blob"));
    const nativePath = shape === "blob"
      ? swift.match(/default: "([^"]+)"/)![1]
      : swift.match(new RegExp(`case "${shape}":\\s*"([^"]+)"`))![1];
    // Morphing samples one continuous outline; native parses only absolute M L H V Q C Z.
    expect(nativePath).toMatch(/^M[\d. -]+(?:[LHVQC][\d. -]+)+Z$/);
    if (shape !== "circle") expect(nativePath).toBe(d);
    const anchor = swift.match(new RegExp(`"${shape}": Anchor\\(cy: ([\\d.]+), scale: ([\\d.]+), top: ([\\d.]+), hat: ([\\d.]+)\\)`))!;
    expect(anchor.slice(1).map(Number)).toEqual(Object.values(faces[shape]));
  });
});
