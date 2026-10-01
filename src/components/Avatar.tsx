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
  smoothstep,
  tint,
  type Expression,
} from "./avatar-motion";
import "./avatar.css";

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
function silhouette(shape: string) {
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
const faces: Record<string, { cy: number; scale: number; top: number; hat: number }> = {
  blob: { cy: 50, scale: 1, top: 3, hat: 1 },
  pebble: { cy: 50, scale: 1, top: 2, hat: 1 },
  squircle: { cy: 50, scale: 1, top: 5, hat: 1 },
  capsule: { cy: 47, scale: 0.9, top: 5, hat: 0.85 },
  triangle: { cy: 65, scale: 0.82, top: 3, hat: 0.6 },
  hex: { cy: 50, scale: 0.95, top: 5, hat: 0.95 },
  cloud: { cy: 55, scale: 0.95, top: 12, hat: 0.9 },
  drop: { cy: 63, scale: 0.9, top: 8, hat: 0.62 },
  circle: { cy: 50, scale: 1, top: 3, hat: 1 },
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
  dots: state === "thinking" ? 1 : 0,
  bang: state === "blocked" ? 1 : 0,
});

export function Avatar({
  avatar = defaultAvatar,
  state = "idle",
  size = 48,
  name = "Assistant",
  reducedMotion = false,
  showState = false,
}: {
  avatar?: AvatarConfig;
  state?: ActivityState;
  size?: number;
  name?: string;
  reducedMotion?: boolean;
  showState?: boolean;
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
  });
  const expression = useRef<Expression>(expressionFor(state, 0));
  const morph = useRef(morphTargets(state));
  const still = reduce || !visible || avatar.mode === "portrait" || frozenStates.includes(state);
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
      const trail = trailsAt(avatarPose(state, t, false), t, clock.carry, clock.carrySweep);
      motion.current = { ...clock, elapsed: t, ...trail };
      expression.current = approach(expression.current, expressionFor(state, t), dt);
      const targets = morphTargets(state);
      const k = 1 - Math.exp(-dt / 0.13);
      morph.current = {
        dots: morph.current.dots + (targets.dots - morph.current.dots) * k,
        bang: morph.current.bang + (targets.bang - morph.current.bang) * k,
      };
      const settling = Math.abs(targets.dots - morph.current.dots) + Math.abs(targets.bang - morph.current.bang) > 0.002 || t < 0.7;
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
  const pose = avatarPose(state, t, still);
  const { level: trailLevel, sweep } = still
    ? { level: 0, sweep: 0 }
    : fresh
      ? trailsAt(pose, 0, clock.level, clock.sweep)
      : trailsAt(pose, t, clock.carry, clock.carrySweep);
  const face = expression.current;
  const { dots, bang } = morph.current;
  const symbolic = Math.max(dots, bang);

  const mascot = avatar.mode === "mascot" ? avatar : null;
  const color = avatar.mode === "portrait" ? "#1084FE" : avatar.color;
  const eyes = avatar.mode === "portrait" ? "oval" : avatar.eyes;
  const accessory = avatar.mode === "portrait" ? "none" : avatar.accessory;
  const geometry = avatar.mode === "geometric" ? avatar.shape : "mascot";
  const anchor = faces[geometry] || faces.blob;
  const bodyPath = useShapeTransition(silhouette(geometry), reduce);
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
    </g>
  );
  const cheeks = mascot && [-1, 1].map((direction) => {
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
  const hat = accessory === "hat" && (
    <g transform={`translate(50 ${anchor.top + 15 * anchor.hat}) scale(${anchor.hat})`}>
      <path d="M-20 -2 Q-21 -20 -10 -21 Q0 -16 10 -21 Q21 -20 20 -2Z" fill="#3a2f28" />
      <path d="M-20.3 -7 Q0 -3 20.3 -7 L20 -2 Q0 2 -20 -2Z" fill="#b48156" />
      <path d="M-37 -4 Q-34 5 0 5 Q34 5 37 -4 Q38 -8 33 -6 Q0 2 -33 -6 Q-38 -8 -37 -4Z" fill="#302925" />
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
            <path d={bodyPath} fill={color} className="avatar-body" />
            <g clipPath={`url(#face-${id})`}>
              {mascotFace}
              {cheeks}
              <g fill={ink}>{eyesLayer}</g>
              {glassesBridge}
            </g>
            {hat}
            {trailLayer("front")}
          </g>
          <g fill={color}>
            {bang > 0.01 && (
              <g opacity={smoothstep(bang)}
                transform={`translate(50 50) rotate(${pose.symbolTilt} 0 30) scale(${0.4 + 0.6 * bang}) translate(-50 -50)`}>
                <path d="M42.5 21 Q50 12 57.5 21 L54.5 61 Q50 68 45.5 61Z" />
                <circle cx="50" cy="79" r="7.5" />
              </g>
            )}
            {dots > 0.01 &&
              [-1, 0, 1].map((offset, i) => {
                const wave = still ? 0.5 : Math.max(0, Math.sin(t * 4.2 - i * 0.9));
                return (
                  <circle
                    key={offset}
                    cx={50 + offset * 25 * dots}
                    cy={50 - wave * 7 * dots}
                    r={8.5 * Math.sqrt(dots)}
                    opacity={smoothstep(dots) * (still ? 1 - i * 0.25 : 0.5 + 0.5 * wave)}
                  />
                );
              })}
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
