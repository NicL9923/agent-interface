// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountRoot, stubMatchMedia, type Mount } from "./ui-harness";
import { Avatar } from "../src/components/Avatar";
import { cheerFrames, glanceAtAvatar, nodFrames, POINTER_REST_MS, reactAvatar, useAvatarAttention } from "../src/components/avatar-attention";
import { morphNavigate } from "../src/app/navigation-morph";
import { WorkTape } from "../src/app/WorkTape";
import type { ToolCall } from "../src/shared/types";

let mount: Mount;
let now = 0;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let reduceMotion = false;
const runFrames = async (count = 30) => {
  for (let i = 0; i < count; i++) {
    now += 1000 / 60;
    const queued = [...frames.values()];
    frames = new Map();
    await act(async () => queued.forEach(callback => callback(now)));
  }
};
const box = (x: number, y: number, size = 60) => ({ left: x - size / 2, top: y - size / 2, right: x + size / 2, bottom: y + size / 2, width: size, height: size, x, y, toJSON() {} }) as DOMRect;

beforeEach(() => {
  now = 0;
  frames = new Map();
  reduceMotion = false;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => frames.delete(handle));
  stubMatchMedia(query => query.includes("reduced-motion") && reduceMotion);
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  Object.assign(SVGElement.prototype, { getTotalLength: () => 100, getPointAtLength: (length: number) => ({ x: length, y: 0 }) });
  mount = mountRoot();
});
afterEach(() => {
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});

describe("avatar reactions", () => {
  it("hops with a burst of sparks on a cheer and dips on a nod, only for its own assistant", async () => {
    const animate = vi.fn();
    Object.assign(HTMLElement.prototype, { animate });
    await mount.render(createElement(Avatar, { botId: "ranch", name: "Ranch hand", size: 64 }));
    await act(async () => reactAvatar("garden", "cheer"));
    expect(animate).not.toHaveBeenCalled();
    await act(async () => reactAvatar("ranch", "cheer"));
    expect(animate).toHaveBeenCalledWith(cheerFrames, expect.objectContaining({ duration: 760 }));
    expect(mount.container.querySelectorAll(".avatar-burst > i")).toHaveLength(8);
    expect(mount.container.querySelector(".avatar-burst")?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => reactAvatar("ranch", "nod"));
    expect(animate).toHaveBeenLastCalledWith(nodFrames, expect.objectContaining({ duration: 520 }));
  });
  it("stays still under Reduce Motion", async () => {
    reduceMotion = true;
    const animate = vi.fn();
    Object.assign(HTMLElement.prototype, { animate });
    await mount.render(createElement(Avatar, { botId: "ranch", name: "Ranch hand", size: 64 }));
    await act(async () => reactAvatar("ranch", "cheer"));
    expect(animate).not.toHaveBeenCalled();
    expect(mount.container.querySelector(".avatar-burst")).toBeNull();
  });
});

describe("avatar attention", () => {
  function Probe({ enabled = true }: { enabled?: boolean }) {
    const wrapper = useRef<HTMLSpanElement>(null);
    const gaze = useAvatarAttention(wrapper, "ranch", enabled);
    return createElement("span", { ref: wrapper, "data-gaze": `${gaze.x.toFixed(2)},${gaze.y.toFixed(2)}` });
  }
  const gaze = () => mount.container.querySelector("[data-gaze]")!.getAttribute("data-gaze")!.split(",").map(Number);
  const point = (x: number, y: number) => act(async () => window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y })));

  it("follows a mouse pointer, looks at a sibling that finished, and returns to the front when the pointer rests", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        return this.dataset.glanceTarget === "garden" ? box(100, 700) : box(100, 100);
      });
      const sibling = document.createElement("span");
      sibling.dataset.glanceTarget = "garden";
      document.body.append(sibling);
      await mount.render(createElement(Probe));
      await point(700, 100);
      await runFrames();
      expect(gaze()[0]).toBeCloseTo(1, 1);
      // A sibling finishing below wins over the pointer for a moment.
      await act(async () => glanceAtAvatar("garden"));
      await runFrames();
      expect(gaze()[0]).toBeCloseTo(0, 1);
      expect(gaze()[1]).toBeCloseTo(0.8, 1);
      // Its own finish never makes an avatar look at itself.
      await act(async () => glanceAtAvatar("ranch"));
      // Frame time and timers move together, as they do in a browser.
      now += POINTER_REST_MS + 100;
      await act(async () => { vi.advanceTimersByTime(POINTER_REST_MS + 100); });
      await runFrames(60);
      expect(gaze()).toEqual([0, 0]);
      sibling.remove();
    } finally { vi.useRealTimers(); }
  });
  it("ignores the pointer when not enabled", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(box(100, 100));
    await mount.render(createElement(Probe, { enabled: false }));
    await point(700, 100);
    await runFrames();
    expect(gaze()).toEqual([0, 0]);
  });
});

describe("phone navigation morph", () => {
  const source = () => document.querySelector<HTMLElement>("#source");
  const target = () => document.querySelector<HTMLElement>("#target");
  beforeEach(() => {
    document.body.insertAdjacentHTML("beforeend", '<span id="source"></span><span id="target"></span>');
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(box(100, 100));
  });
  afterEach(() => {
    source()?.remove();
    target()?.remove();
    delete (document as { startViewTransition?: unknown }).startViewTransition;
  });

  it("changes at once without view transitions", () => {
    const update = vi.fn();
    morphNavigate(update, source, target, "forward");
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.navigation).toBeUndefined();
  });
  it("moves the avatar's name from its old place to its new one inside the transition, then clears both", async () => {
    let finish!: () => void;
    const seen: string[] = [];
    Object.assign(document, { startViewTransition: (callback: () => void) => {
      seen.push(`before:${source()!.style.viewTransitionName}:${document.documentElement.dataset.navigation}`);
      callback();
      seen.push(`after:${source()!.style.viewTransitionName}|${target()!.style.viewTransitionName}`);
      return { finished: new Promise<void>(resolve => { finish = resolve; }) };
    } });
    const update = vi.fn();
    morphNavigate(update, source, target, "back");
    expect(update).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["before:wildbots-avatar:back", "after:|wildbots-avatar"]);
    await act(async () => finish());
    expect(target()!.style.viewTransitionName).toBe("");
    expect(document.documentElement.dataset.navigation).toBeUndefined();
  });
  it("skips the transition under Reduce Motion", () => {
    reduceMotion = true;
    const start = vi.fn();
    Object.assign(document, { startViewTransition: start });
    const update = vi.fn();
    morphNavigate(update, source, target, "forward");
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });
});

it("lists the running turn's tools with their outcomes for screen readers", async () => {
  const calls: ToolCall[] = [
    { id: "a", name: "web_search", status: "completed" },
    { id: "b", name: "terminal", status: "failed" },
    { id: "c", name: "browser_navigate", status: "running" },
  ];
  await mount.render(createElement(WorkTape, { calls }));
  const tape = mount.container.querySelector("ol.work-tape")!;
  expect(tape.getAttribute("aria-label")).toBe("3 steps so far");
  expect([...tape.querySelectorAll("li")].map(item => [item.className, item.textContent])).toEqual([
    ["work-tape-step is-completed", "web_search, done"],
    ["work-tape-step is-failed", "terminal, failed"],
    ["work-tape-step is-running", "browser_navigate, running"],
  ]);
  await mount.render(createElement(WorkTape, { calls: [] }));
  expect(mount.container.querySelector(".work-tape")).toBeNull();
});
