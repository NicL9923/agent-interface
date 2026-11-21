import type { AvatarShape } from "./types.js";

/**
 * Mascot characters were a second drawn avatar style until November 2026, when every drawn avatar
 * became one flat silhouette with eyes. Each mascot has a shape that takes its place. A seasonal
 * mascot kept a fixed face color; `was` is that color and `now` what its shape wears instead, so a
 * Santa does not become a skin-colored hat. A color someone chose themselves is left alone.
 * ios/AgentInterface/Models.swift repeats this table.
 */
export const legacyMascots: Record<string, { shape: AvatarShape; was?: string; now?: string }> = {
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
};

/**
 * A stored or received avatar as this release draws it. Mascot avatars outlive the release that
 * retired them: in Hermes profile metadata, in this app's store, in rosters saved on devices, and
 * in saves from iOS builds that still offer them. Every place that reads an avatar it did not just
 * validate passes it through here. Anything else, valid or not, comes back unchanged.
 */
export function currentAvatar<T>(value: T): T {
  if (!value || typeof value !== "object" || (value as { mode?: unknown }).mode !== "mascot")
    return value;
  const { mode: _, family, ...face } = value as Record<string, unknown>;
  const known =
    typeof family === "string" && Object.hasOwn(legacyMascots, family)
      ? legacyMascots[family]
      : // A family this release never had drew as the plain mascot head; the plain shape is the blob.
        { shape: "blob" as const };
  const recolored =
    typeof face.color === "string" && face.color.toLowerCase() === known.was?.toLowerCase();
  return {
    ...face,
    mode: "geometric",
    shape: known.shape,
    ...(recolored ? { color: known.now } : {}),
  } as T;
}
