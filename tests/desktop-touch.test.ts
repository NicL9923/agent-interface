// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type RFB from "@novnc/novnc";
import { attachDesktopTouch, TouchGestures, touchTuning, type TouchAction } from "../src/lib/desktop-touch";

let actions: TouchAction[];
let zoomed: boolean;
let gestures: TouchGestures;
let clock: number;
beforeEach(() => {
  vi.useFakeTimers();
  actions = []; zoomed = false; clock = 1000;
  gestures = new TouchGestures(action => actions.push(action), () => zoomed);
});
afterEach(() => { vi.useRealTimers(); });
const p = (x: number, y: number) => ({ x, y });
const later = (ms: number) => { clock += ms; vi.advanceTimersByTime(ms); };
function tap(at = p(100, 100), id = 1) {
  gestures.start(id, at, clock); later(60); gestures.end(id, clock);
}
const left = (down: boolean): TouchAction => ({ type: "button", button: "left", down });
const right = (down: boolean): TouchAction => ({ type: "button", button: "right", down });

describe("touching the desktop directly", () => {
  it("clicks where a finger taps", () => {
    tap(p(120, 80));
    expect(actions).toEqual([{ type: "point", at: p(120, 80) }, left(true), left(false)]);
  });
  it("lands a quick second tap on the first spot, so the desktop sees a double-click", () => {
    tap(p(100, 100)); later(150); tap(p(112, 95));
    expect(actions.filter(action => action.type === "point")).toEqual([{ type: "point", at: p(100, 100) }, { type: "point", at: p(100, 100) }]);
    actions = []; later(touchTuning.doubleTap + 50); tap(p(112, 95));
    expect(actions[0]).toEqual({ type: "point", at: p(112, 95) });
  });
  it("drags with one finger from where it landed, holding the left button until it lifts", () => {
    gestures.start(1, p(10, 10), clock);
    gestures.move([[1, p(14, 12)]]);
    expect(actions).toEqual([]);
    gestures.move([[1, p(40, 10)]]); gestures.move([[1, p(60, 30)]]);
    later(touchTuning.longPress * 2);
    gestures.end(1, clock);
    expect(actions).toEqual([{ type: "point", at: p(10, 10) }, left(true), { type: "point", at: p(40, 10) }, { type: "point", at: p(60, 30) }, left(false)]);
  });
  it("right-clicks on press and hold, once, and ignores the rest of that touch", () => {
    gestures.start(1, p(50, 60), clock);
    later(touchTuning.longPress);
    expect(actions).toEqual([{ type: "point", at: p(50, 60) }, right(true), right(false)]);
    gestures.move([[1, p(200, 200)]]); gestures.end(1, clock);
    expect(actions).toHaveLength(3);
  });
  it("right-clicks between two fingers on a two-finger tap", () => {
    gestures.start(1, p(100, 100), clock); gestures.start(2, p(140, 120), clock);
    later(100); gestures.end(1, clock); gestures.end(2, clock);
    expect(actions).toEqual([{ type: "point", at: p(120, 110) }, right(true), right(false)]);
  });
  it("scrolls with two fingers, one wheel step per stretch of travel, the way content follows them", () => {
    gestures.start(1, p(100, 100), clock); gestures.start(2, p(140, 100), clock);
    gestures.move([[1, p(100, 200)], [2, p(140, 200)]]);
    // The midpoint moved 50 then 100 down: two steps of wheel up, pointed at where the fingers began.
    expect(actions).toEqual([{ type: "point", at: p(120, 100) }, ...Array(2).fill({ type: "wheel", direction: "up" })]);
    actions = [];
    gestures.move([[1, p(100, 60)], [2, p(140, 60)]]);
    expect(actions.every(action => action.type === "wheel" && action.direction === "down")).toBe(true);
    expect(actions.length).toBe(3);
    gestures.end(1, clock); gestures.end(2, clock);
    expect(actions.some(action => action.type === "button")).toBe(false);
  });
  it("zooms the view with a pinch, and pans instead of scrolling once zoomed", () => {
    gestures.start(1, p(100, 100), clock); gestures.start(2, p(200, 100), clock);
    gestures.move([[1, p(50, 100)], [2, p(250, 100)]]);
    expect(actions).toEqual([{ type: "view", scale: 2, center: p(150, 100), dx: 0, dy: 0 }]);
    gestures.end(1, clock); gestures.end(2, clock);
    zoomed = true; actions = [];
    gestures.start(1, p(100, 100), clock); gestures.start(2, p(200, 100), clock);
    gestures.move([[1, p(100, 130)], [2, p(200, 130)]]);
    expect(actions).toEqual([{ type: "view", scale: 1, center: p(150, 130), dx: 0, dy: 30 }]);
  });
  it("lets go of a held button when the system takes the touch", () => {
    gestures.start(1, p(10, 10), clock); gestures.move([[1, p(60, 10)]]);
    gestures.cancel();
    expect(actions.at(-1)).toEqual(left(false));
  });
  it("ignores a second finger once a drag has started", () => {
    gestures.start(1, p(10, 10), clock); gestures.move([[1, p(60, 10)]]);
    gestures.start(2, p(90, 90), clock); gestures.end(2, clock);
    gestures.move([[1, p(70, 10)]]); gestures.end(1, clock);
    expect(actions.map(action => action.type)).toEqual(["point", "button", "point", "point", "button"]);
  });
});

describe("trackpad mode", () => {
  beforeEach(() => { gestures.trackpad = true; });
  it("moves the pointer by finger travel and clicks where the pointer is", () => {
    gestures.start(1, p(100, 100), clock);
    gestures.move([[1, p(130, 90)]]); gestures.move([[1, p(140, 95)]]);
    gestures.end(1, clock);
    expect(actions).toEqual([{ type: "nudge", dx: 30, dy: -10 }, { type: "nudge", dx: 10, dy: 5 }]);
    actions = []; later(touchTuning.doubleTap + 1);
    tap(p(300, 300));
    expect(actions).toEqual([left(true), left(false)]);
  });
  it("drags after a tap followed by a touch that moves, and double-clicks on two taps", () => {
    tap(); later(100);
    gestures.start(1, p(100, 100), clock); gestures.move([[1, p(150, 100)]]); gestures.end(1, clock);
    expect(actions).toEqual([left(true), left(false), left(true), { type: "nudge", dx: 50, dy: 0 }, left(false)]);
    actions = []; later(touchTuning.doubleTap + 1);
    tap(); later(100); tap();
    expect(actions).toEqual([left(true), left(false), left(true), left(false)]);
  });
  it("does not right-click a resting finger, but does on a two-finger tap, at the pointer", () => {
    gestures.start(1, p(100, 100), clock);
    later(touchTuning.longPress * 3);
    expect(actions).toEqual([]);
    gestures.start(2, p(150, 100), clock); later(50);
    gestures.end(2, clock); gestures.end(1, clock);
    expect(actions).toEqual([right(true), right(false)]);
  });
});

describe("the viewer page's touch layer", () => {
  function viewer({ pointer = true } = {}) {
    const stage = document.createElement("div");
    const target = document.createElement("div");
    const canvas = document.createElement("canvas");
    stage.append(target); target.append(canvas); document.body.append(stage);
    // An 800x500 canvas at (0, 0), shown at half size until the target is zoomed.
    Object.defineProperties(canvas, { clientWidth: { value: 400 }, clientHeight: { value: 250 } });
    Object.defineProperties(target, { offsetWidth: { value: 400 }, offsetHeight: { value: 250 } });
    // Only the canvas moves and scales; the target, which noVNC measures, stays put.
    const scale = () => Number(/scale\(([\d.]+)\)/.exec(canvas.style.transform)?.[1] ?? 1);
    const offset = () => (/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(canvas.style.transform) ?? [0, 0, 0]).slice(1).map(Number);
    canvas.getBoundingClientRect = () => {
      const [x, y] = offset();
      return { left: x, top: y, width: 400 * scale(), height: 250 * scale(), right: 0, bottom: 0, x, y, toJSON() {} } as DOMRect;
    };
    target.getBoundingClientRect = stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 250 }) as DOMRect;
    const rfb = Object.assign(new EventTarget(), { viewOnly: false, focus: vi.fn(), _handleMouseButton: vi.fn(), _handleMouseMove: vi.fn() });
    const client = pointer ? rfb : Object.assign(new EventTarget(), { viewOnly: false, focus: vi.fn() });
    const onZoom = vi.fn();
    const layer = attachDesktopTouch(client as unknown as RFB, target, { onZoom });
    const touch = (type: string, touches: Array<[number, number, number]>) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "changedTouches", { value: touches.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY })) });
      canvas.dispatchEvent(event);
      return event;
    };
    const mouse = (type: string, clientX: number, clientY: number, buttons: number) => {
      canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, buttons }));
    };
    return { stage, target, canvas, rfb, layer: layer!, nullLayer: layer, onZoom, touch, mouse };
  }
  afterEach(() => { document.body.replaceChildren(); });

  it("keeps touches from noVNC and the page, and clicks at the canvas point under the finger", () => {
    const { canvas, rfb, touch } = viewer();
    const noVNC = vi.fn();
    canvas.addEventListener("touchstart", noVNC);
    const start = touch("touchstart", [[1, 100, 50]]);
    touch("touchend", [[1, 100, 50]]);
    expect(noVNC).not.toHaveBeenCalled();
    expect(start.defaultPrevented).toBe(true);
    expect(rfb.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(rfb._handleMouseMove).toHaveBeenCalledWith(100, 50);
    expect(rfb._handleMouseButton.mock.calls).toEqual([[100, 50, 1], [100, 50, 0]]);
  });
  it("zooms the view under a pinch and maps taps through the zoom", () => {
    const { target, canvas, rfb, onZoom, layer, touch } = viewer();
    touch("touchstart", [[1, 100, 100], [2, 200, 100]]);
    touch("touchmove", [[1, 50, 100], [2, 250, 100]]);
    touch("touchend", [[1, 50, 100], [2, 250, 100]]);
    expect(canvas.style.transform).toMatch(/scale\(2\)/);
    // noVNC sizes the canvas from the target's box, which must not see the zoom.
    expect(target.style.transform).toBe("");
    expect(onZoom).toHaveBeenLastCalledWith(true);
    rfb._handleMouseButton.mockClear();
    vi.advanceTimersByTime(1000);
    // Zoomed 2x around (150, 100): screen (150, 100) is still canvas (150, 100).
    touch("touchstart", [[3, 150, 100]]); touch("touchend", [[3, 150, 100]]);
    expect(rfb._handleMouseButton.mock.calls[0].map(Math.round)).toEqual([150, 100, 1]);
    layer.resetZoom();
    expect(canvas.style.transform).toBe("");
    expect(onZoom).toHaveBeenLastCalledWith(false);
  });
  it("keeps the desktop under the fingers' midpoint while a pinch also moves", () => {
    const { canvas, rfb, touch } = viewer();
    touch("touchstart", [[1, 100, 100], [2, 200, 100]]);
    touch("touchmove", [[2, 300, 100]]);
    // Canvas x 150 was under the midpoint; at 2x it is under the new midpoint, x 200.
    expect(canvas.style.transform).toBe("translate(-100px, -100px) scale(2)");
    touch("touchend", [[1, 100, 100], [2, 300, 100]]);
    vi.advanceTimersByTime(1000);
    touch("touchstart", [[3, 200, 100]]); touch("touchend", [[3, 200, 100]]);
    expect(rfb._handleMouseButton.mock.calls[0].map(Math.round)).toEqual([150, 100, 1]);
  });
  it("maps a mouse through the zoom, and leaves an unzoomed mouse to noVNC", () => {
    const { canvas, rfb, touch, mouse } = viewer();
    const noVNC = vi.fn();
    canvas.addEventListener("mousedown", noVNC);
    mouse("mousedown", 100, 50, 1);
    expect(noVNC).toHaveBeenCalledOnce();
    expect(rfb._handleMouseButton).not.toHaveBeenCalled();
    touch("touchstart", [[1, 100, 100], [2, 200, 100]]);
    touch("touchmove", [[1, 50, 100], [2, 250, 100]]);
    touch("touchend", [[1, 50, 100], [2, 250, 100]]);
    mouse("mousedown", 150, 100, 2);
    mouse("mousemove", 250, 100, 2);
    mouse("mouseup", 250, 100, 0);
    expect(noVNC).toHaveBeenCalledOnce();
    expect(rfb._handleMouseButton.mock.calls.map(call => call.map(Math.round))).toEqual([[150, 100, 4], [200, 100, 0]]);
    expect(rfb._handleMouseMove.mock.lastCall!.map(Math.round)).toEqual([200, 100]);
  });
  it("shows a pointer only in trackpad mode, moves it by finger travel and recenters it", () => {
    const { stage, rfb, layer, touch } = viewer();
    const marker = stage.querySelector<HTMLElement>(".desktop-touch-pointer")!;
    expect(marker.hidden).toBe(true);
    layer.setTrackpad(true);
    expect(marker.hidden).toBe(false);
    touch("touchstart", [[1, 10, 10]]); touch("touchmove", [[1, 30, 10]]); touch("touchend", [[1, 30, 10]]);
    // From the middle (200, 125), 20px of travel at 1.5x.
    expect(rfb._handleMouseMove.mock.lastCall!.map(Math.round)).toEqual([230, 125]);
    layer.recenter();
    expect(rfb._handleMouseMove).toHaveBeenLastCalledWith(200, 125);
    layer.setTrackpad(false);
    expect(marker.hidden).toBe(true);
  });
  it("leaves the element as it found it when detached", () => {
    const { stage, target, canvas, layer, touch } = viewer();
    layer.detach();
    expect(stage.querySelector(".desktop-touch-pointer")).toBeNull();
    expect([canvas.style.transform, target.style.touchAction]).toEqual(["", ""]);
    const noVNC = vi.fn();
    canvas.addEventListener("touchstart", noVNC);
    touch("touchstart", [[1, 1, 1]]);
    expect(noVNC).toHaveBeenCalled();
  });
  it("stays out of the way, leaving noVNC's own gestures, if noVNC's pointer methods are gone", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { nullLayer, target } = viewer({ pointer: false });
    expect(nullLayer).toBeNull();
    expect(target.style.touchAction).toBe("");
    expect(error).toHaveBeenCalled();
  });
});

it("relies only on noVNC pointer methods the pinned version has, which send nothing while view-only", () => {
  const source = readFileSync("node_modules/@novnc/novnc/core/rfb.js", "utf8");
  expect(source).toContain("    _handleMouseButton(x, y, bmask) {");
  expect(source).toContain("    _handleMouseMove(x, y) {");
  const sendMouse = source.slice(source.indexOf("    _sendMouse(x, y, mask) {"), source.indexOf("    _handleWheel(ev) {"));
  expect(sendMouse).toContain("if (this._viewOnly) { return; }");
  expect(sendMouse).toContain("this._display.absX(x)");
});
