import type { Avatar, AvatarShape } from "./types.js";

/**
 * Mascot characters were a second drawn avatar style until November 2026, when every drawn avatar
 * became one flat silhouette with eyes. Each mascot has a shape that takes its place. A seasonal
 * mascot kept a fixed face color; `was` is that color and `now` what its shape wears instead, so a
 * Santa does not become a skin-colored hat. A color someone chose themselves is left alone.
 * ios/AgentInterface/AvatarCatalog.swift repeats this table.
 */
const table = {
  bear: { shape: "bear" },
  fox: { shape: "fox" },
  sprout: { shape: "sprout" },
  panda: { shape: "bear" },
  raccoon: { shape: "fox" },
  owl: { shape: "owl" },
  cactus: { shape: "cactus" },
  dinosaur: { shape: "dino" },
  leprechaun: { shape: "clover", was: "#F2B08B", now: "#1FBF68" },
  bunny: { shape: "bunny" },
  eagle: { shape: "star", was: "#F7F3EA", now: "#FF9800" },
  pumpkin: { shape: "pumpkin" },
  bat: { shape: "bat" },
  ghost: { shape: "ghost" },
  turkey: { shape: "turkey" },
  santa: { shape: "santa-hat", was: "#F2B08B", now: "#FF263C" },
  rudolph: { shape: "reindeer" },
  snowman: { shape: "snowman" },
} satisfies Record<string, MascotShape>;
type MascotShape = { shape: AvatarShape; was?: string; now?: string };
export type LegacyMascotFamily = keyof typeof table;
export const legacyMascots: Record<LegacyMascotFamily, MascotShape> = table;
export const legacyMascotFamilies = Object.keys(table) as [
  LegacyMascotFamily,
  ...LegacyMascotFamily[],
];
type Geometric = Extract<Avatar, { mode: "geometric" }>;
/** A mascot avatar as releases before the change stored and sent it. */
export type LegacyMascotAvatar = Omit<Geometric, "mode" | "shape"> & {
  mode: "mascot";
  family: LegacyMascotFamily;
};

/** What a mascot's fields become. `family` may be anything: one this app never had becomes the blob. */
function shaped(mascot: Record<string, unknown>) {
  const { mode: _, family, ...face } = mascot;
  const known: MascotShape =
    typeof family === "string" && Object.hasOwn(legacyMascots, family)
      ? legacyMascots[family as LegacyMascotFamily]
      : { shape: "blob" };
  const recolored =
    typeof face.color === "string" && face.color.toLowerCase() === known.was?.toLowerCase();
  return {
    ...face,
    mode: "geometric",
    shape: known.shape,
    ...(recolored ? { color: known.now } : {}),
  };
}
/** A valid mascot as the shape that took its place. The server reads a save from an older client with this. */
export const mascotShape = (mascot: LegacyMascotAvatar) => shaped(mascot) as Geometric;

/**
 * A stored avatar as this release draws it. Mascot avatars outlive the release that retired them:
 * in Hermes profile metadata, in this app's store and in rosters saved on devices. Every place
 * that reads a stored avatar passes it through here, and it is lenient because a reader has to
 * draw something: a family this app never had becomes the blob, as it once drew the plain mascot.
 * Anything that is not a mascot, valid or not, comes back unchanged.
 */
export function currentAvatar<T>(value: T): T {
  if (!value || typeof value !== "object" || (value as { mode?: unknown }).mode !== "mascot")
    return value;
  return shaped(value as Record<string, unknown>) as T;
}
