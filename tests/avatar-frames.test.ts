import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameAnimation } from "../src/components/avatar-frames";

// Each commit batch is one flushSync call, so counting calls counts React commits.
const flushSync = vi.hoisted(() => vi.fn((update: () => void) => update()));
vi.mock("react-dom", () => ({ flushSync }));
const { startFrames } = await import("../src/components/avatar-frames");

let now = 0;
let queued = new Map<number, FrameRequestCallback>();
let requests = 0;
const stops: (() => void)[] = [];
const reported: unknown[] = [];

/** Runs the frame callbacks queued so far, as one display refresh would. */
function refresh(milliseconds = 1000 / 60) {
  now += milliseconds;
  const callbacks = [...queued.values()];
  queued = new Map();
  callbacks.forEach(callback => callback(now));
}
/** A fake avatar that answers every frame with the same pause. */
function avatar(pause: number | null | (() => number | null)) {
  const animation = {
    advance: vi.fn((_now: number) => typeof pause === "function" ? pause() : pause),
    commit: vi.fn(),
  } satisfies FrameAnimation;
  stops.push(startFrames(animation));
  return animation;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  now = 0;
  queued = new Map();
  requests = 0;
  reported.length = 0;
  flushSync.mockClear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queued.set(++requests, callback);
    return requests;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => queued.delete(handle));
  vi.stubGlobal("queueMicrotask", (callback: () => void) => { try { callback(); } catch (error) { reported.push(error); } });
});
afterEach(() => {
  stops.splice(0).forEach(stop => stop());
  vi.useRealTimers();
});

describe("shared avatar frame loop", () => {
  it("runs every large avatar from one frame callback and one commit", () => {
    const [a, b, c] = [avatar(0), avatar(0), avatar(0)];
    expect(queued.size).toBe(1);
    for (let frame = 1; frame <= 3; frame++) {
      refresh();
      expect(flushSync).toHaveBeenCalledTimes(frame);
      for (const each of [a, b, c]) {
        expect(each.advance).toHaveBeenCalledTimes(frame);
        expect(each.advance).toHaveBeenLastCalledWith(now);
        expect(each.commit).toHaveBeenCalledTimes(frame);
      }
      expect(queued.size).toBe(1);
    }
    expect(requests).toBe(4);
  });

  it("keeps small avatars at about 30 fps beside large ones, which stay on every refresh", () => {
    const large = avatar(0);
    const small = avatar(24);
    refresh();
    expect([large.advance.mock.calls.length, small.advance.mock.calls.length]).toEqual([1, 1]);
    // The small one sleeps, so the next frame carries only the large one.
    refresh();
    expect([large.advance.mock.calls.length, small.advance.mock.calls.length]).toEqual([2, 1]);
    expect(large.commit).toHaveBeenCalledTimes(2);
    expect(small.commit).toHaveBeenCalledTimes(1);
    // Its wake-up joins the frame already queued rather than asking for another.
    const before = requests;
    vi.advanceTimersByTime(24);
    expect(requests).toBe(before);
    expect(queued.size).toBe(1);
    refresh();
    expect([large.advance.mock.calls.length, small.advance.mock.calls.length]).toEqual([3, 2]);
    expect(flushSync).toHaveBeenCalledTimes(3);
  });

  it("asks for no frame while every avatar sleeps, then wakes them together", () => {
    const first = avatar(83);
    const second = avatar(83);
    refresh();
    expect(queued.size).toBe(0);
    vi.advanceTimersByTime(82);
    expect(queued.size).toBe(0);
    vi.advanceTimersByTime(1);
    // Both woke on one timer tick, so they share one frame.
    expect(queued.size).toBe(1);
    refresh();
    expect([first.advance.mock.calls.length, second.advance.mock.calls.length]).toEqual([2, 2]);
    expect(flushSync).toHaveBeenCalledTimes(2);
  });

  it("lets an avatar with nothing left to animate go, and stops the loop when none remain", () => {
    const settled = avatar(null);
    const running = avatar(0);
    refresh();
    expect(settled.commit).toHaveBeenCalledTimes(1);
    refresh();
    expect(settled.advance).toHaveBeenCalledTimes(1);
    stops.shift()!();
    stops.shift()!();
    expect(queued.size).toBe(0);
    expect(running.advance).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(queued.size).toBe(0);
  });

  it("cancels the pending frame and a sleeping avatar's wake-up on unsubscribe", () => {
    const sleeper = avatar(24);
    refresh();
    stops.pop()!();
    vi.advanceTimersByTime(100);
    expect(queued.size).toBe(0);
    expect(sleeper.advance).toHaveBeenCalledTimes(1);
    avatar(0);
    expect(queued.size).toBe(1);
    stops.pop()!();
    expect(queued.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one avatar's unsubscribe from disturbing the others", () => {
    const [a, b] = [avatar(0), avatar(0)];
    refresh();
    stops.shift()!();
    refresh();
    expect([a.advance.mock.calls.length, b.advance.mock.calls.length]).toEqual([1, 2]);
    expect(queued.size).toBe(1);
  });

  it("stops an avatar that throws without stopping the rest", () => {
    const broken = avatar(() => { throw new Error("bad pose"); });
    const fine = avatar(0);
    refresh();
    refresh();
    expect(broken.advance).toHaveBeenCalledTimes(1);
    expect(fine.advance).toHaveBeenCalledTimes(2);
    expect(reported).toEqual([new Error("bad pose")]);
  });
});
