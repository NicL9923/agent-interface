import type { Avatar } from "../shared/types";
import { project, tint } from "./avatar-motion";

export const seasonalChoices = [
  { family: "pumpkin", label: "Pumpkin", color: "#FF9800" },
  { family: "santa", label: "Santa", color: "#F2B08B" },
  { family: "rudolph", label: "Rudolph", color: "#97683D" },
  { family: "turkey", label: "Turkey", color: "#97683D" },
  { family: "bunny", label: "Easter Bunny", color: "#F5E9D8" },
] as const;
export type SeasonalFamily = typeof seasonalChoices[number]["family"];
export function isSeasonal(family: string): family is SeasonalFamily {
  return seasonalChoices.some(choice => choice.family === family);
}
export function seasonalAvatar(family: SeasonalFamily): Extract<Avatar, { mode: "mascot" }> {
  const choice = seasonalChoices.find(choice => choice.family === family)!;
  return { mode: "mascot", family, color: choice.color, eyes: "round", accessory: "none" };
}
export const seasonalHeads: Record<SeasonalFamily, string> = {
  pumpkin: "M50 24 C32 13 8 27 7 56 C6 80 21 94 50 94 C79 94 94 80 93 56 C92 27 68 13 50 24Z",
  santa: "M50 22 C75 22 90 41 90 62 C90 82 75 96 50 96 C25 96 10 82 10 62 C10 41 25 22 50 22Z",
  rudolph: "M50 25 C74 25 89 43 88 65 C88 85 73 97 50 97 C27 97 12 85 12 65 C11 43 26 25 50 25Z",
  turkey: "M50 30 C69 30 82 45 82 62 C86 76 80 94 50 95 C20 94 14 76 18 62 C18 45 31 30 50 30Z",
  bunny: "M50 31 C74 31 87 46 87 65 C87 84 72 96 50 96 C28 96 13 84 13 65 C13 46 26 31 50 31Z",
};
export const seasonalAnchors = {
  pumpkin: { cy: 53, scale: 0.95, top: 18, hat: 0.75 },
  santa: { cy: 51, scale: 0.9, top: 22, hat: 0.75 },
  rudolph: { cy: 54, scale: 0.9, top: 25, hat: 0.7 },
  turkey: { cy: 54, scale: 0.85, top: 30, hat: 0.65 },
  bunny: { cy: 57, scale: 0.9, top: 31, hat: 0.65 },
};

/** Identity parts behind the head, carried by the same body animation rig. */
export function SeasonalBack({ family, color, yaw }: { family: SeasonalFamily; color: string; yaw: number }) {
  if (family === "turkey") return <g data-seasonal-feature="feathers"
    transform={`translate(50 78) scale(${Math.max(Math.abs(Math.cos(yaw)), 0.25)} 1)`}>
    {[-60, -40, -20, 0, 20, 40, 60].map((angle, index) => <g key={angle} transform={`rotate(${angle})`}>
      <ellipse cx="0" cy="-31" rx="10" ry="29" fill={["#B84E32", "#D88736", "#F3BF58"][index % 3]} />
      <path d="M0 -53 V-8" stroke="#6C4130" strokeWidth="1.7" opacity="0.38" />
    </g>)}
  </g>;
  if (family === "pumpkin") return <g data-seasonal-feature="stem" transform={`translate(${project(0, yaw).x * 0.25} 0)`}>
    <path d="M44 25 C47 18 45 11 48 5 L57 8 C52 16 55 21 56 26Z" fill="#52713A" />
    <path d="M53 15 C59 3 74 2 80 9 C73 18 62 20 53 15Z" fill="#6C9348" />
    <path d="M56 14 Q65 9 74 9" fill="none" stroke="#A9C56C" strokeWidth="1.7" strokeLinecap="round" />
  </g>;
  if (family !== "rudolph" && family !== "bunny") return null;
  return <g data-seasonal-feature={family === "bunny" ? "long-ears" : "antlers"}>
    {[-1, 1].map(direction => {
      const p = project(direction * (family === "bunny" ? 15 : 27), yaw, 44);
      const depth = Math.max(Math.abs(Math.cos(yaw)), 0.3);
      return family === "bunny" ? <g key={direction}
        transform={`translate(${50 + p.x} 0) scale(${depth * -direction} 1)`}>
        <path d="M-11 45 C-20 29 -15 0 -6 0 C6 0 8 24 5 43Z" fill={color} />
        <path d="M-7 35 C-11 24 -10 10 -6 8 C0 10 1 24 -1 35Z" fill="#EDA6AF" />
      </g> : <g key={direction} transform={`translate(${50 + p.x} 8) scale(${depth * direction} 1)`}>
        <path d="M0 31 L-2 17 L4 8 L2 0 M-2 17 L-12 10 L-11 2 M4 8 L13 5 L15 -2"
          fill="none" stroke="#66452D" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M0 33 C6 18 20 17 24 23 C20 32 12 37 0 38Z" fill={color} />
        <path d="M6 31 Q14 22 19 24 Q15 31 6 33Z" fill={tint(color, 0.45)} />
      </g>;
    })}
  </g>;
}

/** Face markings are drawn inside the head's clip and projected with its eyes. */
export function SeasonalFace({ family, color, ink, mouth, happy }: {
  family: SeasonalFamily; color: string; ink: string; mouth: number; happy: number;
}) {
  if (family === "pumpkin") return <g data-seasonal-feature="carved-smile">
    <path d="M34 26 C24 45 24 75 36 90 M66 26 C76 45 76 75 64 90" fill="none"
      stroke={tint(color, -0.35)} strokeWidth="2.5" opacity="0.5" />
    <path d={`M32 71 Q50 ${78 + 6 * mouth} 68 71 L65 81 L57 81 L55 87 L45 87 L43 81 L35 81Z`} fill={ink} />
    <path d="M44 78 L44 83 L49 83 L49 79 M55 79 L55 83 L60 83 L60 77" fill={color} />
  </g>;
  if (family === "santa") return <g data-seasonal-feature="beard">
    <path d="M13 63 Q24 58 31 67 Q50 74 69 67 Q76 58 87 63 C88 79 72 98 50 100 C28 98 12 79 13 63Z" fill="#FFF3DB" />
    <ellipse cx="50" cy="63" rx="7" ry="5.5" fill={tint(color, -0.08)} />
    <path d="M29 71 Q34 61 50 66 Q66 61 71 71 Q61 80 50 72 Q39 80 29 71Z" fill="#FFFDF7" />
    <path d={`M43 80 Q50 ${80 + 5 * mouth} 57 80`} fill="none" stroke="#704737" strokeWidth="2.1" strokeLinecap="round" />
  </g>;
  if (family === "turkey") return <g data-seasonal-feature="beak-wattle">
    <path d="M51 69 C65 70 63 88 56 87 C49 86 54 77 49 74Z" fill="#D95145" />
    <path d="M41 64 Q50 61 59 64 L50 75Z" fill="#FFB548" />
    <path d={`M46 69 Q50 ${70 + 2 * mouth} 54 69`} fill="none" stroke="#8D5930" strokeWidth="1.6" strokeLinecap="round" />
  </g>;
  const bunny = family === "bunny";
  return <g data-seasonal-feature={bunny ? "bunny-muzzle" : "red-nose"}>
    <ellipse cx="50" cy="75" rx={bunny ? 21 : 20} ry={bunny ? 13 : 16} fill="#FFF3DB" />
    {bunny ? <>
      <path d="M45 67 Q50 64 55 67 L50 73Z" fill="#D98291" />
      <path d="M42 72 L22 68 M42 76 L20 77 M58 72 L78 68 M58 76 L80 77" stroke="#9F8F7A" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M46 78 H54 V85 Q50 88 46 85Z" fill="#FFFDF7" stroke="#C5B5A0" strokeWidth="1" />
      <path d="M50 79 V86" stroke="#C5B5A0" strokeWidth="1" />
    </> : <>
      <circle cx="50" cy="68" r="7.5" fill="#E94F49" />
      <ellipse cx="47.5" cy="65.5" rx="2.7" ry="1.8" fill="#FFF3DB" opacity="0.75" />
    </>}
    <path d={`M50 73 V77 M42.5 77 Q46.25 ${77 + 4 * mouth} 50 77 Q53.75 ${77 + 4 * mouth} 57.5 77`}
      fill="none" stroke="#66452D" strokeWidth="1.8" strokeLinecap="round" opacity={1 - happy} />
    {happy > 0.01 && <path d="M44 77 Q50 87 56 77Z" fill="#66452D" opacity={happy} />}
  </g>;
}

export function SeasonalFront({ family, yaw }: { family: SeasonalFamily; yaw: number }) {
  const depth = Math.max(Math.abs(Math.cos(yaw)), 0.3);
  if (family === "santa") return <g data-seasonal-feature="santa-cap"
    transform={`translate(50 0) scale(${depth} 1) translate(-50 0)`}>
    <path d="M17 30 C21 9 49 -2 69 6 Q80 8 87 23 L76 28 Q69 12 60 18 L72 31Z" fill="#D34434" />
    <path d="M19 27 Q49 20 74 28 L76 37 Q49 32 17 37Z" fill="#FFF3DB" />
    <circle cx="86" cy="27" r="8" fill="#FFFDF7" />
  </g>;
  if (family === "bunny") return <g data-seasonal-feature="bow" transform={`translate(${project(0, yaw).x * 0.7} 0)`}>
    <path d="M50 91 Q31 80 29 91 Q29 103 48 96 M50 91 Q69 80 71 91 Q71 103 52 96Z" fill="#A888CD" />
    <circle cx="50" cy="93" r="4" fill="#CBB2E5" />
  </g>;
  return null;
}
