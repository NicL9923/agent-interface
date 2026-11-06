import type RFB from "@novnc/novnc";

/**
 * Touch control of the shared desktop for the web panel and the iOS viewer page. noVNC's own
 * gestures send a pinch to the desktop as Ctrl+wheel and have no trackpad mode, so this layer takes
 * every touch on the viewer first:
 *
 * - Tap clicks where you tapped; one finger drags; a quick second tap at the same spot double-clicks.
 * - Two-finger tap, or press and hold, right-clicks.
 * - Two fingers scroll. Pinch zooms this view, not the desktop; zoomed in, two fingers pan instead.
 * - Trackpad mode: a finger moves the pointer, a tap clicks there, double-tap and hold drags.
 *
 * Mouse and keyboard input still go straight to noVNC.
 */
export type Point = { x: number; y: number };
export type TouchAction =
  /** Move the desktop pointer under this screen point. */
  | { type: "point"; at: Point }
  /** Move the trackpad pointer by this much on screen. */
  | { type: "nudge"; dx: number; dy: number }
  | { type: "button"; button: "left" | "right"; down: boolean }
  | { type: "wheel"; direction: "up" | "down" | "left" | "right" }
  /** Zoom this view by `scale` around `center`, then pan it by dx, dy. */
  | { type: "view"; scale: number; center: Point; dx: number; dy: number };

export const touchTuning = {
  /** Screen pixels a finger may wander and still tap. */
  slop: 10,
  longPress: 500,
  /** Between one tap and the next touch, for a double-click or a trackpad drag. */
  doubleTap: 350,
  /** A second tap this close to the first clicks the first spot, so the desktop sees a double-click. */
  doubleTapSlop: 40,
  twoFingerTap: 350,
  /** Change in finger spread, in screen pixels, that starts a pinch. */
  pinchSlop: 16,
  /** Two-finger travel, in screen pixels, for one wheel step. */
  wheelStep: 40,
} as const;

type State =
  | { kind: "idle" }
  | { kind: "one"; id: number; start: Point; at: number; afterTap: boolean }
  | { kind: "drag"; id: number; last: Point; held: boolean }
  | { kind: "two"; ids: [number, number]; start: Point; spread: number; last: Point; lastSpread: number; at: number; mode: "pending" | "scroll" | "view"; wheel: Point }
  /** The gesture is over; nothing happens until every finger lifts. */
  | { kind: "spent" };

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const middle = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** The gesture rules, apart from the page so they can be tested. Points are screen coordinates. */
export class TouchGestures {
  trackpad = false;
  private state: State = { kind: "idle" };
  private touches = new Map<number, Point>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastTap: { at: number; point: Point } | undefined;
  constructor(private emit: (action: TouchAction) => void, private zoomed: () => boolean) {}

  start(id: number, point: Point, now: number) {
    this.touches.set(id, point);
    const state = this.state;
    if (state.kind === "idle") {
      const afterTap = !!this.lastTap && now - this.lastTap.at < touchTuning.doubleTap;
      this.state = { kind: "one", id, start: point, at: now, afterTap };
      // A finger resting on a trackpad is not a request for a menu.
      if (!this.trackpad) this.timer = setTimeout(() => this.longPress(), touchTuning.longPress);
    } else if (state.kind === "one") {
      this.clearTimer();
      const [a, b] = [...this.touches.entries()];
      const start = middle(a[1], b[1]), spread = distance(a[1], b[1]);
      this.state = { kind: "two", ids: [a[0], b[0]], start, spread, last: start, lastSpread: spread, at: now, mode: "pending", wheel: { x: 0, y: 0 } };
      this.lastTap = undefined;
    }
  }

  /** Every finger that moved in one touch event, so a pinch sees both fingers move together. */
  move(changes: Array<[id: number, point: Point]>) {
    const moved = changes.filter(([id]) => this.touches.has(id));
    if (!moved.length) return;
    for (const [id, point] of moved) this.touches.set(id, point);
    const state = this.state;
    const point = (id: number) => this.touches.get(id)!;
    const has = (id: number) => moved.some(([changed]) => changed === id);
    if (state.kind === "one" && has(state.id)) {
      this.moveOne(state, point(state.id));
    } else if (state.kind === "drag" && has(state.id)) {
      const now = point(state.id);
      if (this.trackpad) this.emit({ type: "nudge", dx: now.x - state.last.x, dy: now.y - state.last.y });
      else this.emit({ type: "point", at: now });
      state.last = now;
    } else if (state.kind === "two" && (has(state.ids[0]) || has(state.ids[1]))) {
      this.moveTwo(state, point(state.ids[0]), point(state.ids[1]));
    }
  }

  private moveOne(state: Extract<State, { kind: "one" }>, point: Point) {
    const id = state.id;
    if (distance(point, state.start) <= touchTuning.slop) return;
    this.clearTimer();
    this.lastTap = undefined;
    if (this.trackpad) {
      if (state.afterTap) this.emit({ type: "button", button: "left", down: true });
      this.emit({ type: "nudge", dx: point.x - state.start.x, dy: point.y - state.start.y });
      this.state = { kind: "drag", id, last: point, held: state.afterTap };
    } else {
      this.emit({ type: "point", at: state.start });
      this.emit({ type: "button", button: "left", down: true });
      this.emit({ type: "point", at: point });
      this.state = { kind: "drag", id, last: point, held: true };
    }
  }

  private moveTwo(state: Extract<State, { kind: "two" }>, a: Point, b: Point) {
    const mid = middle(a, b), spread = distance(a, b);
    if (state.mode === "pending") {
      if (Math.abs(spread - state.spread) > touchTuning.pinchSlop) state.mode = "view";
      else if (distance(mid, state.start) > touchTuning.slop) {
        state.mode = this.zoomed() ? "view" : "scroll";
        if (state.mode === "scroll" && !this.trackpad) this.emit({ type: "point", at: state.start });
      } else return;
    }
    if (state.mode === "view") {
      this.emit({ type: "view", scale: spread / state.lastSpread, center: mid, dx: mid.x - state.last.x, dy: mid.y - state.last.y });
    } else {
      // Fingers moving down bring what is above into view: the wheel turns up.
      const wheel = state.wheel;
      wheel.x += mid.x - state.last.x; wheel.y += mid.y - state.last.y;
      const step = touchTuning.wheelStep;
      for (; wheel.y >= step; wheel.y -= step) this.emit({ type: "wheel", direction: "up" });
      for (; wheel.y <= -step; wheel.y += step) this.emit({ type: "wheel", direction: "down" });
      for (; wheel.x >= step; wheel.x -= step) this.emit({ type: "wheel", direction: "left" });
      for (; wheel.x <= -step; wheel.x += step) this.emit({ type: "wheel", direction: "right" });
    }
    state.last = mid; state.lastSpread = spread;
  }

  end(id: number, now: number) {
    if (!this.touches.delete(id)) return;
    const state = this.state;
    if (state.kind === "one" && state.id === id) {
      this.clearTimer();
      let at = state.start;
      if (!this.trackpad) {
        // A double-click needs both clicks on one spot; fingers rarely land twice on the same pixel.
        const last = this.lastTap;
        if (last && state.at - last.at < touchTuning.doubleTap && distance(last.point, at) < touchTuning.doubleTapSlop) at = last.point;
        this.emit({ type: "point", at });
      }
      this.emit({ type: "button", button: "left", down: true });
      this.emit({ type: "button", button: "left", down: false });
      this.lastTap = { at: now, point: at };
    } else if (state.kind === "drag" && state.id === id) {
      if (state.held) this.emit({ type: "button", button: "left", down: false });
    } else if (state.kind === "two" && state.ids.includes(id)) {
      if (state.mode === "pending" && now - state.at <= touchTuning.twoFingerTap) this.rightClick(state.start);
    } else if (state.kind !== "spent") return;
    this.state = this.touches.size ? { kind: "spent" } : { kind: "idle" };
  }

  /** The system took the touches, as for an incoming call. A held button is let go. */
  cancel() {
    this.clearTimer();
    if (this.state.kind === "drag" && this.state.held) this.emit({ type: "button", button: "left", down: false });
    this.touches.clear();
    this.state = { kind: "idle" };
    this.lastTap = undefined;
  }

  private longPress() {
    this.timer = undefined;
    const state = this.state;
    if (state.kind !== "one") return;
    this.rightClick(state.start);
    this.state = { kind: "spent" };
    this.lastTap = undefined;
  }
  private rightClick(at: Point) {
    if (!this.trackpad) this.emit({ type: "point", at });
    this.emit({ type: "button", button: "right", down: true });
    this.emit({ type: "button", button: "right", down: false });
  }
  private clearTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/**
 * noVNC 1.7 has no public pointer API. These two methods take canvas coordinates, apply its scale and
 * send nothing while it is view-only, as its own gesture handler relies on. They are checked when the
 * viewer attaches, and tests/desktop-touch.test.ts checks the pinned noVNC source still has them.
 */
type Pointer = {
  _handleMouseButton(x: number, y: number, mask: number): void;
  _handleMouseMove(x: number, y: number): void;
};
function pointerOf(rfb: RFB): Pointer | null {
  const candidate = rfb as unknown as Partial<Pointer>;
  return typeof candidate._handleMouseButton === "function" && typeof candidate._handleMouseMove === "function" ? candidate as Pointer : null;
}

const buttons = { left: 0x1, right: 0x4 } as const;
const wheelButtons = { up: 0x8, down: 0x10, left: 0x20, right: 0x40 } as const;
const maxZoom = 5;
/** Trackpad pointer speed: screen pixels per pixel of finger travel. */
const trackpadGain = 1.5;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export interface DesktopTouch {
  setTrackpad(on: boolean): void;
  /** Puts the trackpad pointer back in the middle of what is on screen. */
  recenter(): void;
  resetZoom(): void;
  detach(): void;
}

/**
 * Takes the touches on `target`, the element given to noVNC, and zooms that element inside its
 * parent, which must clip it. `onZoom` reports whether the view is zoomed in. Null, leaving noVNC's
 * own gestures in place, if its pointer methods are gone.
 */
export function attachDesktopTouch(rfb: RFB, target: HTMLElement, { onZoom }: { onZoom?: (zoomed: boolean) => void } = {}): DesktopTouch | null {
  const pointer = pointerOf(rfb);
  if (!pointer) {
    console.error("Desktop touch controls are off: noVNC's pointer methods changed.");
    return null;
  }
  const view = { scale: 1, x: 0, y: 0 };
  /** The desktop pointer as a fraction of the canvas, so a resize or rotation keeps its place. */
  let at: Point | undefined;
  let mask = 0;
  const gestures = new TouchGestures(act, () => view.scale > 1);
  const marker = document.createElement("div");
  marker.className = "desktop-touch-pointer";
  marker.setAttribute("aria-hidden", "true");
  marker.hidden = true;
  marker.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 9-6.2 1.3L7.5 19Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  Object.assign(marker.style, { position: "absolute", left: "0", top: "0", pointerEvents: "none", zIndex: "2", filter: "drop-shadow(0 1px 2px #0008)" });
  target.parentElement?.append(marker);
  const before = { transform: target.style.transform, transformOrigin: target.style.transformOrigin, touchAction: target.style.touchAction };
  target.style.transformOrigin = "0 0";
  target.style.touchAction = "none";

  const canvas = () => {
    const element = target.querySelector("canvas");
    return element && element.clientWidth > 0 && element.clientHeight > 0 ? element : null;
  };
  /** The untransformed box of `target`: what is on screen, whatever the zoom. */
  const stage = () => {
    const box = target.getBoundingClientRect();
    return { left: box.left - view.x, top: box.top - view.y, width: target.offsetWidth, height: target.offsetHeight };
  };
  const fromScreen = (point: Point) => {
    const element = canvas();
    if (!element) return undefined;
    const box = element.getBoundingClientRect();
    return { x: clamp((point.x - box.left) / box.width, 0, 1), y: clamp((point.y - box.top) / box.height, 0, 1) };
  };
  const toScreen = (fraction: Point) => {
    const element = canvas();
    if (!element) return undefined;
    const box = element.getBoundingClientRect();
    return { x: box.left + fraction.x * box.width, y: box.top + fraction.y * box.height };
  };
  /** The pointer in canvas pixels, which noVNC scales to the desktop. The last pixel is the edge. */
  const canvasPoint = () => {
    const element = canvas();
    if (!element || !at) return undefined;
    return { x: Math.min(at.x * element.clientWidth, element.clientWidth - 1), y: Math.min(at.y * element.clientHeight, element.clientHeight - 1) };
  };
  const move = () => {
    const point = canvasPoint();
    if (point) pointer._handleMouseMove(point.x, point.y);
  };
  /** The held buttons, plus a wheel button for one step. */
  const press = (extra = 0) => {
    const point = canvasPoint();
    if (point) pointer._handleMouseButton(point.x, point.y, mask | extra);
  };
  const center = () => {
    const box = stage();
    return fromScreen({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
  };
  function render() {
    const screen = gestures.trackpad && at ? toScreen(at) : undefined;
    marker.hidden = !screen;
    if (!screen) return;
    const parent = (marker.parentElement ?? document.body).getBoundingClientRect();
    marker.style.transform = `translate(${screen.x - parent.left - 3}px, ${screen.y - parent.top - 2}px)`;
  }
  function setView(scale: number, x: number, y: number) {
    const { width, height } = stage();
    view.scale = clamp(scale, 1, maxZoom);
    view.x = clamp(x, width - width * view.scale, 0);
    view.y = clamp(y, height - height * view.scale, 0);
    target.style.transform = view.scale === 1 ? "" : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    onZoom?.(view.scale > 1);
    render();
  }
  /** Zoomed in, the view follows a trackpad pointer that reaches its edge. */
  function follow() {
    const screen = at && toScreen(at);
    if (!screen || view.scale === 1) return;
    const box = stage(), margin = 24;
    const dx = Math.max(0, box.left + margin - screen.x) - Math.max(0, screen.x - (box.left + box.width - margin));
    const dy = Math.max(0, box.top + margin - screen.y) - Math.max(0, screen.y - (box.top + box.height - margin));
    if (dx || dy) setView(view.scale, view.x + dx, view.y + dy);
  }
  function act(action: TouchAction) {
    switch (action.type) {
      case "point":
        at = fromScreen(action.at) ?? at;
        move();
        break;
      case "nudge": {
        const element = canvas();
        at ??= center();
        if (!element || !at) return;
        const box = element.getBoundingClientRect();
        at = { x: clamp(at.x + action.dx * trackpadGain / box.width, 0, 1), y: clamp(at.y + action.dy * trackpadGain / box.height, 0, 1) };
        move();
        follow();
        render();
        break;
      }
      case "button":
        at ??= center();
        mask = action.down ? mask | buttons[action.button] : mask & ~buttons[action.button];
        press();
        break;
      case "wheel":
        at ??= center();
        press(wheelButtons[action.direction]);
        press();
        break;
      case "view": {
        const box = stage();
        const cx = action.center.x - box.left, cy = action.center.y - box.top;
        const scale = clamp(view.scale * action.scale, 1, maxZoom);
        // Keep the desktop point under the fingers where it is, then follow their travel.
        const x = cx - (cx - view.x) * scale / view.scale + action.dx;
        const y = cy - (cy - view.y) * scale / view.scale + action.dy;
        setView(scale, x, y);
        break;
      }
    }
  }

  const handle = (event: TouchEvent) => {
    // Nothing else sees these touches: not noVNC's gestures, the page's scrolling or Safari's zoom.
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "touchstart" && !rfb.viewOnly) rfb.focus({ preventScroll: true });
    if (event.type === "touchcancel") { gestures.cancel(); return; }
    const now = Date.now();
    const changed = Array.from(event.changedTouches, touch => [touch.identifier, { x: touch.clientX, y: touch.clientY }] as [number, Point]);
    if (event.type === "touchmove") { gestures.move(changed); return; }
    for (const [id, point] of changed) {
      if (event.type === "touchstart") gestures.start(id, point, now);
      else gestures.end(id, now);
    }
  };
  const types = ["touchstart", "touchmove", "touchend", "touchcancel"] as const;
  for (const type of types) target.addEventListener(type, handle, { capture: true, passive: false });
  // A rotation or resize keeps the zoom inside the new box and the pointer on its spot.
  const resized = () => setView(view.scale, view.x, view.y);
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resized);
  observer?.observe(target);

  return {
    setTrackpad(on) {
      if (gestures.trackpad === on) return;
      gestures.cancel();
      gestures.trackpad = on;
      if (on) at ??= center();
      render();
    },
    recenter() {
      at = center() ?? at;
      move();
      render();
    },
    resetZoom() { setView(1, 0, 0); },
    detach() {
      gestures.cancel();
      for (const type of types) target.removeEventListener(type, handle, { capture: true });
      observer?.disconnect();
      marker.remove();
      Object.assign(target.style, before);
    },
  };
}
