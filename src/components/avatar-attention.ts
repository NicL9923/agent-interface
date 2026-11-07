import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Web-only life layered over the shared avatar rig: aware avatars glance toward a mouse pointer
 * or at a sibling that just finished, and any avatar can play a short reaction. None of this
 * touches the conductor or the pose math, which the iOS app mirrors, and Reduce Motion skips it.
 */
export type AvatarReaction = "cheer" | "nod";
type Point = { x: number; y: number };
export type Gaze = Point;

const REACT_EVENT = "wildbots:avatar-react";
const GLANCE_EVENT = "wildbots:avatar-glance";
/** A pointer that has not moved for this long no longer holds an avatar's eye. */
export const POINTER_REST_MS = 4000;
/** How long siblings keep looking at an assistant that just finished. */
export const GLANCE_MS = 1600;
/** Distance in pixels at which a gaze reaches its full turn. */
const REACH = 260;
const still: Gaze = { x: 0, y: 0 };

/** Plays a short reaction on every avatar of one assistant on screen. */
export function reactAvatar(botId: string, kind: AvatarReaction) {
  window.dispatchEvent(new CustomEvent(REACT_EVENT, { detail: { botId, kind } }));
}
/** Asks every aware avatar of another assistant to look at this one for a moment. */
export function glanceAtAvatar(botId: string) {
  window.dispatchEvent(new CustomEvent(GLANCE_EVENT, { detail: { botId } }));
}

/** Where an avatar centered at `center` looks to see `point`: each axis from -1 to 1, weaker up close. */
export function gazeToward(center: Point, point: Point, reach = REACH): Gaze {
  const dx = point.x - center.x, dy = point.y - center.y, distance = Math.hypot(dx, dy);
  if (distance < 1) return still;
  const strength = Math.min(distance / reach, 1);
  return { x: (dx / distance) * strength, y: (dy / distance) * strength * 0.8 };
}

// One pointer listener serves every aware avatar; touch has no hover, so only a mouse or pen counts.
let pointer: (Point & { at: number }) | null = null;
const watchers = new Set<() => void>();
let notifyFrame = 0;
function notify() {
  if (notifyFrame) return;
  notifyFrame = requestAnimationFrame(() => {
    notifyFrame = 0;
    for (const watcher of watchers) watcher();
  });
}
function moved(event: PointerEvent) {
  if (event.pointerType === "touch") return;
  pointer = { x: event.clientX, y: event.clientY, at: performance.now() };
  notify();
}
function left(event: PointerEvent) {
  if (event.relatedTarget) return;
  pointer = null;
  notify();
}
function watchPointer(watcher: () => void) {
  if (!watchers.size) {
    window.addEventListener("pointermove", moved, { passive: true });
    document.addEventListener("pointerout", left);
  }
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
    if (watchers.size) return;
    window.removeEventListener("pointermove", moved);
    document.removeEventListener("pointerout", left);
    cancelAnimationFrame(notifyFrame);
    notifyFrame = 0;
    pointer = null;
  };
}

const centerOf = (element: Element | null | undefined): Point | null => {
  const box = element?.getBoundingClientRect();
  return box && box.width ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
};

/**
 * The gaze an aware avatar adds to its pose. It eases toward the pointer while one moves nearby,
 * toward a sibling that just finished, and back to the front once the pointer rests or leaves.
 */
export function useAvatarAttention(wrapper: RefObject<HTMLElement | null>, botId: string | undefined, enabled: boolean): Gaze {
  const [gaze, setGaze] = useState(still);
  const motion = useRef({ x: 0, y: 0, tx: 0, ty: 0, last: 0, frame: 0 });
  useEffect(() => {
    if (!enabled) return;
    const m = motion.current;
    let glance: (Point & { until: number }) | null = null;
    let rest = 0, glanceEnd = 0;
    const step = (now: number) => {
      m.frame = 0;
      const dt = Math.min((now - m.last) / 1000, 0.05);
      m.last = now;
      const k = 1 - Math.exp(-dt / 0.14);
      m.x += (m.tx - m.x) * k;
      m.y += (m.ty - m.y) * k;
      const settled = Math.abs(m.tx - m.x) < 0.004 && Math.abs(m.ty - m.y) < 0.004;
      if (settled) { m.x = m.tx; m.y = m.ty; }
      setGaze({ x: m.x, y: m.y });
      if (!settled) m.frame = requestAnimationFrame(step);
    };
    const retarget = () => {
      const now = performance.now(), center = centerOf(wrapper.current);
      const point = !center ? null : glance && glance.until > now ? glance : pointer && now - pointer.at < POINTER_REST_MS ? pointer : null;
      const target = center && point ? gazeToward(center, point) : still;
      m.tx = target.x;
      m.ty = target.y;
      if (!m.frame && (Math.abs(m.tx - m.x) > 0.004 || Math.abs(m.ty - m.y) > 0.004)) {
        m.last = now;
        m.frame = requestAnimationFrame(step);
      }
    };
    const pointed = () => {
      retarget();
      clearTimeout(rest);
      rest = window.setTimeout(retarget, POINTER_REST_MS + 50);
    };
    const glanced = (event: Event) => {
      const source = (event as CustomEvent<{ botId?: string }>).detail?.botId;
      if (!source || source === botId) return;
      const center = centerOf(document.querySelector(`[data-glance-target="${CSS.escape(source)}"]`));
      if (!center) return;
      glance = { ...center, until: performance.now() + GLANCE_MS };
      retarget();
      clearTimeout(glanceEnd);
      glanceEnd = window.setTimeout(retarget, GLANCE_MS + 20);
    };
    const unwatch = watchPointer(pointed);
    window.addEventListener(GLANCE_EVENT, glanced);
    return () => {
      unwatch();
      window.removeEventListener(GLANCE_EVENT, glanced);
      clearTimeout(rest);
      clearTimeout(glanceEnd);
      cancelAnimationFrame(m.frame);
      Object.assign(m, { x: 0, y: 0, tx: 0, ty: 0, frame: 0 });
      setGaze(still);
    };
  }, [enabled, botId, wrapper]);
  return enabled ? gaze : still;
}

/** A hop with a squash on landing, as a fraction of the avatar's own size. */
export const cheerFrames: Keyframe[] = [
  { transform: "translateY(0) scale(1, 1)" },
  { transform: "translateY(4%) scale(1.07, 0.9)", offset: 0.12 },
  { transform: "translateY(-24%) scale(0.95, 1.06)", offset: 0.42 },
  { transform: "translateY(0) scale(1.06, 0.93)", offset: 0.68 },
  { transform: "translateY(-5%) scale(1, 1)", offset: 0.84 },
  { transform: "translateY(0) scale(1, 1)" },
];
/** A small acknowledging dip. */
export const nodFrames: Keyframe[] = [
  { transform: "translateY(0) rotate(0deg)" },
  { transform: "translateY(7%) rotate(-3deg)", offset: 0.38 },
  { transform: "translateY(0) rotate(0deg)" },
];

/**
 * Plays reactions sent to this assistant on the avatar's wrapper. Returns a key that changes on
 * each cheer, so the avatar can draw a fresh burst of sparks.
 */
export function useAvatarReactions(wrapper: RefObject<HTMLElement | null>, botId: string | undefined, enabled: boolean) {
  const [burst, setBurst] = useState(0);
  useEffect(() => {
    if (!enabled || !botId) return;
    const reacted = (event: Event) => {
      const detail = (event as CustomEvent<{ botId?: string; kind?: AvatarReaction }>).detail;
      const element = wrapper.current;
      if (detail?.botId !== botId || !element?.isConnected) return;
      const cheer = detail.kind === "cheer";
      element.animate?.(cheer ? cheerFrames : nodFrames, { duration: cheer ? 760 : 520, easing: "ease-out" });
      if (cheer) setBurst(count => count + 1);
    };
    window.addEventListener(REACT_EVENT, reacted);
    return () => window.removeEventListener(REACT_EVENT, reacted);
  }, [enabled, botId, wrapper]);
  return burst;
}

/** Turns a pose's eyes and head toward an attention gaze, in proportion to how strongly it pulls. */
export function withGaze<P extends { gazeX: number; gazeY: number; yaw: number }>(pose: P, gaze: Gaze): P {
  const pull = Math.min(Math.hypot(gaze.x, gaze.y), 1);
  if (pull < 0.001) return pose;
  return {
    ...pose,
    gazeX: pose.gazeX + (gaze.x * 0.95 - pose.gazeX) * pull,
    gazeY: pose.gazeY + (gaze.y * 0.9 - pose.gazeY) * pull,
    yaw: pose.yaw + gaze.x * 0.14,
  };
}
