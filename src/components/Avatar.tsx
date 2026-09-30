import { useEffect, useId, useRef, useState } from "react";
import type { ActivityState, Avatar as AvatarConfig } from "../shared/types";
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

function silhouette(shape: string) {
  switch (shape) {
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

function useMotion(force?: boolean) {
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
  const [symbolWeights, setSymbolWeights] = useState<[number, number]>([
    state === "thinking" ? 1 : 0,
    state === "blocked" ? 1 : 0,
  ]);
  const symbolRef = useRef(symbolWeights);
  const reduce = useMotion(reducedMotion);
  const id = useId().replace(/:/g, "");
  const [phase, setPhase] = useState(0);
  const [morph, setMorph] = useState(
    state === "thinking" || state === "blocked" ? 1 : 0,
  );
  const morphRef = useRef(morph);
  const start = useRef(0);
  useEffect(() => {
    start.current = performance.now();
    if (
      reduce ||
      !visible ||
      avatar.mode === "portrait" ||
      ["disconnected", "interrupted", "failed"].includes(state)
    ) {
      setPhase(0);
      symbolRef.current = [
        state === "thinking" ? 1 : 0,
        state === "blocked" ? 1 : 0,
      ];
      setSymbolWeights(symbolRef.current);
      setMorph(state === "thinking" || state === "blocked" ? 1 : 0);
      morphRef.current = state === "thinking" || state === "blocked" ? 1 : 0;
      return;
    }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(now - last, 40);
      last = now;
      const target = state === "thinking" || state === "blocked" ? 1 : 0;
      morphRef.current += (target - morphRef.current) * Math.min(dt / 130, 1);
      setMorph(morphRef.current);
      const targets = [
        state === "thinking" ? 1 : 0,
        state === "blocked" ? 1 : 0,
      ];
      symbolRef.current = symbolRef.current.map(
        (v, i) => v + (targets[i] - v) * Math.min(dt / 130, 1),
      ) as [number, number];
      setSymbolWeights(symbolRef.current);
      setPhase((now - start.current) / 1000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state, reduce, avatar.mode, visible]);
  const color = avatar.mode === "portrait" ? "#1084FE" : avatar.color;
  const active = state === "working" || state === "done";
  const yaw = reduce
    ? 0
    : state === "working"
      ? phase * 3.9
      : state === "done" && phase < 2.5
        ? phase * 8.5
        : Math.sin(phase * 0.7) * 0.15;
  const faceVisible = Math.cos(yaw) > 0;
  const blink = reduce ? 1 : phase % 5.7 > 5.48 ? 0.12 : 1;
  const faceScale =
    state === "waiting"
      ? 0.38
      : state === "failed"
        ? 0.52
        : state === "done"
          ? 0.65
          : 1;
  const lift = reduce
    ? 0
    : state === "working"
      ? Math.sin(phase * 10) * 0.9
      : state === "done" && phase < 2.5
        ? -Math.abs(Math.sin(phase * 5)) * 6
        : Math.sin(phase * 0.8) * 0.4;
  const eyes = avatar.mode === "portrait" ? "oval" : avatar.eyes;
  const accessory = avatar.mode === "portrait" ? "none" : avatar.accessory;
  const desiredPath =
    avatar.mode === "geometric" ? silhouette(avatar.shape) : silhouette("blob");
  const bodyPath = useShapeTransition(desiredPath, reduce);
  const roll = reduce
    ? 0
    : state === "done" && phase < 2.5
      ? Math.sin(phase * 4) * 48
      : Math.sin(phase * 0.6) * 2;
  const pitch = reduce
    ? 1
    : state === "done" && phase < 2.5
      ? 0.5 + 0.5 * Math.abs(Math.cos(phase * 5))
      : 1;
  const priorState = useRef(state);
  const [settleTrails, setSettleTrails] = useState(false);
  useEffect(() => {
    const wasActive = ["working", "done"].includes(priorState.current);
    priorState.current = state;
    if (wasActive && state === "waiting" && !reduce) {
      setSettleTrails(true);
      const timeout = setTimeout(() => setSettleTrails(false), 600);
      return () => clearTimeout(timeout);
    }
    setSettleTrails(false);
  }, [state, reduce]);
  return (
    <span
      ref={wrapper}
      className="avatar-wrap"
      style={{ width: size, height: size }}
      data-state={state}
      data-reduced-motion={reduce}
      role="img"
      aria-label={`${name}: ${stateLabels[state]}`}
    >
      {avatar.mode === "portrait" ? (
        <img
          className="avatar-portrait"
          src={avatar.src || undefined}
          alt=""
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      ) : (
        <svg viewBox="-8 -8 116 116" aria-hidden="true" className="avatar-svg">
          <defs>
            <clipPath id={`face-${id}`}>
              <path d={bodyPath} />
            </clipPath>
          </defs>
          <g
            opacity={1 - morph}
            transform={`translate(0 ${lift}) translate(50 50) rotate(${roll}) scale(1 ${pitch}) translate(-50 -50)`}
          >
            {avatar.mode === "mascot" && (
              <g fill={color}>
                {avatar.family === "fox" ? (
                  <path d="M12 43 L4 3 L37 25 M63 25 L97 3 L88 45" />
                ) : avatar.family === "bear" ? (
                  <>
                    <circle cx="17" cy="19" r="17" />
                    <circle cx="83" cy="19" r="17" />
                  </>
                ) : (
                  <>
                    <path
                      d="M50 15 Q18 -12 14 3 Q19 24 50 21 M50 15 Q64 -11 87 1 Q82 25 50 21"
                      fill="#458d63"
                    />
                  </>
                )}
              </g>
            )}
            <path d={bodyPath} fill={color} className="avatar-body" />
            {avatar.mode === "mascot" && (
              <>
                <ellipse cx="50" cy="68" rx="35" ry="25" fill="#fff3db" />
                <path
                  d="M43 71 Q50 79 57 71"
                  fill="none"
                  stroke="#402a24"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <ellipse cx="50" cy="66" rx="3" ry="2" fill="#402a24" />
              </>
            )}
            <g clipPath={`url(#face-${id})`}>
              <g
                opacity={faceVisible ? 1 : 0}
                transform={`translate(${Math.sin(yaw) * 38} ${state === "waiting" ? 3 : 0}) translate(50 50) scale(${Math.max(Math.abs(Math.cos(yaw)), 0.03)} 1) translate(-50 -50)`}
                fill={avatar.mode === "mascot" ? "#332620" : "#fff9ee"}
              >
                {[35, 65].map((x, i) => (
                  <g
                    key={`${x}-${eyes}`}
                    className="avatar-eye"
                    transform={`translate(${50 + (x - 50) * (avatar.eyeSpacing ?? 1)} 47) scale(${avatar.eyeWidth ?? 1} ${blink * faceScale * (avatar.eyeHeight ?? 1)})`}
                  >
                    {eyes === "spark" ? (
                      <path d="M0 -9 L3 -3 L9 0 L3 3 L0 9 L-3 3 L-9 0 L-3 -3Z" />
                    ) : eyes === "visor" ? (
                      <rect x="-9" y="-4" width="18" height="8" rx="4" />
                    ) : eyes === "round" ? (
                      <circle r="7" />
                    ) : (
                      <rect
                        x="-5"
                        y="-11"
                        width="10"
                        height="22"
                        rx="5"
                        transform={`rotate(${state === "failed" ? (i === 0 ? 25 : -25) : state === "waiting" ? 8 : 0})`}
                      />
                    )}
                  </g>
                ))}
                {accessory === "glasses" && (
                  <g
                    fill="none"
                    stroke={avatar.mode === "mascot" ? "#332620" : "#fff9ee"}
                    strokeWidth="2.5"
                  >
                    <circle cx="35" cy="47" r="12" />
                    <circle cx="65" cy="47" r="12" />
                    <path d="M47 47 H53" />
                  </g>
                )}
              </g>
            </g>
            {accessory === "hat" && (
              <g fill="#302925">
                <path d="M20 19 Q50 30 80 19 L70 13 L65 -4 L49 1 L36 -4 L31 13Z" />
                <path
                  d="M26 14 Q50 22 74 14"
                  stroke="#b48156"
                  strokeWidth="3"
                />
              </g>
            )}
            {(active || settleTrails) && !reduce && (
              <g
                className={`avatar-trails ${settleTrails ? "avatar-trails-settle" : ""}`}
                fill="none"
                strokeWidth="2.5"
                strokeLinecap="round"
                opacity={state === "done" && phase > 2.5 ? 0 : 0.8}
              >
                {["#ff729d", "#85bcfb", "#b790fc", "#92d899"].map((c, i) => (
                  <ellipse
                    key={c}
                    cx="50"
                    cy="50"
                    rx="52"
                    ry="16"
                    stroke={c}
                    strokeDasharray="48 205"
                    transform={`rotate(${i * 47 + phase * 150} 50 50)`}
                  />
                ))}
              </g>
            )}
          </g>
          <g fill={color}>
            <g opacity={symbolWeights[1]}>
              <path d="M45 23 Q50 17 55 23 L53 62 Q50 68 47 62Z" />
              <circle cx="50" cy="77" r="5" />
            </g>
            <g opacity={symbolWeights[0]}>
              {[25, 50, 75].map((x, i) => (
                <circle
                  key={x}
                  cx={x}
                  cy="50"
                  r={reduce ? 6.5 : 6.5 + Math.sin(phase * 5 - i * 1.6) * 1.3}
                  opacity={
                    reduce ? 0.65 : 0.55 + Math.sin(phase * 5 - i * 1.6) * 0.4
                  }
                />
              ))}
            </g>
          </g>
        </svg>
      )}
      {(avatar.mode === "portrait" ||
        ["disconnected", "failed", "interrupted", "done"].includes(state)) && (
        <span className="avatar-indicator" aria-hidden="true">
          {state === "disconnected"
            ? "?"
            : state === "failed"
              ? "!"
              : state === "interrupted"
                ? "Ⅱ"
                : state === "done"
                  ? "✓"
                  : state === "blocked"
                    ? "!"
                    : state === "thinking"
                      ? "···"
                      : state === "working"
                        ? "↻"
                        : state === "waiting"
                          ? "Ⅱ"
                          : "·"}
        </span>
      )}
      {showState && (
        <span className="avatar-caption">{stateLabels[state]}</span>
      )}
    </span>
  );
}
