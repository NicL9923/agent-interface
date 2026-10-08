import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ActivityState, Avatar as AvatarConfig } from "../shared/types";
import {
  animatesAt,
  approach,
  avatarPose,
  expressionFor,
  faceInk,
  frozenStates,
  orbitArcs,
  project,
  propMotion,
  smoothstep,
  tint,
  type AvatarProp,
  type Expression,
} from "./avatar-motion";
import "./avatar.css";
import { isSeasonal, seasonalAnchors, seasonalHeads, SeasonalBack, SeasonalFace, SeasonalFront } from "./seasonal-avatars";

export const avatarStates: ActivityState[] = [
  "idle",
  "thinking",
  "working",
  "waiting",
  "blocked",
  "done",
  "disconnected",
  "failed",
  "interrupted",
];
export const stateLabels: Record<ActivityState, string> = {
  idle: "Ready",
  thinking: "Thinking",
  working: "Working",
  waiting: "Waiting",
  blocked: "Needs your help",
  done: "Done",
  disconnected: "Connection lost",
  failed: "Failed",
  interrupted: "Interrupted",
};
export const avatarColors = [
  "#1084FE",
  "#FF6700",
  "#00BCA6",
  "#FF263C",
  "#FF309B",
  "#9159FE",
  "#FF9800",
  "#97683D",
  "#292929",
];
export const defaultAvatar: Extract<AvatarConfig, { mode: "geometric" }> = {
  mode: "geometric",
  shape: "blob",
  color: "#1084FE",
  eyes: "oval",
  accessory: "none",
};

const mascotHead =
  "M50 14 C77 14 95 32 95 56 C95 81 76 95 50 95 C24 95 5 81 5 56 C5 32 23 14 50 14Z";
/**
 * One closed outline per shape in a 0-100 box. AvatarView.swift repeats these strings and
 * reads only absolute M L H V Q C Z; the circle's arc is its one cubic rewrite.
 */
export function silhouette(shape: string) {
  switch (shape) {
    case "mascot":
      return mascotHead;
    case "drop":
      return "M50 7 C42 16 13 42 13 64 C13 87 29 95 50 95 C71 95 87 82 87 62 C87 39 61 17 50 7Z";
    case "triangle":
      return "M43 12 Q50 0 57 12 L95 78 Q103 94 85 94 H15 Q-3 94 5 78Z";
    case "cloud":
      return "M20 40 C15 15 46 7 58 25 C78 9 104 29 91 50 C109 71 90 99 68 89 C48 108 19 95 23 79 C-1 72 0 46 20 40Z";
    case "capsule":
      return "M48 5 H52 C75 5 84 18 84 40 V61 C84 83 73 96 52 96 H48 C26 96 16 84 16 61 V40 C16 18 26 5 48 5Z";
    case "pebble":
      return "M22 9 C48 -4 86 7 94 32 C105 60 90 90 69 96 C36 105 2 88 4 63 C1 38 7 21 22 9Z";
    case "squircle":
      return "M25 5 H75 Q95 5 95 25 V75 Q95 95 75 95 H25 Q5 95 5 75 V25 Q5 5 25 5Z";
    case "hex":
      return "M28 8 Q32 5 37 5 H64 Q70 5 73 10 L95 43 Q99 50 95 57 L73 90 Q70 95 64 95 H36 Q30 95 27 90 L5 57 Q1 50 5 43Z";
    case "diamond":
      return "M50 5.1 C56.3 5.1 60 9.6 64.1 13.7 C71.8 21.4 79.5 29.1 87.1 36.7 C91 40.6 95 44.1 95 50 C95 56.3 90.4 60 86.3 64.1 C78.5 71.8 70.8 79.6 63.1 87.3 C59.3 91.1 55.8 94.9 50 94.9 C43.7 94.9 40 90.3 35.9 86.2 C28.2 78.5 20.4 70.8 12.7 63.1 C8.9 59.3 5 55.8 5 50 C5 43.7 9.6 40 13.7 35.8 C21.4 28.1 29.2 20.4 36.9 12.7 C40.7 8.9 44.2 5.1 50 5.1Z";
    case "sparkle":
      return "M50 4.1 C58.3 4.1 61.2 11.9 65.5 17.6 C72.2 26.5 80.6 33.7 90 39.6 C93.6 41.9 95.9 45.6 95.9 50 C95.9 54.3 93.7 58 90.1 60.3 C80.7 66.3 72.4 73.3 65.6 82.2 C61.2 88 58.4 96 49.9 95.9 C45.7 95.9 41.9 93.7 39.7 90.1 C33.7 80.6 26.5 72.3 17.5 65.5 C11.9 61.2 4.1 58.4 4.1 50.1 C4 41.7 11.9 38.9 17.6 34.5 C26.6 27.7 33.7 19.4 39.7 9.9 C42 6.3 45.7 4.1 50 4.1Z";
    case "clover":
      return "M50 4 C58.7 4 66.8 9.1 70.6 16.9 C71.8 19.3 72.4 24.5 73.9 26 C75.5 27.6 80.6 28.1 83 29.3 C90.9 33.1 96 41.2 96 49.9 C96 58.4 91.2 66.5 83.6 70.4 C81.2 71.7 75.2 72.6 73.9 74 C72.6 75.4 71.6 81.2 70.4 83.6 C66.6 91.1 58.6 96 50.2 96 C41.4 96 33.3 91 29.4 83.2 C28.2 80.8 27.6 75.5 26 73.9 C24.4 72.4 19.4 71.9 17.1 70.7 C9.1 66.9 4 58.7 4 50 C4 41.5 8.9 33.4 16.5 29.5 C18.9 28.3 24.7 27.4 26.1 26 C27.4 24.7 28.3 18.9 29.5 16.5 C33.4 8.9 41.5 4 50 4Z";
    case "heart":
      return "M50 17.2 C53.1 17.2 57.3 13.3 60.6 12 C69.7 8.5 80.4 10.8 87.4 17.7 C89.5 19.7 91.2 22.2 92.5 24.8 C96.4 32.8 95.7 42.6 90.7 50 C88.4 53.4 85.4 56.2 82.6 59.2 C78.3 63.9 74 68.6 69.7 73.3 C66.4 76.8 59.3 85.7 55.8 87.9 C54.1 89 52.1 89.6 50 89.6 C47.9 89.6 45.8 89 44 87.8 C40.6 85.5 33.6 76.9 30.4 73.4 C26 68.7 21.7 63.9 17.4 59.2 C14.7 56.3 11.6 53.4 9.4 50.1 C4.3 42.7 3.7 32.9 7.5 24.9 C8.7 22.2 10.5 19.8 12.6 17.7 C19.5 10.9 30 8.6 39.2 11.9 C42.4 13.1 47.1 17.2 50 17.2Z";
    case "cookie":
      return "M50 5.5 C53.6 5.4 57.2 7 59.8 9.6 C61 10.8 61.8 13.2 63.4 13.8 C65.2 14.5 67.4 13.1 69.2 13 C72.8 12.6 76.5 13.8 79.3 16.1 C82.1 18.5 83.8 22 84.1 25.6 C84.2 27.3 83.3 29.7 84.2 31.3 C85.1 32.8 87.5 33.1 89 34.1 C92 36.1 94.1 39.4 94.8 43 C95.5 46.6 94.6 50.5 92.4 53.5 C91.3 54.9 89.2 56 88.9 57.8 C88.6 59.6 90.3 61.6 90.8 63.4 C91.7 66.9 91.2 70.6 89.4 73.7 C87.6 76.8 84.6 79.1 81.1 80.1 C79.4 80.5 76.8 80 75.4 81.2 C74 82.3 74 85 73.3 86.6 C71.8 89.9 68.9 92.5 65.5 93.7 C62 95 58.2 94.7 54.9 93.1 C53.3 92.4 51.8 90.5 50 90.4 C48.2 90.4 46.7 92.4 45.1 93.1 C41.9 94.7 38 95 34.6 93.8 C31 92.5 28.1 89.8 26.6 86.4 C25.9 84.8 26 82.4 24.7 81.2 C23.3 80 20.6 80.5 18.9 80.1 C15.4 79.2 12.4 76.8 10.6 73.8 C8.8 70.6 8.3 66.8 9.3 63.2 C9.7 61.5 11.4 59.6 11.1 57.8 C10.8 56.1 8.7 54.9 7.7 53.6 C5.4 50.6 4.5 46.7 5.2 43 C5.9 39.4 8 36.2 11 34.1 C12.5 33.1 15.1 32.7 15.9 31.1 C16.7 29.6 15.8 27.3 15.9 25.7 C16.2 22 17.9 18.5 20.7 16.2 C23.5 13.8 27.1 12.6 30.8 13 C32.6 13.1 34.8 14.5 36.5 13.9 C38.2 13.2 39 10.8 40.2 9.6 C42.7 7 46.3 5.5 50 5.5Z";
    case "pentagon":
      return "M50 7.6 C54.9 7.6 58.4 11 62.2 13.7 C69.6 19 76.9 24.4 84.3 29.8 C87.9 32.4 91.9 34.7 93.4 39.1 C94.9 43.6 92.9 47.9 91.5 52.1 C88.8 60.5 86.1 69 83.3 77.4 C81.9 81.7 81.1 86.5 77.6 89.5 C73.9 92.8 69.2 92.4 64.5 92.4 C55.1 92.4 45.7 92.4 36.3 92.4 C31.4 92.4 26.4 93 22.4 89.6 C19 86.6 18.1 81.8 16.8 77.7 C14 69.2 11.3 60.7 8.5 52.1 C7.1 47.9 5.1 43.6 6.6 39.1 C8.1 34.6 12.2 32.3 15.8 29.7 C23.3 24.3 30.7 18.8 38.1 13.5 C41.8 10.8 45.2 7.6 50 7.6Z";
    case "burst":
      return "M50 5.1 C53.8 5 63 14.3 67.1 16.3 C71.4 18.6 83.7 19.5 86.5 22.5 C88.7 24.8 88 29.4 88.1 32.3 C88.2 35.5 87.9 41 88.8 43.8 C90.1 47.8 96.6 59.1 95.9 62.5 C95.2 65.6 91 68 88.8 69.9 C81.2 76.5 81.8 75.1 77 84 C75.6 86.8 73.2 93.2 70.4 94.5 C66.7 96.2 54.7 91.6 49.9 91.7 C45.3 91.8 33.2 96.1 29.7 94.5 C26.9 93.2 24.4 86.8 23 84 C18.1 74.9 18.8 76.5 11.1 69.8 C8.9 67.9 4.8 65.6 4.2 62.6 C3.3 59 9.8 47.9 11.2 43.9 C12.1 41.1 11.8 35.5 11.9 32.4 C12 29.4 11.3 24.9 13.5 22.5 C16.2 19.5 28.6 18.5 32.9 16.4 C37.1 14.3 46 5.1 50 5.1Z";
    case "alien":
      return "M50 6 C66.4 6 85.1 13.5 91.8 29.5 C94.1 34.8 94.6 40.7 93.2 46.3 C90.7 56.9 80.7 65.3 73.5 73.1 C69.1 78 64.7 82.8 60.2 87.6 C57.3 90.8 54.7 94 50 94 C45.3 94 42.6 90.7 39.6 87.5 C35.2 82.7 30.8 77.8 26.3 73 C19.1 65.1 9.1 56.6 6.7 45.9 C5.4 40.5 6 34.9 8.1 29.7 C14.6 13.6 33.6 6 50 6Z";
    case "ghost":
      return "M50 5 C67.9 5 84.2 17.1 89.2 34.3 C91.5 42 90.9 50.2 90.9 58.1 C90.9 65.6 90.9 73.1 90.9 80.6 C90.9 85.4 90.9 90 86.7 93 C83.4 95.4 78.8 95.6 75.4 93.5 C73.9 92.6 72.9 90.9 71.1 90.6 C68.1 90 65.6 95 60.3 95 C55 95 52.8 90.4 49.9 90.5 C47.1 90.6 45 95 39.8 95 C34.6 95 31.9 90.1 29 90.5 C27.1 90.8 26 92.7 24.5 93.6 C20.9 95.7 16.2 95.4 13 92.8 C9 89.6 9.1 85.1 9.1 80.4 C9.1 73 9.1 65.6 9.1 58.2 C9.1 50.2 8.5 42.1 10.8 34.4 C15.8 17.2 32.1 5 50 5Z";
    case "flower":
      return "M50 5.4 C57.2 5.4 63.9 9.6 66.9 16.1 C68.1 18.5 68.2 23.4 70.3 24.9 C72.4 26.4 76.6 25 79.2 25.2 C86.5 26 92.8 31.1 95 38 C97.3 44.9 95.3 52.7 90 57.6 C88 59.5 83.6 61 82.8 63.4 C82 66.2 84.6 69.4 85.2 72 C86.7 79.1 83.8 86.8 77.9 91 C72 95.3 64 95.8 57.7 92.3 C55.3 90.9 52.6 87.3 50 87.3 C47.4 87.3 44.5 91.1 42.1 92.4 C35.8 95.8 27.8 95.2 22 91 C16.2 86.7 13.4 79.3 14.8 72.2 C15.3 69.6 18 65.9 17.2 63.4 C16.4 60.9 12.1 59.6 10.2 57.8 C4.7 52.8 2.6 45 5 38 C7.3 31.1 13.4 26.1 20.6 25.3 C23.2 24.9 27.6 26.4 29.7 24.8 C31.8 23.3 31.9 18.5 33.1 16 C36.2 9.6 42.9 5.4 50 5.4Z";
    case "sun":
      return "M50 4 C57.3 4 53.4 17 57.8 19 C59.3 19.6 60.9 19.9 62.4 20.6 C63.9 21.2 65.3 22.2 66.8 22.7 C67.2 22.8 67.7 22.8 68.2 22.7 C72.3 21.7 77.9 13.1 82.5 17.4 C87.9 22.7 75.5 28.9 77.5 33.7 C78.2 35.3 79.1 36.7 79.7 38.3 C80.3 39.6 80.5 41.2 81.1 42.5 C81.4 42.9 81.7 43.3 82.1 43.5 C85.7 45.8 95.8 43.6 96 49.9 C96.2 57.5 82.9 53.1 81 57.9 C80.4 59.3 80.1 60.9 79.5 62.3 C78.9 63.8 77.8 65.2 77.4 66.7 C77.2 67.1 77.2 67.6 77.3 68 C78.1 72.3 87.1 78 82.5 82.5 C77.2 87.7 71.1 75.6 66.4 77.5 C65 78 63.8 78.9 62.4 79.4 C60.9 80.1 58.9 80.3 57.4 81.2 C57 81.4 56.7 81.8 56.4 82.2 C54.3 85.9 56.3 96 50 96 C42.7 96 46.6 83 42.2 81 C40.7 80.4 39.1 80.1 37.6 79.4 C36.1 78.8 34.7 77.8 33.2 77.3 C32.8 77.2 32.3 77.2 31.8 77.3 C27.7 78.3 22.1 86.9 17.5 82.6 C12.9 78.1 21.8 72.3 22.7 68.1 C22.8 67.6 22.8 67.2 22.7 66.7 C22.2 65.2 21.1 63.8 20.5 62.3 C19.9 60.9 19.6 59.2 19 57.7 C16.9 53.2 3.8 57.4 4 49.9 C4.2 43.6 14.2 45.8 17.9 43.5 C18.3 43.3 18.6 42.9 18.8 42.5 C19.6 41.2 19.8 39.5 20.3 38.1 C21 36.6 21.9 35.1 22.6 33.5 C24.3 29.1 12.3 22.6 17.5 17.5 C22.8 12.3 28.9 24.4 33.6 22.5 C35 22 36.2 21.1 37.6 20.6 C39.1 19.9 41.1 19.7 42.6 18.8 C43 18.6 43.3 18.2 43.6 17.8 C45.7 14.1 43.7 4 50 4Z";
    case "circle":
      return "M50 3 A47 47 0 1 1 49.99 3Z";
    default:
      return "M50 3 C77 1 99 24 98 51 C100 77 79 99 51 98 C23 99 2 80 2 51 C2 25 21 3 50 3Z";
  }
}
/**
 * Where each silhouette's face sits. Eyes follow the visual center of mass, so
 * a triangle or drop looks out from its wide base instead of its point.
 */
export const faces: Record<string, { cy: number; scale: number; top: number; hat: number }> = {
  blob: { cy: 50, scale: 1, top: 3, hat: 1 },
  pebble: { cy: 50, scale: 1, top: 2, hat: 1 },
  squircle: { cy: 50, scale: 1, top: 5, hat: 1 },
  capsule: { cy: 47, scale: 0.9, top: 5, hat: 0.85 },
  triangle: { cy: 65, scale: 0.82, top: 3, hat: 0.6 },
  hex: { cy: 50, scale: 0.95, top: 5, hat: 0.95 },
  cloud: { cy: 55, scale: 0.95, top: 12, hat: 0.9 },
  drop: { cy: 63, scale: 0.9, top: 8, hat: 0.62 },
  circle: { cy: 50, scale: 1, top: 3, hat: 1 },
  diamond: { cy: 50, scale: 0.88, top: 7, hat: 0.7 },
  sparkle: { cy: 50, scale: 0.8, top: 6, hat: 0.6 },
  clover: { cy: 50, scale: 0.95, top: 5, hat: 0.75 },
  heart: { cy: 48, scale: 0.95, top: 12, hat: 0.75 },
  cookie: { cy: 50, scale: 0.95, top: 6, hat: 0.95 },
  pentagon: { cy: 54, scale: 0.92, top: 7, hat: 0.7 },
  burst: { cy: 51, scale: 0.9, top: 6, hat: 0.75 },
  alien: { cy: 42, scale: 1, top: 6, hat: 1 },
  ghost: { cy: 45, scale: 0.95, top: 5, hat: 0.95 },
  flower: { cy: 51, scale: 0.85, top: 8, hat: 0.75 },
  sun: { cy: 50, scale: 0.8, top: 18, hat: 0.75 },
  mascot: { cy: 55, scale: 1, top: 15, hat: 0.82 },
};
const trailColors = ["#ff729d", "#85bcfb", "#b790fc", "#92d899"];
const trailOrbits = [
  [58, 13, -0.24],
  [56, 16, 0.16],
  [60, 11, 0.38],
  [54, 18, -0.48],
] as const;

function useReducedMotion(force?: boolean) {
  const [system, setSystem] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystem(q.matches);
    q.addEventListener("change", update);
    return () => q.removeEventListener("change", update);
  }, []);
  return system || !!force;
}

function sampledPath(path: string) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "path");
  node.setAttribute("d", path);
  const length = node.getTotalLength();
  return Array.from({ length: 72 }, (_, i) => {
    const p = node.getPointAtLength((length * i) / 72);
    return [p.x, p.y];
  });
}
function useShapeTransition(desired: string, reduce: boolean) {
  const points = useRef<number[][] | null>(null);
  if (!points.current) points.current = sampledPath(desired);
  const [path, setPath] = useState(desired);
  useEffect(() => {
    const target = sampledPath(desired);
    if (reduce) {
      points.current = target;
      setPath(desired);
      return;
    }
    const from = points.current!;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min((now - start) / 280, 1);
      const ease = t * t * (3 - 2 * t);
      points.current = target.map((p, i) =>
        p.map((v, j) => from[i][j] + (v - from[i][j]) * ease),
      );
      setPath("M" + points.current.map((p) => p.join(" ")).join(" L") + "Z");
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [desired, reduce]);
  return path;
}

/** Trails from the current pose, or residual trails still sweeping after a change. */
function trailsAt(pose: { trails: number; sweep: number }, t: number, carry: number, carrySweep: number) {
  const residual = carry * (1 - smoothstep(t / 0.6));
  return pose.trails >= residual
    ? { level: pose.trails, sweep: pose.sweep }
    : { level: residual, sweep: carrySweep + t * 7 };
}

const morphTargets = (state: ActivityState) => ({
  bang: state === "blocked" ? 1 : 0,
});

export function Avatar({
  avatar = defaultAvatar,
  state = "idle",
  size = 48,
  name = "Assistant",
  reducedMotion = false,
  showState = false,
  prop,
}: {
  avatar?: AvatarConfig;
  state?: ActivityState;
  size?: number;
  name?: string;
  reducedMotion?: boolean;
  showState?: boolean;
  /** A tool to hold while working, such as a magnifying glass during a search. */
  prop?: AvatarProp;
}) {
  const wrapper = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (!wrapper.current) return;
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting),
    );
    observer.observe(wrapper.current);
    return () => observer.disconnect();
  }, []);
  const reduce = useReducedMotion(reducedMotion);
  const id = useId().replace(/:/g, "");
  const [, setFrame] = useState(0);
  // Mutable animation clock. Only commit-phase effects and frame callbacks write
  // it, so an interrupted or replayed render never disturbs the running motion.
  const motion = useRef({
    state,
    since: performance.now(),
    elapsed: 0,
    level: 0,
    sweep: 0,
    carry: 0,
    carrySweep: 0,
    now: performance.now(),
    prop,
    propSince: performance.now(),
  });
  const expression = useRef<Expression>(expressionFor(state, 0));
  const morph = useRef(morphTargets(state));
  const still = reduce || !visible || avatar.mode === "portrait" || frozenStates.includes(state);
  useLayoutEffect(() => {
    if (motion.current.prop === prop) return;
    motion.current = { ...motion.current, prop, propSince: performance.now() };
  }, [prop]);
  useLayoutEffect(() => {
    const clock = motion.current;
    if (clock.state === state) return;
    // Keep residual trails sweeping while the next state settles in.
    motion.current = {
      ...clock,
      state,
      since: performance.now(),
      elapsed: 0,
      carry: clock.level,
      carrySweep: clock.sweep,
    };
  }, [state]);
  useEffect(() => {
    if (still) {
      expression.current = expressionFor(state, Infinity);
      morph.current = morphTargets(state);
      motion.current = { ...motion.current, elapsed: 0, level: 0, sweep: 0, carry: 0, carrySweep: 0 };
      setFrame((f) => f + 1);
      return;
    }
    let frame = 0;
    let last = performance.now();
    let painted = 0;
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const clock = motion.current;
      const t = (now - clock.since) / 1000;
      const trail = trailsAt(avatarPose(state, t, false, clock.prop), t, clock.carry, clock.carrySweep);
      motion.current = { ...clock, elapsed: t, now, ...trail };
      expression.current = approach(expression.current, expressionFor(state, t), dt);
      const targets = morphTargets(state);
      const k = 1 - Math.exp(-dt / 0.13);
      morph.current = {
        bang: morph.current.bang + (targets.bang - morph.current.bang) * k,
      };
      const settling = Math.abs(targets.bang - morph.current.bang) > 0.002 || t < 0.7;
      // Small sidebar avatars repaint at about 30 fps to spare battery.
      if (size >= 56 || now - painted > 32) {
        painted = now;
        setFrame((f) => f + 1);
      }
      if (animatesAt(state, t) || settling) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state, still, size]);

  // A state that has not committed yet renders from its first frame.
  const clock = motion.current;
  const fresh = clock.state !== state;
  const t = still || fresh ? 0 : clock.elapsed;
  const held = state === "working" && avatar.mode !== "portrait" ? prop : undefined;
  const pose = avatarPose(state, t, still, held);
  const { level: trailLevel, sweep } = still
    ? { level: 0, sweep: 0 }
    : fresh
      ? trailsAt(pose, 0, clock.level, clock.sweep)
      : trailsAt(pose, t, clock.carry, clock.carrySweep);
  const face = expression.current;
  const { bang } = morph.current;
  const symbolic = bang;

  const mascot = avatar.mode === "mascot" ? avatar : null;
  const seasonal = mascot && isSeasonal(mascot.family) ? mascot.family : null;
  const color = avatar.mode === "portrait" ? "#1084FE" : avatar.color;
  const eyes = avatar.mode === "portrait" ? "oval" : avatar.eyes;
  const accessory = avatar.mode === "portrait" ? "none" : avatar.accessory;
  const geometry = avatar.mode === "geometric" ? avatar.shape : "mascot";
  const anchor = seasonal ? seasonalAnchors[seasonal] : faces[geometry] || faces.blob;
  const bodyPath = useShapeTransition(seasonal ? seasonalHeads[seasonal] : silhouette(geometry), reduce);
  const ink = faceInk(color, !!mascot);
  const eyeScale = anchor.scale;
  const eyeWidth = avatar.mode === "portrait" ? 1 : avatar.eyeWidth ?? 1;
  const eyeHeight = avatar.mode === "portrait" ? 1 : avatar.eyeHeight ?? 1;
  const eyeSpacing = avatar.mode === "portrait" ? 1 : avatar.eyeSpacing ?? 1;
  const eyeY = anchor.cy + pose.gazeY * 3 + (state === "waiting" ? 2 : 0);
  const eyeOffset = (mascot ? 17 : 15) * eyeSpacing * eyeScale;
  const center = project(pose.gazeX * 2, pose.yaw);
  const open = Math.max(face.open * pose.blink * eyeHeight * eyeScale, 0.04);
  const trailArcs = trailLevel > 0.01
    ? trailOrbits.map(([rx, ry, tilt], i) =>
        orbitArcs(-sweep - i * 0.9, 1.5, rx, ry, tilt),
      )
    : [];
  const trailLayer = (part: "back" | "front") =>
    trailLevel > 0.01 && (
      <g fill="none" strokeWidth="3" strokeLinecap="round" opacity={trailLevel * 0.9}>
        {trailArcs.map((arcs, i) =>
          arcs[part].map((d, j) => <path key={`${i}-${j}`} d={d} stroke={trailColors[i]} />),
        )}
      </g>
    );
  const eyeShape = (side: number) => {
    if (mascot && (eyes === "oval" || eyes === "round")) {
      const ry = eyes === "oval" ? 8.5 : 7.5;
      return (
        <>
          <ellipse rx={eyes === "oval" ? 6.5 : 7.5} ry={ry} />
          {ink !== "#fff3db" && (
            <>
              <circle cx={-2 * side} cy={-3.6} r="2.5" fill="#fff" />
              <circle cx={2.4 * side} cy={2.8} r="1.1" fill="#fff" opacity="0.8" />
            </>
          )}
        </>
      );
    }
    if (eyes === "spark")
      return <path d="M0 -10 L3.2 -3.2 L10 0 L3.2 3.2 L0 10 L-3.2 3.2 L-10 0 L-3.2 -3.2Z" />;
    if (eyes === "visor") return <rect x="-10" y="-4.5" width="20" height="9" rx="4.5" />;
    if (eyes === "round") return <circle r="7.5" />;
    return (
      <rect x="-5.5" y="-12.5" width="11" height="25" rx="5.5"
        transform={`rotate(${face.tilt * side})`} />
    );
  };
  const eyesLayer = [-1, 1].map((direction) => {
    const p = project(direction * eyeOffset + pose.gazeX * 4, pose.yaw);
    if (!p.visible) return null;
    const side = -direction;
    return (
      <g key={direction} transform={`translate(${50 + p.x} ${eyeY})`}>
        <g
          opacity={1 - face.happy}
          transform={`scale(${p.scale * eyeWidth * eyeScale * (1 + (1 - Math.min(face.open, 1)) * 0.4)} ${open})`}
        >
          {eyeShape(side)}
        </g>
        {face.happy > 0.01 && (
          <path
            d="M-7 3 Q0 -8 7 3"
            fill="none"
            stroke={ink}
            strokeWidth="4.5"
            strokeLinecap="round"
            opacity={face.happy}
            transform={`scale(${p.scale * eyeWidth * eyeScale} ${eyeScale})`}
          />
        )}
        {accessory === "glasses" && (
          <ellipse
            rx={12.5 * eyeScale * p.scale}
            ry={12.5 * eyeScale}
            fill="none"
            stroke={ink}
            strokeWidth="2.5"
          />
        )}
      </g>
    );
  });
  const glassesBridge = accessory === "glasses" && center.visible && (
    <path
      d={`M${50 + center.x - 4 * center.scale} ${eyeY - 2} Q${50 + center.x} ${eyeY - 5} ${50 + center.x + 4 * center.scale} ${eyeY - 2}`}
      fill="none"
      stroke={ink}
      strokeWidth="2.5"
      strokeLinecap="round"
    />
  );
  const mascotFace = mascot && center.visible && (
    <g transform={`translate(${50 + center.x} 0) scale(${center.scale} 1) translate(-50 0)`}>
      {seasonal ? <SeasonalFace family={seasonal} color={color} ink={ink} mouth={face.mouth} happy={face.happy} /> : <>
      {mascot.family === "bear" && <ellipse cx="50" cy="71" rx="18" ry="13" fill="#fff3db" />}
      {mascot.family === "fox" && (
        <path
          d="M50 60 C43 67 24 65 10 70 C16 86 33 96 50 96 C67 96 84 86 90 70 C76 65 57 67 50 60Z"
          fill="#fff3db"
        />
      )}
      {mascot.family !== "sprout" && (
        <path d="M45.5 66 Q50 63 54.5 66 Q53 70.5 50 71 Q47 70.5 45.5 66Z" fill="#2b201b" />
      )}
      {mascot.family === "sprout" ? (
        <path
          d={`M45 70 Q50 ${70 + 6 * face.mouth} 55 70`}
          fill="none"
          stroke={ink}
          strokeWidth="2.4"
          strokeLinecap="round"
          opacity={1 - face.happy}
        />
      ) : (
        <path
          d={`M50 70.5 V73 M43.5 73 Q46.75 ${73 + 4 * face.mouth} 50 73 Q53.25 ${73 + 4 * face.mouth} 56.5 73`}
          fill="none"
          stroke="#2b201b"
          strokeWidth="2"
          strokeLinecap="round"
          opacity={1 - face.happy}
        />
      )}
      {face.happy > 0.01 && (
        <path
          d={mascot.family === "sprout" ? "M44 69 Q50 79 56 69 Q50 71.5 44 69Z" : "M44 73 Q50 83 56 73 Q50 75.5 44 73Z"}
          fill="#2b201b"
          opacity={face.happy}
        />
      )}
      </>}
    </g>
  );
  const cheeks = mascot && seasonal !== "pumpkin" && [-1, 1].map((direction) => {
    const p = project(direction * 27, pose.yaw);
    return p.visible ? (
      <ellipse key={direction} cx={50 + p.x} cy={anchor.cy + 12} rx={6 * p.scale} ry="3.8"
        fill="#ff7a8a" opacity="0.42" />
    ) : null;
  });
  const ears = mascot && (() => {
    const inner = mascot.family === "fox" ? tint(color, -0.35) : tint(color, 0.45);
    return [-1, 1].map((direction) => {
      const p = project(direction * 31, pose.yaw, 44);
      const flip = direction < 0 ? 1 : -1;
      const transform = `translate(${50 + p.x} 0) scale(${Math.max(Math.abs(Math.cos(pose.yaw)), 0.35) * flip} 1)`;
      if (mascot.family === "bear")
        return (
          <g key={direction} transform={transform}>
            <circle cx="0" cy="24" r="15" fill={color} />
            <circle cx="0" cy="25" r="8" fill={inner} />
          </g>
        );
      if (mascot.family === "fox")
        return (
          <g key={direction} transform={transform}>
            <path d="M-19 42 L-14 5 Q-12 -1 -7.5 3 L14 23Z" fill={color} />
            <path d="M-13 31 L-10.5 11 L3 23Z" fill={inner} />
          </g>
        );
      return null;
    });
  })();
  const sprout = mascot?.family === "sprout" && (
    <g transform={`translate(${project(0, pose.yaw).x * 0.3} 0)`}>
      <path d="M50 18 Q48.5 10 51 3" fill="none" stroke="#3f7f55" strokeWidth="3" strokeLinecap="round" />
      <path d="M50 10 C41 -1 27 1 24 7 C33 14 44 15 50 10Z" fill="#4f9d69" />
      <path d="M51 7 C58 -4 73 -4 77 2 C69 9 58 11 51 7Z" fill="#62b07a" />
      <path d="M47 9.5 Q37 6 29 7 M54 6.5 Q63 2.5 72 2.5" fill="none" stroke="#a9d9b3" strokeWidth="1.2" strokeLinecap="round" />
    </g>
  );
  // A smaller extra hat leaves the seasonal character's ears, cap and antlers visible.
  const hatAnchor = seasonal === "santa" ? { top: -3, hat: 0.45 }
    : seasonal === "rudolph" ? { top: 24, hat: 0.45 }
      : seasonal === "bunny" ? { top: 31, hat: 0.4 } : anchor;
  const hat = accessory === "hat" && (
    <g transform={`translate(50 ${hatAnchor.top + 15 * hatAnchor.hat}) scale(${hatAnchor.hat})`}>
      <path d="M-20 -2 Q-21 -20 -10 -21 Q0 -16 10 -21 Q21 -20 20 -2Z" fill="#3a2f28" />
      <path d="M-20.3 -7 Q0 -3 20.3 -7 L20 -2 Q0 2 -20 -2Z" fill="#b48156" />
      <path d="M-37 -4 Q-34 5 0 5 Q34 5 37 -4 Q38 -8 33 -6 Q0 2 -33 -6 Q-38 -8 -37 -4Z" fill="#302925" />
    </g>
  );
  // A held prop pops in when Hermes starts a new kind of tool.
  const propAge = still ? 1 : clock.prop !== prop ? 0 : (clock.now - clock.propSince) / 1000;
  const heldProp = held && (
    <g className="avatar-prop" data-prop={held} opacity={smoothstep(propAge / 0.2)}>
      <PropArt prop={held} t={t} grow={popIn(propAge / 0.4)} />
    </g>
  );
  const bodyScale = 1 - 0.45 * symbolic;
  const bodyTransform = [
    `translate(${pose.shiftX} ${pose.lift})`,
    `rotate(${pose.roll} 50 60)`,
    `translate(50 94) scale(${pose.scaleX * (1 - 0.3 * bang)} ${pose.scaleY}) translate(-50 -94)`,
    `translate(50 50) scale(${bodyScale}) translate(-50 -50)`,
  ].join(" ");
  const badge = avatar.mode === "portrait"
    ? state !== "idle" && state !== "thinking" && state !== "working"
    : ["disconnected", "failed", "interrupted", "done"].includes(state);
  return (
    <span
      ref={wrapper}
      className={`avatar-wrap avatar-${avatar.mode}`}
      style={{ width: size, height: size, ["--avatar-size" as string]: `${size}px` }}
      data-state={state}
      data-family={mascot?.family}
      data-reduced-motion={reduce}
      role="img"
      aria-label={`${name}: ${stateLabels[state]}`}
    >
      {avatar.mode === "portrait" ? (
        <>
          <span className="avatar-ring" aria-hidden="true" />
          <img
            className="avatar-portrait"
            src={avatar.src || undefined}
            alt=""
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        </>
      ) : (
        <svg viewBox="-8 -8 116 116" aria-hidden="true" className="avatar-svg">
          <defs>
            <clipPath id={`face-${id}`}>
              <path d={bodyPath} />
            </clipPath>
          </defs>
          <g opacity={1 - smoothstep(symbolic)} transform={bodyTransform}>
            {trailLayer("back")}
            {ears}
            {sprout}
            {seasonal && <SeasonalBack family={seasonal} color={color} yaw={pose.yaw} />}
            <path d={bodyPath} fill={color} className="avatar-body" />
            <g clipPath={`url(#face-${id})`}>
              {mascotFace}
              {cheeks}
              <g fill={ink}>{eyesLayer}</g>
              {glassesBridge}
            </g>
            {seasonal && <SeasonalFront family={seasonal} yaw={pose.yaw} />}
            {hat}
            {trailLayer("front")}
          </g>
          {heldProp}
          <g fill={color}>
            {bang > 0.01 && (
              <g opacity={smoothstep(bang)}
                transform={`translate(50 50) rotate(${pose.symbolTilt} 0 30) scale(${0.4 + 0.6 * bang}) translate(-50 -50)`}>
                <path d="M42.5 21 Q50 12 57.5 21 L54.5 61 Q50 68 45.5 61Z" />
                <circle cx="50" cy="79" r="7.5" />
              </g>
            )}
          </g>
        </svg>
      )}
      {badge && (
        <span className="avatar-badge" aria-hidden="true" key={state}>
          <StateGlyph state={state} />
        </span>
      )}
      {showState && (
        <span className="avatar-caption">{stateLabels[state]}</span>
      )}
    </span>
  );
}

const popIn = (t: number) => {
  const x = Math.min(Math.max(t, 0), 1);
  return 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
};

/** Small held props, drawn in avatar units in front of the body. */
function PropArt({ prop, t, grow }: { prop: AvatarProp; t: number; grow: number }) {
  const { x, y, rotate } = propMotion(prop, t);
  const outline = { stroke: "#2b201b", strokeWidth: 2.2, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  const art = prop === "search" ? <>
    <path d="M8 8 L19 19" {...outline} strokeWidth={6.5} />
    <path d="M8 8 L19 19" stroke="#b07a4a" strokeWidth={3.6} strokeLinecap="round" />
    <circle r="11" fill="#d9f2ff" fillOpacity="0.55" {...outline} strokeWidth={3.4} />
    <path d="M-6 -3 Q-5 -6 -2 -7" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" opacity="0.9" />
  </> : prop === "computer" ? <>
    <rect x="-21" y="-23" width="42" height="27" rx="4" fill="#cfd5dc" {...outline} />
    <circle cy="-10" r="3" fill="#9aa4ae" />
    <path d="M-27 4 H27 L24 10 H-24Z" fill="#aab3bc" {...outline} />
    <circle cx="16" cy="7" r="1.1" fill="#7bd88f" opacity={0.5 + 0.5 * Math.sin(t * 5)} />
  </> : prop === "read" ? <>
    <path d="M0 -10 Q-12 -15 -24 -11 V7 Q-12 3 0 8Z" fill="#fff8ec" {...outline} />
    <path d="M0 -10 Q12 -15 24 -11 V7 Q12 3 0 8Z" fill="#fff8ec" {...outline} />
    <path d="M-19 -6 Q-11 -9 -4 -6 M-19 -1 Q-11 -4 -4 -1 M4 -6 Q11 -9 19 -6 M4 -1 Q11 -4 19 -1" fill="none" stroke="#b9ab96" strokeWidth={1.4} strokeLinecap="round" />
    <path d="M-25 8 Q-12 4 0 9 Q12 4 25 8" fill="none" stroke="#c0503a" strokeWidth={3} strokeLinecap="round" />
  </> : <>
    <g transform="rotate(-8 0 12)">
      <rect x="-15" y="2" width="26" height="20" rx="2.5" fill="#fff8ec" {...outline} />
      <path d={`M-10 9 H${-10 + 16 * ((t * 0.5) % 1)} M-10 15 H2`} fill="none" stroke="#9db7d6" strokeWidth={1.6} strokeLinecap="round" />
    </g>
    <g transform="rotate(38)">
      <rect x="-3.2" y="-22" width="6.4" height="22" rx="1.2" fill="#ffc94a" {...outline} />
      <path d="M-3.2 -22 H3.2 V-25.5 Q3.2 -27 0 -27 Q-3.2 -27 -3.2 -25.5Z" fill="#f28fa0" {...outline} />
      <path d="M-3.2 0 L0 6 L3.2 0Z" fill="#f2d1a8" {...outline} />
    </g>
  </>;
  const size = prop === "search" ? 1.3 : 1;
  return <g transform={`translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rotate.toFixed(2)}) scale(${(grow * size).toFixed(3)})`}>{art}</g>;
}

function StateGlyph({ state }: { state: ActivityState }) {
  const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg viewBox="0 0 16 16">
      {state === "done" ? (
        <path d="M4 8.4 L6.9 11.2 L12.2 5.2" {...stroke} />
      ) : state === "disconnected" ? (
        <>
          <path d="M5.8 6.1 Q5.9 3.6 8.1 3.6 Q10.4 3.7 10.4 5.8 Q10.4 7.4 8.1 8.3 V9.3" {...stroke} strokeWidth={2.1} />
          <circle cx="8.1" cy="12.3" r="1.3" fill="currentColor" />
        </>
      ) : state === "interrupted" || state === "waiting" ? (
        <path d="M6 4.5 V11.5 M10 4.5 V11.5" {...stroke} />
      ) : (
        <>
          <path d="M8 3.8 V8.8" {...stroke} />
          <circle cx="8" cy="12" r="1.35" fill="currentColor" />
        </>
      )}
    </svg>
  );
}
