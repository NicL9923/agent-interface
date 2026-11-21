import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ActivityState, Avatar as AvatarConfig, AvatarShape, Eyes } from "../shared/types";
import {
  FACE_RADIUS,
  animatesAt,
  approach,
  avatarPose,
  bodyEdge,
  expressionFor,
  faceInk,
  frozenStates,
  motionClock,
  orbitArcs,
  perspective,
  pitchEyes,
  popIn,
  project,
  propMotion,
  IDLE_FRAME_MS,
  idleQuietAt,
  ringOffset,
  smoothstep,
  soloPlan,
  tickMarks,
  type AvatarProp,
  type Expression,
  type MotionPlan,
} from "./avatar-motion";
import { startFrames } from "./avatar-frames";
import { avatarConductor } from "./avatar-conductor";
import { useAvatarAttention, useAvatarReactions, withGaze } from "./avatar-attention";
import "./avatar.css";
import { sampleOutline, type Points } from "./avatar-outline";
import { shapes } from "./avatar-shapes";

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
  disconnected: "Reconnecting",
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

/**
 * A shape's outline and face. A shape this release does not have still draws, as the blob: one a
 * newer release saved, or anything else Hermes metadata holds, such as the name of a property
 * every object inherits.
 */
const artOf = (shape: AvatarShape) => (Object.hasOwn(shapes, shape) ? shapes[shape] : shapes.blob);
/** Half the width of each eye style at full size, in avatar units. */
const eyeHalfWidths: Record<Eyes, number> = { oval: 5.5, round: 7.5, visor: 10, spark: 10 };
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

function useShapeTransition(desired: string, reduce: boolean) {
  const points = useRef<Points | null>(null);
  if (!points.current) points.current = sampleOutline(desired);
  const [path, setPath] = useState(desired);
  useEffect(() => {
    const target = sampleOutline(desired);
    // A mounting avatar already shows its shape: there is nothing to move between.
    if (reduce || points.current === target) {
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
      points.current = target.map((p, i) => p.map((v, j) => from[i][j] + (v - from[i][j]) * ease));
      // The samples carry the shape across; the outline itself, with any hole, takes over at the end.
      setPath(t < 1 ? "M" + points.current.map((p) => p.join(" ")).join(" L") + "Z" : desired);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [desired, reduce]);
  return path;
}

/** Trails from the current pose, or residual trails still sweeping after a change. */
function trailsAt(
  pose: { trails: number; sweep: number },
  t: number,
  carry: number,
  carrySweep: number,
) {
  const residual = carry * (1 - smoothstep(t / 0.6));
  return pose.trails >= residual
    ? { level: pose.trails, sweep: pose.sweep }
    : { level: residual, sweep: carrySweep + t * 7 };
}

const morphTargets = (state: ActivityState) => ({
  bang: state === "blocked" ? 1 : 0,
});

/** The directions a cheer's sparks fly, in degrees. */
const sparks = [0, 45, 90, 135, 180, 225, 270, 315];

/**
 * Who the conductor sees. A bot's ID wins over its name, because two bots can share a name and
 * must still move independently; an avatar with neither counts as its own bot.
 */
export function motionOwner(botId: string | undefined, name: string | undefined, instance: string) {
  return botId !== undefined
    ? `bot:${botId}`
    : name !== undefined
      ? `name:${name}`
      : `avatar-${instance}`;
}

export function Avatar({
  avatar = defaultAvatar,
  state = "idle",
  size = 48,
  name,
  botId,
  reducedMotion = false,
  showState = false,
  offline = false,
  prop,
  aware = false,
}: {
  avatar?: AvatarConfig;
  state?: ActivityState;
  size?: number;
  /** The bot's name, for its label. Without a `botId`, avatars with the same name share gestures. */
  name?: string;
  /** The bot's stable ID. Two bots can share a name; their avatars must still move independently. */
  botId?: string;
  reducedMotion?: boolean;
  showState?: boolean;
  offline?: boolean;
  /** A tool to hold while working, such as a magnifying glass during a search. */
  prop?: AvatarProp;
  /** Featured avatars glance at a nearby mouse pointer, and at siblings that finish, while idle. */
  aware?: boolean;
}) {
  const wrapper = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    // Without the observer, as in jsdom or an old browser, the avatar stays visible and keeps moving.
    if (!wrapper.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(wrapper.current);
    return () => observer.disconnect();
  }, []);
  const reduce = useReducedMotion(reducedMotion);
  const id = useId().replace(/:/g, "");
  const label = name ?? "Assistant";
  const statusLabel = state === "disconnected" && offline ? "Offline" : stateLabels[state];
  // The conductor keeps different bots from gesturing alike; an unnamed avatar is its own bot.
  const owner = motionOwner(botId, name, id);
  const [, setFrame] = useState(0);
  // Mutable animation clock. Only commit-phase effects and frame callbacks write
  // it, so an interrupted or replayed render never disturbs the running motion.
  const motion = useRef({
    state,
    since: performance.now(),
    /** Whether `since` marks a state change rather than the mount. */
    entered: false,
    plan: soloPlan as MotionPlan,
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
  const gaze = useAvatarAttention(
    wrapper,
    botId,
    aware && !still && (state === "idle" || state === "done"),
  );
  const burst = useAvatarReactions(wrapper, botId, !reduce);
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
      entered: true,
      elapsed: 0,
      carry: clock.level,
      carrySweep: clock.sweep,
    };
  }, [state]);
  useEffect(() => {
    if (still) {
      expression.current = expressionFor(state, Infinity);
      morph.current = morphTargets(state);
      motion.current = {
        ...motion.current,
        elapsed: 0,
        level: 0,
        sweep: 0,
        carry: 0,
        carrySweep: 0,
      };
      setFrame((f) => f + 1);
      return;
    }
    let last = performance.now();
    return startFrames({
      advance: (now) => {
        // A frame's timestamp can come from before this avatar started its clock, so a step is never negative.
        const dt = Math.min(Math.max(0, (now - last) / 1000), 0.05);
        last = now;
        const clock = motion.current;
        const cue = avatarConductor.cue(
          owner,
          state,
          clock.since / 1000,
          clock.entered,
          !!clock.prop,
          now / 1000,
        );
        const { plan } = cue;
        const t = Math.max(0, now / 1000 - cue.since);
        const trail = trailsAt(
          avatarPose(state, t, false, clock.prop, plan),
          t,
          clock.carry,
          clock.carrySweep,
        );
        motion.current = { ...clock, elapsed: t, now, plan, ...trail };
        expression.current = approach(expression.current, expressionFor(state, t, plan), dt);
        const targets = morphTargets(state);
        const k = 1 - Math.exp(-dt / 0.13);
        morph.current = {
          bang: morph.current.bang + (targets.bang - morph.current.bang) * k,
        };
        const settling = Math.abs(targets.bang - morph.current.bang) > 0.002 || t < 0.7;
        if (!animatesAt(state, t, plan) && !settling) return null;
        // Small avatars repaint at about 30 fps to spare battery. They sleep between frames, because
        // asking for every display refresh makes the page restyle on each one even when nothing paints.
        // An idle avatar that is only breathing sleeps longer, until just before its next blink or glance.
        return state === "idle" && !settling && idleQuietAt(t, plan, (IDLE_FRAME_MS + 20) / 1000)
          ? IDLE_FRAME_MS
          : size >= 56
            ? 0
            : 24;
      },
      commit: () => setFrame((f) => f + 1),
    });
  }, [state, still, size, owner]);

  // A state that has not committed yet renders from its first frame.
  const clock = motion.current;
  const fresh = clock.state !== state;
  const t = still || fresh ? 0 : clock.elapsed;
  const plan = still || fresh ? soloPlan : clock.plan;
  const held = state === "working" && avatar.mode !== "portrait" ? prop : undefined;
  const pose = withGaze(avatarPose(state, t, still, held, plan), gaze);
  const { level: trailLevel, sweep } = still
    ? { level: 0, sweep: 0 }
    : fresh
      ? trailsAt(pose, 0, clock.level, clock.sweep)
      : trailsAt(pose, t, clock.carry, clock.carrySweep);
  const face = expression.current;
  const { bang } = morph.current;
  const symbolic = bang;

  const color = avatar.mode === "portrait" ? "#1084FE" : avatar.color;
  const eyes = avatar.mode === "portrait" ? "oval" : avatar.eyes;
  const accessory = avatar.mode === "portrait" ? "none" : avatar.accessory;
  const art = artOf(avatar.mode === "geometric" ? avatar.shape : "blob");
  const anchor = art.face;
  const bodyPath = useShapeTransition(art.path, reduce);
  const ink = faceInk(color);
  const edge = bodyEdge(color);
  const eyeScale = anchor.scale;
  const faceX = anchor.cx ?? 50;
  // The face turns on a sphere as wide as the part it sits on, and a glance travels in proportion.
  const faceRadius = anchor.radius ?? FACE_RADIUS;
  const reach = faceRadius / FACE_RADIUS;
  const eyeWidth = avatar.mode === "portrait" ? 1 : (avatar.eyeWidth ?? 1);
  const eyeHeight = avatar.mode === "portrait" ? 1 : (avatar.eyeHeight ?? 1);
  const eyeSpacing = avatar.mode === "portrait" ? 1 : (avatar.eyeSpacing ?? 1);
  const eyeY = anchor.cy + pose.gazeY * 3 * reach + (state === "waiting" ? 2 * reach : 0);
  // Tuned eyes stop growing at the edge of the part the face sits on. A visor at full width and
  // spacing fits the blob, but on a paint brush it would run past the bristles and be cut off.
  const widest = eyeHalfWidths[eyes] * eyeScale * eyeWidth;
  const spread = ((anchor.spacing ?? 30 * eyeScale) / 2) * eyeSpacing;
  const fit = Math.min(1, (faceRadius - 1) / (spread + widest));
  const eyeOffset = spread * fit;
  const center = project(pose.gazeX * 2 * reach, pose.yaw, faceRadius);
  const open = Math.max(face.open * pose.blink * eyeHeight * eyeScale, 0.04);
  // A pitched face rolls everything painted on it around the sphere.
  const roll = pitchEyes(pose.pitch, faceRadius);
  // Dots replace pills outright; other eye styles shrink toward a dot instead.
  const pill = eyes !== "spark" && eyes !== "visor" && eyes !== "round";
  const dotShrink = pill ? 1 + 0.12 * face.dot : 1 - 0.3 * face.dot;
  const trailArcs =
    trailLevel > 0.01
      ? trailOrbits.map(([rx, ry, tilt], i) => orbitArcs(-sweep - i * 0.9, 1.5, rx, ry, tilt))
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
    if (eyes === "spark")
      return <path d="M0 -10 L3.2 -3.2 L10 0 L3.2 3.2 L0 10 L-3.2 3.2 L-10 0 L-3.2 -3.2Z" />;
    if (eyes === "visor") return <rect x="-10" y="-4.5" width="20" height="9" rx="4.5" />;
    if (eyes === "round") return <circle r="7.5" />;
    const height = 25 - 14 * face.dot;
    return (
      <rect
        x="-5.5"
        y={-height / 2}
        width="11"
        height={height}
        rx="5.5"
        transform={`rotate(${face.tilt * side})`}
      />
    );
  };
  const eyesLayer = [-1, 1].map((direction) => {
    const p = project(direction * eyeOffset + pose.gazeX * 4 * reach, pose.yaw, faceRadius);
    if (!p.visible) return null;
    const side = -direction;
    // Near eyes read a little larger as the face turns, and a pop of surprise grows both.
    const size = perspective(p.scale) * pose.eyeScale * dotShrink * fit;
    return (
      <g key={direction} transform={`translate(${faceX + p.x} ${eyeY})`}>
        <g
          opacity={1 - face.happy}
          transform={`scale(${p.scale * eyeWidth * eyeScale * size * (1 + (1 - Math.min(face.open, 1)) * 0.4)} ${open * size})`}
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
            transform={`scale(${p.scale * eyeWidth * eyeScale * fit} ${eyeScale * fit})`}
          />
        )}
        {accessory === "glasses" && (
          <ellipse
            rx={12.5 * eyeScale * p.scale * fit}
            ry={12.5 * eyeScale * fit}
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
      d={`M${faceX + center.x - 4 * center.scale} ${eyeY - 2} Q${faceX + center.x} ${eyeY - 5} ${faceX + center.x + 4 * center.scale} ${eyeY - 2}`}
      fill="none"
      stroke={ink}
      strokeWidth="2.5"
      strokeLinecap="round"
    />
  );
  const hat = accessory === "hat" && (
    <g transform={`translate(${faceX} ${anchor.top + 15 * anchor.hat}) scale(${anchor.hat})`}>
      <path d="M-20 -2 Q-21 -20 -10 -21 Q0 -16 10 -21 Q21 -20 20 -2Z" fill="#3a2f28" />
      <path d="M-20.3 -7 Q0 -3 20.3 -7 L20 -2 Q0 2 -20 -2Z" fill="#b48156" />
      <path
        d="M-37 -4 Q-34 5 0 5 Q34 5 37 -4 Q38 -8 33 -6 Q0 2 -33 -6 Q-38 -8 -37 -4Z"
        fill="#302925"
      />
    </g>
  );
  // A held prop pops in when Hermes starts a new kind of tool.
  const propAge = still ? 1 : clock.prop !== prop ? 0 : (clock.now - clock.propSince) / 1000;
  const heldProp = held && (
    <g className="avatar-prop" data-prop={held} opacity={smoothstep(propAge / 0.2)}>
      <PropArt prop={held} t={motionClock(t, plan)} grow={popIn(propAge / 0.4)} />
    </g>
  );
  // Emphasis marks are lost at list sizes, so only larger avatars draw them.
  const ticks = size >= 40 && pose.ticks > 0.01 && (
    <g
      fill="none"
      stroke={color}
      strokeWidth="4.2"
      strokeLinecap="round"
      opacity={Math.min(pose.ticks, 1)}
      className="avatar-ticks"
    >
      {tickMarks(pose.ticks, pose.tickSide, anchor.top).map((d, i) => (
        <path key={i} d={d} />
      ))}
    </g>
  );
  const bodyScale = 1 - 0.45 * symbolic;
  const bodyTransform = [
    `translate(${pose.shiftX} ${pose.lift})`,
    `rotate(${pose.roll} 50 60)`,
    `translate(50 94) scale(${pose.scaleX * (1 - 0.3 * bang)} ${pose.scaleY}) translate(-50 -94)`,
    `translate(50 50) scale(${bodyScale}) translate(-50 -50)`,
  ].join(" ");
  // A portrait's ring turns at this bot's own offset and pace.
  const ring = avatar.mode === "portrait" ? ringOffset(owner) : null;
  const badge =
    avatar.mode === "portrait"
      ? state !== "idle" && state !== "thinking" && state !== "working"
      : ["disconnected", "failed", "interrupted", "done"].includes(state);
  return (
    <span
      ref={wrapper}
      className={`avatar-wrap avatar-${avatar.mode}`}
      style={{
        width: size,
        height: size,
        ["--avatar-size" as string]: `${size}px`,
        ...(ring && {
          ["--avatar-ring-phase" as string]: ring.phase.toFixed(3),
          ["--avatar-ring-pace" as string]: ring.pace.toFixed(3),
        }),
      }}
      data-state={state}
      data-shape={avatar.mode === "geometric" ? avatar.shape : undefined}
      data-reduced-motion={reduce}
      role="img"
      aria-label={`${label}: ${statusLabel}`}
    >
      {avatar.mode === "portrait" ? (
        <>
          <span className="avatar-ring" aria-hidden="true" />
          <img
            className="avatar-portrait"
            src={avatar.src || undefined}
            alt=""
            width={size}
            height={size}
            loading="lazy"
            decoding="async"
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
            <path d={bodyPath} fill={color} className="avatar-body" />
            <g clipPath={`url(#face-${id})`}>
              {roll.visible && (
                <g
                  transform={
                    pose.pitch
                      ? `translate(0 ${anchor.cy + roll.y}) scale(1 ${roll.scale}) translate(0 ${-anchor.cy})`
                      : undefined
                  }
                >
                  <g fill={ink}>{eyesLayer}</g>
                  {glassesBridge}
                </g>
              )}
            </g>
            {edge && <path d={bodyPath} fill="none" stroke={edge} strokeWidth="2.2" />}
            {hat}
            {ticks}
            {trailLayer("front")}
          </g>
          {heldProp}
          {/* The symbol stands in for the body, so a very light one keeps the body's soft edge. */}
          <g fill={color} stroke={edge ?? undefined} strokeWidth={edge ? 2.2 : undefined}>
            {bang > 0.01 && (
              <g
                opacity={smoothstep(bang)}
                transform={`translate(50 50) rotate(${pose.symbolTilt} 0 30) scale(${0.4 + 0.6 * bang}) translate(-50 -50)`}
              >
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
      {showState && <span className="avatar-caption">{statusLabel}</span>}
      {burst > 0 && (
        <span className="avatar-burst" key={burst} aria-hidden="true">
          {sparks.map((turn) => (
            <i key={turn} style={{ ["--spark-turn" as string]: `${turn}deg` }} />
          ))}
        </span>
      )}
    </span>
  );
}

/** Small held props, drawn in avatar units in front of the body. */
function PropArt({ prop, t, grow }: { prop: AvatarProp; t: number; grow: number }) {
  const { x, y, rotate } = propMotion(prop, t);
  const outline = {
    stroke: "#2b201b",
    strokeWidth: 2.2,
    strokeLinejoin: "round" as const,
    strokeLinecap: "round" as const,
  };
  const art =
    prop === "search" ? (
      <>
        <path d="M8 8 L19 19" {...outline} strokeWidth={6.5} />
        <path d="M8 8 L19 19" stroke="#b07a4a" strokeWidth={3.6} strokeLinecap="round" />
        <circle r="11" fill="#d9f2ff" fillOpacity="0.55" {...outline} strokeWidth={3.4} />
        <path
          d="M-6 -3 Q-5 -6 -2 -7"
          fill="none"
          stroke="#fff"
          strokeWidth={2}
          strokeLinecap="round"
          opacity="0.9"
        />
      </>
    ) : prop === "computer" ? (
      <>
        <rect x="-21" y="-23" width="42" height="27" rx="4" fill="#cfd5dc" {...outline} />
        <circle cy="-10" r="3" fill="#9aa4ae" />
        <path d="M-27 4 H27 L24 10 H-24Z" fill="#aab3bc" {...outline} />
        <circle cx="16" cy="7" r="1.1" fill="#7bd88f" opacity={0.5 + 0.5 * Math.sin(t * 5)} />
      </>
    ) : prop === "read" ? (
      <>
        <path d="M0 -10 Q-12 -15 -24 -11 V7 Q-12 3 0 8Z" fill="#fff8ec" {...outline} />
        <path d="M0 -10 Q12 -15 24 -11 V7 Q12 3 0 8Z" fill="#fff8ec" {...outline} />
        <path
          d="M-19 -6 Q-11 -9 -4 -6 M-19 -1 Q-11 -4 -4 -1 M4 -6 Q11 -9 19 -6 M4 -1 Q11 -4 19 -1"
          fill="none"
          stroke="#b9ab96"
          strokeWidth={1.4}
          strokeLinecap="round"
        />
        <path
          d="M-25 8 Q-12 4 0 9 Q12 4 25 8"
          fill="none"
          stroke="#c0503a"
          strokeWidth={3}
          strokeLinecap="round"
        />
      </>
    ) : (
      <>
        <g transform="rotate(-8 0 12)">
          <rect x="-15" y="2" width="26" height="20" rx="2.5" fill="#fff8ec" {...outline} />
          <path
            d={`M-10 9 H${-10 + 16 * ((t * 0.5) % 1)} M-10 15 H2`}
            fill="none"
            stroke="#9db7d6"
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </g>
        <g transform="rotate(38)">
          <rect x="-3.2" y="-22" width="6.4" height="22" rx="1.2" fill="#ffc94a" {...outline} />
          <path
            d="M-3.2 -22 H3.2 V-25.5 Q3.2 -27 0 -27 Q-3.2 -27 -3.2 -25.5Z"
            fill="#f28fa0"
            {...outline}
          />
          <path d="M-3.2 0 L0 6 L3.2 0Z" fill="#f2d1a8" {...outline} />
        </g>
      </>
    );
  const size = prop === "search" ? 1.3 : 1;
  return (
    <g
      transform={`translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rotate.toFixed(2)}) scale(${(grow * size).toFixed(3)})`}
    >
      {art}
    </g>
  );
}

function StateGlyph({ state }: { state: ActivityState }) {
  const stroke = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg viewBox="0 0 16 16">
      {state === "done" ? (
        <path d="M4 8.4 L6.9 11.2 L12.2 5.2" {...stroke} />
      ) : state === "disconnected" ? (
        <>
          <path
            d="M5.8 6.1 Q5.9 3.6 8.1 3.6 Q10.4 3.7 10.4 5.8 Q10.4 7.4 8.1 8.3 V9.3"
            {...stroke}
            strokeWidth={2.1}
          />
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
