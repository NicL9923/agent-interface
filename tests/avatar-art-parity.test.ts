import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { avatarColors, faces, silhouette } from "../src/components/Avatar";
import { characterAnchors, characterHatAnchors, characterHeads, cheekless, seasonalChoices } from "../src/components/character-avatars";
import { avatarShapes, everydayFamilies, type Accessory, type Avatar, type Eyes } from "../src/shared/types";

// AvatarView.swift, CharacterAvatarArt.swift and AvatarPathData.swift repeat the avatar catalog and
// its art. This file is their answer key, checked by ios/AgentInterfaceTests/AvatarArtParityTests.swift.
const file = fileURLToPath(new URL("../ios/AgentInterfaceTests/Avatar/avatar-art.json", import.meta.url));
const instruction = "If the avatar change is intended, run `UPDATE_AVATAR_ART=1 npx vitest run tests/avatar-art-parity.test.ts`, commit the catalog, and match the Swift avatar files until AvatarArtParityTests passes.";

// Listing every key of a Record makes the compiler reject a list that misses a new member.
const modes = Object.keys({ geometric: 0, mascot: 0, portrait: 0 } satisfies Record<Avatar["mode"], 0>);
const eyes: Eyes[] = ["oval", "round", "visor", "spark"];
const accessories: Accessory[] = ["none", "hat", "glasses"];
const complete = <T extends string>(list: T[], all: Record<T, 0>) => expect([...list].sort()).toEqual(Object.keys(all).sort());
complete(eyes, { round: 0, oval: 0, visor: 0, spark: 0 });
complete(accessories, { none: 0, hat: 0, glasses: 0 });

/** Fixed path strings in a web component. Template strings that vary with motion are left out. */
function literalPaths(component: string) {
  const source = readFileSync(fileURLToPath(new URL(`../src/components/${component}`, import.meta.url)), "utf8");
  return [...source.matchAll(/"(M[MLHVQCZl\d.\s,-]*Z?)"/g)].map((match) => match[1].trim());
}

function catalog() {
  const outlines = { ...Object.fromEntries(avatarShapes.map((shape) => [shape, silhouette(shape)])), mascot: silhouette("mascot") };
  const outlined = new Set([...Object.values(outlines), ...Object.values(characterHeads)]);
  return {
    modes,
    shapes: [...avatarShapes],
    everydayFamilies: everydayFamilies.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
    seasonalFamilies: seasonalChoices.map(({ family, label }) => ({ id: family, label })),
    seasonalColors: Object.fromEntries(seasonalChoices.map(({ family, color }) => [family, color])),
    colors: [...avatarColors],
    eyes,
    accessories,
    silhouettes: outlines,
    faces: Object.fromEntries(Object.entries(faces).map(([shape, anchor]) => [shape, { ...anchor }])),
    characterHeads,
    characterAnchors,
    characterHatAnchors,
    cheekless: [...cheekless].sort(),
    // Every fixed path the web draws apart from the outlines above, which are keyed by name.
    paths: [...new Set([...literalPaths("Avatar.tsx"), ...literalPaths("character-avatars.tsx")])].filter((d) => !outlined.has(d)).sort(),
  };
}

describe("native avatar art", () => {
  it("matches the web catalog and path data", () => {
    // One short entry per line keeps an art change readable in review.
    const current = "{\n" + Object.entries(catalog()).map(([key, value]) => Array.isArray(value) && value.length > 4
      ? `${JSON.stringify(key)}: [\n${value.map((item) => " " + JSON.stringify(item)).join(",\n")}\n]`
      : value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 4
        ? `${JSON.stringify(key)}: {\n${Object.entries(value).map(([name, item]) => " " + JSON.stringify(name) + ": " + JSON.stringify(item)).join(",\n")}\n}`
        : `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(",\n") + "\n}\n";
    if (process.env.UPDATE_AVATAR_ART) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, current);
    }
    expect(existsSync(file), instruction).toBe(true);
    expect(readFileSync(file, "utf8") === current, instruction).toBe(true);
  });
});
