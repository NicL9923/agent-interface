import type { ReactNode } from "react";
import { seasonalFamilies, type Avatar, type MascotFamily, type SeasonalFamily } from "../shared/types";
import { bodyEdge, project, tint } from "./avatar-motion";

/** Bear, fox and sprout are drawn by Avatar.tsx itself; every later character lives here. */
export type CharacterFamily = Exclude<MascotFamily, "bear" | "fox" | "sprout">;
export function isCharacter(family: MascotFamily): family is CharacterFamily {
  return family !== "bear" && family !== "fox" && family !== "sprout";
}

const seasonal: Record<SeasonalFamily, { label: string; color: string }> = {
  leprechaun: { label: "Leprechaun", color: "#F2B08B" },
  bunny: { label: "Easter Bunny", color: "#F5E9D8" },
  eagle: { label: "Bald Eagle", color: "#F7F3EA" },
  pumpkin: { label: "Pumpkin", color: "#FF9800" },
  bat: { label: "Bat", color: "#5E4B8B" },
  ghost: { label: "Ghost", color: "#F2EEF8" },
  turkey: { label: "Turkey", color: "#97683D" },
  santa: { label: "Santa", color: "#F2B08B" },
  rudolph: { label: "Rudolph", color: "#97683D" },
  snowman: { label: "Snowman", color: "#F4F8FB" },
};
export const seasonalChoices = seasonalFamilies.map((family) => ({ family, ...seasonal[family] }));
export function isSeasonal(family: string): family is SeasonalFamily {
  return family in seasonal;
}
export function seasonalAvatar(family: SeasonalFamily): Extract<Avatar, { mode: "mascot" }> {
  return { mode: "mascot", family, color: seasonal[family].color, eyes: "round", accessory: "none" };
}

const santaHead = "M50 22 C75 22 90 41 90 62 C90 82 75 96 50 96 C25 96 10 82 10 62 C10 41 25 22 50 22Z";
/** Characters without an outline here use the shared mascot head. */
export const characterHeads: Partial<Record<CharacterFamily, string>> = {
  cactus: "M50 10 C70 10 82 22 82 42 V84 Q82 96 70 96 H30 Q18 96 18 84 V42 C18 22 30 10 50 10Z",
  pumpkin: "M50 24 C32 13 8 27 7 56 C6 80 21 94 50 94 C79 94 94 80 93 56 C92 27 68 13 50 24Z",
  ghost: "M50 12 C73 12 88 29 88 52 V83 Q88 92 81 90 Q76 87 71 91 Q65 96 60 91 Q55 86 50 91 Q45 96 40 91 Q35 86 29 91 Q24 95 19 90 Q12 92 12 83 V52 C12 29 27 12 50 12Z",
  leprechaun: santaHead,
  santa: santaHead,
  rudolph: "M50 25 C74 25 89 43 88 65 C88 85 73 97 50 97 C27 97 12 85 12 65 C11 43 26 25 50 25Z",
  turkey: "M50 30 C69 30 82 45 82 62 C86 76 80 94 50 95 C20 94 14 76 18 62 C18 45 31 30 50 30Z",
  bunny: "M50 31 C74 31 87 46 87 65 C87 84 72 96 50 96 C28 96 13 84 13 65 C13 46 26 31 50 31Z",
  snowman: "M50 13 C74 13 92 31 92 55 C92 79 74 96 50 96 C26 96 8 79 8 55 C8 31 26 13 50 13Z",
};
/** Where the face sits; characters without one use the shared mascot anchor. */
export const characterAnchors: Partial<Record<CharacterFamily, { cy: number; scale: number; top: number; hat: number }>> = {
  cactus: { cy: 50, scale: 0.88, top: 10, hat: 0.7 },
  pumpkin: { cy: 53, scale: 0.95, top: 18, hat: 0.75 },
  ghost: { cy: 47, scale: 0.95, top: 12, hat: 0.8 },
  leprechaun: { cy: 54, scale: 0.9, top: 22, hat: 0.75 },
  santa: { cy: 51, scale: 0.9, top: 22, hat: 0.75 },
  rudolph: { cy: 54, scale: 0.9, top: 25, hat: 0.7 },
  turkey: { cy: 54, scale: 0.85, top: 30, hat: 0.65 },
  bunny: { cy: 57, scale: 0.9, top: 31, hat: 0.65 },
  snowman: { cy: 52, scale: 0.95, top: 13, hat: 0.8 },
};
/** A smaller cowboy hat leaves a character's own cap, ears and antlers visible. */
export const characterHatAnchors: Partial<Record<CharacterFamily, { top: number; hat: number }>> = {
  leprechaun: { top: -3, hat: 0.45 },
  santa: { top: -3, hat: 0.45 },
  rudolph: { top: 24, hat: 0.45 },
  bunny: { top: 31, hat: 0.4 },
};
/** Characters whose own markings take the place of blushing cheeks. */
export const cheekless: ReadonlySet<CharacterFamily> = new Set(["pumpkin", "owl"]);

const pandaFace = "#FBF7EF";
/** The head's own fill: a panda's face stays white while its ears and patches take the chosen color. */
export function headColor(family: CharacterFamily, color: string) {
  return family === "panda" ? pandaFace : color;
}
const raccoonMask = "#3A3236";
const owlDisc = "#FFF3DB";
/** What sits behind the eyes, so their ink contrasts with the patch, mask or disc instead of the head. */
export function eyeSurroundColor(family: CharacterFamily, color: string) {
  return family === "raccoon" ? raccoonMask : family === "owl" ? owlDisc : color;
}

/**
 * Painted behind each eye in eye coordinates, so a patch, mask or disc follows eye spacing and
 * the head's turn. `side` is 1 for the left eye; the art is drawn for the left eye, inward to +x.
 */
export function EyeSurround({ family, side, color, scaleX, scale }: {
  family: CharacterFamily; side: number; color: string; scaleX: number; scale: number;
}) {
  const transform = `scale(${scaleX * side} ${scale})`;
  if (family === "panda") return <ellipse data-character-feature="eye-patch" cx="0" cy="0" rx="9.5" ry="13.5"
    transform={`${transform} translate(-1.5 2.5) rotate(38)`} fill={color} />;
  if (family === "raccoon") return <path data-character-feature="mask" transform={transform} fill={raccoonMask}
    d="M19 -5 C12 -10 -6 -11 -14 -4 C-18 0 -17 7 -12 9 C-4 11 8 6 19 4Z" />;
  if (family === "owl") return <circle data-character-feature="facial-disc" transform={transform} r="12.5"
    fill={owlDisc} stroke={tint(color, -0.25)} strokeWidth="2" />;
  return null;
}

/** The two-curve animal mouth under a nose, with a stem, opening into a smile when happy. */
function AnimalMouth({ y, mouth, happy, stroke }: { y: number; mouth: number; happy: number; stroke: string }) {
  return <>
    <path d={`M50 ${y - 4} V${y} M42.5 ${y} Q46.25 ${y + 4 * mouth} 50 ${y} Q53.75 ${y + 4 * mouth} 57.5 ${y}`}
      fill="none" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" opacity={1 - happy} />
    {happy > 0.01 && <path d={`M44 ${y} Q50 ${y + 10} 56 ${y}Z`} fill={stroke} opacity={happy} />}
  </>;
}
const nose = "M45.5 66 Q50 63 54.5 66 Q53 70.5 50 71 Q47 70.5 45.5 66Z";

/** Identity parts behind the head, carried by the same body animation rig. */
export function CharacterBack({ family, color, yaw }: { family: CharacterFamily; color: string; yaw: number }) {
  const depth = Math.max(Math.abs(Math.cos(yaw)), 0.3);
  /** One part per side, drawn for the left side with outward toward -x. */
  const pair = (feature: string, dx: number, y: number, art: (direction: number) => ReactNode) =>
    <g data-character-feature={feature}>
      {[-1, 1].map((direction) => {
        const p = project(direction * dx, yaw, 44);
        return <g key={direction} transform={`translate(${50 + p.x} ${y}) scale(${depth * -direction} 1)`}>{art(direction)}</g>;
      })}
    </g>;
  if (family === "panda") return pair("round-ears", 31, 0, () => <circle cx="0" cy="24" r="14" fill={color} />);
  if (family === "raccoon") return pair("ears", 30, 0, () => <>
    <path d="M-18 40 C-20 26 -17 12 -11 8 C-6 6 4 14 12 24Z" fill={color} />
    <path d="M-13 32 C-14 23 -12 15 -9 13 C-5 13 0 18 4 23Z" fill={tint(color, 0.5)} />
  </>);
  if (family === "owl") return pair("tufts", 28, 0, () => <>
    <path d="M-12 36 C-16 26 -21 16 -26 8 C-20 9 -16 11 -13 14 C-13 10 -12 7 -10 4 C-7 13 0 20 8 26Z" fill={color} />
    <path d="M-12 29 C-14 24 -17 19 -20 14 C-16 15 -13 18 -11 21 C-10 18 -10 15 -9 13 C-7 19 -3 23 1 26Z" fill={tint(color, -0.25)} />
  </>);
  if (family === "cactus") return pair("arms", 30, 0, (direction) => <g transform={`translate(0 ${direction > 0 ? 8 : 0})`}>
    <path d="M2 76 H-8 Q-16 76 -16 68 V44 Q-16 37 -10.5 37 Q-5 37 -5 44 V64 H2Z" fill={color} />
    <path d="M-10.5 42 V68" fill="none" stroke={tint(color, -0.18)} strokeWidth="1.6" strokeLinecap="round" opacity="0.7" />
  </g>);
  if (family === "dinosaur") return <g data-character-feature="plates"
    transform={`translate(${50 + project(0, yaw).x} 56) scale(${depth} 1)`}>
    {[-50, -25, 0, 25, 50].map((angle) => <path key={angle} transform={`rotate(${angle}) scale(${1.05 - Math.abs(angle) / 200})`}
      d="M-8 -38 Q-4 -56 0 -57 Q4 -56 8 -38Z" fill={tint(color, -0.28)} />)}
  </g>;
  if (family === "bat") return <>
    {pair("wings", 34, 0, () => <>
      <path d="M4 44 C-4 36 -14 30 -24 28 C-23 37 -22 45 -24 54 C-19 51 -15 52 -13 57 C-10 53 -6 53 -4 58 C-1 54 2 53 5 56Z" fill={tint(color, -0.25)} />
      <path d="M3 47 L-22 31 M3 50 L-13 55 M4 52 L-4 57" fill="none" stroke={tint(color, -0.5)} strokeWidth="1.3" strokeLinecap="round" />
    </>)}
    {pair("ears", 28, 0, () => <>
      <path d="M-19 40 C-23 24 -22 10 -17 2 C-8 8 2 16 10 24Z" fill={color} />
      <path d="M-14 31 C-16 22 -16 14 -14 9 C-9 13 -3 18 2 23Z" fill="#E8A0B4" />
    </>)}
  </>;
  if (family === "ghost") return pair("arms", 36, 0, () =>
    <ellipse cx="-5" cy="58" rx="9" ry="5.5" transform="rotate(-32 -5 58)" fill={color}
      stroke={bodyEdge(color) ?? "none"} strokeWidth="2.2" />);
  if (family === "eagle") return <path data-character-feature="feather-collar" transform={`translate(${project(0, yaw).x * 0.3} 0)`}
    d="M10 70 C4 84 14 98 30 98 L34 92 L40 100 L46 93 L50 101 L54 93 L60 100 L66 92 L70 98 C86 98 96 84 90 70Z" fill="#6B4A2F" />;
  if (family === "turkey") return <g data-character-feature="feathers"
    transform={`translate(50 78) scale(${Math.max(Math.abs(Math.cos(yaw)), 0.25)} 1)`}>
    {[-60, -40, -20, 0, 20, 40, 60].map((angle, index) => <g key={angle} transform={`rotate(${angle})`}>
      <ellipse cx="0" cy="-31" rx="10" ry="29" fill={["#B84E32", "#D88736", "#F3BF58"][index % 3]} />
      <path d="M0 -53 V-8" stroke="#6C4130" strokeWidth="1.7" opacity="0.38" />
    </g>)}
  </g>;
  if (family === "pumpkin") return <g data-character-feature="stem" transform={`translate(${project(0, yaw).x * 0.25} 0)`}>
    <path d="M44 25 C47 18 45 11 48 5 L57 8 C52 16 55 21 56 26Z" fill="#52713A" />
    <path d="M53 15 C59 3 74 2 80 9 C73 18 62 20 53 15Z" fill="#6C9348" />
    <path d="M56 14 Q65 9 74 9" fill="none" stroke="#A9C56C" strokeWidth="1.7" strokeLinecap="round" />
  </g>;
  if (family !== "rudolph" && family !== "bunny") return null;
  return <g data-character-feature={family === "bunny" ? "long-ears" : "antlers"}>
    {[-1, 1].map(direction => {
      const p = project(direction * (family === "bunny" ? 15 : 27), yaw, 44);
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
export function CharacterFace({ family, color, ink, mouth, happy }: {
  family: CharacterFamily; color: string; ink: string; mouth: number; happy: number;
}) {
  if (family === "panda") return <g data-character-feature="panda-face">
    <path d={nose} fill="#2b201b" />
    <AnimalMouth y={74} mouth={mouth} happy={happy} stroke="#2b201b" />
  </g>;
  if (family === "raccoon") return <g data-character-feature="raccoon-face">
    <ellipse cx="35" cy="41" rx="8" ry="4" fill="#FFF3DB" opacity="0.9" />
    <ellipse cx="65" cy="41" rx="8" ry="4" fill="#FFF3DB" opacity="0.9" />
    <path d="M50 63 C44 66 34 66 28 70 C33 84 42 90 50 90 C58 90 67 84 72 70 C66 66 56 66 50 63Z" fill="#FFF3DB" />
    <path d={nose} fill="#2b201b" />
    <AnimalMouth y={74} mouth={mouth} happy={happy} stroke="#2b201b" />
  </g>;
  if (family === "owl") return <g data-character-feature="beak">
    <path d="M40 80 L43 83 L46 80 M47 85 L50 88 L53 85 M54 80 L57 83 L60 80" fill="none"
      stroke={tint(color, 0.35)} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M44.5 61 Q50 58.5 55.5 61 L50 72Z" fill="#F2A93B" />
  </g>;
  if (family === "cactus") return <g data-character-feature="ribs">
    <path d="M30 16 Q23 55 30 96 M70 16 Q77 55 70 96" fill="none" stroke={tint(color, -0.18)} strokeWidth="2" opacity="0.6" />
    <path d="M27 28 l-3 -2 M73 28 l3 -2 M25 80 l-3 1 M75 80 l3 1 M43 86 l-1 3 M57 86 l1 3" fill="none"
      stroke="#FFF3DB" strokeWidth="1.4" strokeLinecap="round" opacity="0.85" />
    <path d={`M45 66 Q50 ${66 + 6 * mouth} 55 66`} fill="none" stroke={ink} strokeWidth="2.4" strokeLinecap="round" opacity={1 - happy} />
    {happy > 0.01 && <path d="M44 65 Q50 75 56 65 Q50 67.5 44 65Z" fill={ink} opacity={happy} />}
  </g>;
  if (family === "dinosaur") return <g data-character-feature="snout">
    <ellipse cx="50" cy="75" rx="25" ry="14" fill={tint(color, 0.35)} />
    <ellipse cx="44" cy="69" rx="1.8" ry="1.3" fill={tint(color, -0.45)} />
    <ellipse cx="56" cy="69" rx="1.8" ry="1.3" fill={tint(color, -0.45)} />
    <path d={`M36 78 Q50 ${78 + 7 * mouth} 64 78`} fill="none" stroke="#2b201b" strokeWidth="2" strokeLinecap="round" opacity={1 - happy} />
    {happy > 0.01 && <path d="M36 77 Q50 92 64 77 Q50 81 36 77Z" fill="#2b201b" opacity={happy} />}
    <path d="M55.5 79.2 L60.5 78.4 L58.6 83.6Z" fill="#FFFDF7" />
  </g>;
  if (family === "bat") return <g data-character-feature="fangs">
    <path d="M46.5 64 Q50 62 53.5 64 Q52.5 67 50 67 Q47.5 67 46.5 64Z" fill={tint(color, -0.4)} />
    <path d={`M43 71 Q50 ${71 + 5 * mouth} 57 71`} fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" opacity={1 - happy} />
    {happy > 0.01 && <path d="M43 70 Q50 81 57 70Z" fill={ink} opacity={happy} />}
    <path d="M45 71.2 L46.5 75 L48 71.6Z M52 71.6 L53.5 75 L55 71.2Z" fill="#FFFDF7" />
  </g>;
  if (family === "ghost") return <g data-character-feature="boo">
    <g opacity={1 - happy}>
      <ellipse cx="50" cy="66" rx="4.5" ry={4.5 + 1.5 * mouth} fill={ink} />
      <ellipse cx="50" cy={68 + 1.2 * mouth} rx="2.6" ry="1.6" fill="#F28FA0" />
    </g>
    {happy > 0.01 && <path d="M43 63 Q50 74 57 63Z" fill={ink} opacity={happy} />}
  </g>;
  if (family === "eagle") return <g data-character-feature="hooked-beak">
    <path d="M40 61 Q50 56 60 61 Q63 70 56 78 Q53 81 52 77 Q51 72 50 70 Q44 70 40 61Z" fill="#F2B233" />
    <path d={`M42 65 Q50 ${67 + 3 * mouth} 58 65`} fill="none" stroke="#B97A1E" strokeWidth="1.5" strokeLinecap="round" />
    <ellipse cx="54" cy="61.5" rx="1.4" ry="0.9" fill="#B97A1E" />
  </g>;
  if (family === "leprechaun") return <g data-character-feature="red-beard">
    <path d="M10 54 Q16 72 30 79 Q40 83 50 81 Q60 83 70 79 Q84 72 90 54 C94 86 74 106 50 106 C26 106 6 86 10 54Z" fill="#D9692E" />
    <path d="M22 80 Q26 88 32 90 M40 88 Q44 95 50 96 M60 88 Q56 95 50 96 M78 80 Q74 88 68 90" fill="none"
      stroke="#B9531F" strokeWidth="1.6" strokeLinecap="round" opacity="0.7" />
    <ellipse cx="50" cy="66" rx="5.5" ry="4.5" fill={tint(color, -0.12)} />
    <path d={`M43 73 Q50 ${73 + 5 * mouth} 57 73`} fill="none" stroke="#704737" strokeWidth="2.1" strokeLinecap="round" opacity={1 - happy} />
    {happy > 0.01 && <path d="M43 72 Q50 82 57 72Z" fill="#704737" opacity={happy} />}
  </g>;
  if (family === "snowman") {
    const curve = mouth + 0.5 * happy;
    return <g data-character-feature="carrot-nose">
      {[-10, -5, 0, 5, 10].map((dx) => <circle key={dx} cx={50 + dx} cy={73 + (1 - (dx / 10) ** 2) * 4 * curve} r="1.7" fill="#2B2B2B" />)}
      <path d="M47 61 Q45.5 64.5 48 67 L64 65.5 Q65 64.5 64 63.8Z" fill="#F28C28" />
    </g>;
  }
  if (family === "pumpkin") return <g data-character-feature="carved-smile">
    <path d="M34 26 C24 45 24 75 36 90 M66 26 C76 45 76 75 64 90" fill="none"
      stroke={tint(color, -0.35)} strokeWidth="2.5" opacity="0.5" />
    <path d={`M32 71 Q50 ${78 + 6 * mouth} 68 71 L65 81 L57 81 L55 87 L45 87 L43 81 L35 81Z`} fill={ink} />
    <path d="M44 78 L44 83 L49 83 L49 79 M55 79 L55 83 L60 83 L60 77" fill={color} />
  </g>;
  if (family === "santa") return <g data-character-feature="beard">
    <path d="M13 63 Q24 58 31 67 Q50 74 69 67 Q76 58 87 63 C88 79 72 98 50 100 C28 98 12 79 13 63Z" fill="#FFF3DB" />
    <ellipse cx="50" cy="63" rx="7" ry="5.5" fill={tint(color, -0.08)} />
    <path d="M29 71 Q34 61 50 66 Q66 61 71 71 Q61 80 50 72 Q39 80 29 71Z" fill="#FFFDF7" />
    <path d={`M43 80 Q50 ${80 + 5 * mouth} 57 80`} fill="none" stroke="#704737" strokeWidth="2.1" strokeLinecap="round" />
  </g>;
  if (family === "turkey") return <g data-character-feature="beak-wattle">
    <path d="M51 69 C65 70 63 88 56 87 C49 86 54 77 49 74Z" fill="#D95145" />
    <path d="M41 64 Q50 61 59 64 L50 75Z" fill="#FFB548" />
    <path d={`M46 69 Q50 ${70 + 2 * mouth} 54 69`} fill="none" stroke="#8D5930" strokeWidth="1.6" strokeLinecap="round" />
  </g>;
  const bunny = family === "bunny";
  return <g data-character-feature={bunny ? "bunny-muzzle" : "red-nose"}>
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
    <AnimalMouth y={77} mouth={mouth} happy={happy} stroke="#66452D" />
  </g>;
}

/** Hats, scarves and blooms drawn over the head, outside its clip. */
export function CharacterFront({ family, yaw }: { family: CharacterFamily; yaw: number }) {
  const depth = Math.max(Math.abs(Math.cos(yaw)), 0.3);
  const turned = `translate(50 0) scale(${depth} 1) translate(-50 0)`;
  if (family === "cactus") return <g data-character-feature="bloom" transform={`translate(${project(0, yaw).x * 0.3} 0)`}>
    {[0, 72, 144, 216, 288].map((angle) => <ellipse key={angle} cx="61" cy="7" rx="3" ry="5" fill="#FF7FA8"
      transform={`rotate(${angle} 61 11)`} />)}
    <circle cx="61" cy="11" r="2.8" fill="#FFD15C" />
  </g>;
  if (family === "leprechaun") return <g data-character-feature="top-hat" transform={turned}>
    <path d="M30 4 H70 L67 30 H33Z" fill="#2E8B57" />
    <path d="M33 22 H67 L66.4 28 H33.6Z" fill="#1F1F1F" />
    <rect x="45" y="21.5" width="10" height="7" rx="1" fill="none" stroke="#F2C14E" strokeWidth="2" />
    <path d="M14 30 Q50 22 86 30 Q88 36 82 36 Q50 30 18 36 Q12 36 14 30Z" fill="#257A4B" />
    <g fill="#7BD389">
      <circle cx="37" cy="13" r="2.6" /><circle cx="41" cy="13" r="2.6" /><circle cx="39" cy="9.6" r="2.6" />
    </g>
  </g>;
  if (family === "snowman") return <g data-character-feature="earmuffs-scarf">
    <g transform={turned}>
      <path d="M10 52 C10 6 90 6 90 52" fill="none" stroke="#E25A6A" strokeWidth="4.5" strokeLinecap="round" />
      <circle cx="10" cy="54" r="9.5" fill="#F07C8A" />
      <circle cx="90" cy="54" r="9.5" fill="#F07C8A" />
      <circle cx="10" cy="54" r="5" fill="#F7A9B3" />
      <circle cx="90" cy="54" r="5" fill="#F7A9B3" />
    </g>
    <g transform={`translate(${project(0, yaw).x * 0.5} 0)`}>
      <path d="M64 90 L69 107 L79 105 L74 88Z" fill="#2F66AA" />
      <path d="M16 82 Q50 96 84 82 L86 91 Q50 106 14 91Z" fill="#3F7CC8" />
      <path d="M30 89.5 L32 98 M50 92.5 V101 M70 89.5 L68 98" fill="none" stroke="#9CC3EE" strokeWidth="2" strokeLinecap="round" />
    </g>
  </g>;
  if (family === "santa") return <g data-character-feature="santa-cap" transform={turned}>
    <path d="M17 30 C21 9 49 -2 69 6 Q80 8 87 23 L76 28 Q69 12 60 18 L72 31Z" fill="#D34434" />
    <path d="M19 27 Q49 20 74 28 L76 37 Q49 32 17 37Z" fill="#FFF3DB" />
    <circle cx="86" cy="27" r="8" fill="#FFFDF7" />
  </g>;
  if (family === "bunny") return <g data-character-feature="bow" transform={`translate(${project(0, yaw).x * 0.7} 0)`}>
    <path d="M50 91 Q31 80 29 91 Q29 103 48 96 M50 91 Q69 80 71 91 Q71 103 52 96Z" fill="#A888CD" />
    <circle cx="50" cy="93" r="4" fill="#CBB2E5" />
  </g>;
  return null;
}
