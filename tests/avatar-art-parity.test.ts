import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { avatarColors } from "../src/components/Avatar";
import { FACE_RADIUS } from "../src/components/avatar-motion";
import { seasonalColors, shapeGroups, shapeLabel, shapes } from "../src/components/avatar-shapes";
import { legacyMascots } from "../src/shared/avatar-legacy";
import {
  avatarShapeGroups,
  avatarShapes,
  type Accessory,
  type Avatar,
  type Eyes,
} from "../src/shared/types";

// The iOS app draws the same catalog. This test writes two files for it from the web's: the
// Swift catalog the app compiles, and the answer key ios/AgentInterfaceTests/AvatarArtParityTests.swift
// checks the app against, which also covers the fixed paths AvatarPathData.swift repeats by hand.
const file = fileURLToPath(
  new URL("../ios/AgentInterfaceTests/Avatar/avatar-art.json", import.meta.url),
);
const swiftFile = fileURLToPath(
  new URL("../ios/AgentInterface/AvatarCatalog.swift", import.meta.url),
);
const instruction =
  "If the avatar change is intended, run `UPDATE_AVATAR_ART=1 pnpm exec vitest run tests/avatar-art-parity.test.ts`, commit both files it writes, and match AvatarPathData.swift until AvatarArtParityTests passes on the Mac mini.";

// Listing every key of a Record makes the compiler reject a list that misses a new member.
const modes = Object.keys({ geometric: 0, portrait: 0 } satisfies Record<Avatar["mode"], 0>);
const eyes: Eyes[] = ["oval", "round", "visor", "spark"];
const accessories: Accessory[] = ["none", "hat", "glasses"];
const complete = <T extends string>(list: T[], all: Record<T, 0>) =>
  expect([...list].sort()).toEqual(Object.keys(all).sort());
complete(eyes, { round: 0, oval: 0, visor: 0, spark: 0 });
complete(accessories, { none: 0, hat: 0, glasses: 0 });

/** Fixed path strings in a web component. Template strings that vary with motion are left out. */
function literalPaths(component: string) {
  const source = readFileSync(
    fileURLToPath(new URL(`../src/components/${component}`, import.meta.url)),
    "utf8",
  );
  return [...source.matchAll(/"(M[MLHVQCZl\d.\s,-]*Z?)"/g)].map((match) => match[1].trim());
}

function catalog() {
  return {
    modes,
    groups: shapeGroups.map(({ id, label }) => ({
      id,
      label,
      shapes: avatarShapeGroups[id].map((shape) => ({ id: shape, label: shapeLabel(shape) })),
    })),
    seasonalColors,
    legacyMascots,
    colors: [...avatarColors],
    eyes,
    accessories,
    // One line per shape: its outline, then where its face sits.
    shapes: Object.fromEntries(avatarShapes.map((shape) => [shape, shapes[shape]])),
    // Every fixed path the web draws apart from the outlines above, which are keyed by name.
    paths: [...new Set(literalPaths("Avatar.tsx"))].sort(),
  };
}

/** `watering-can` as the Swift name `wateringCan`. */
const swiftName = (id: string) => id.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
const swiftText = (value: string | undefined) =>
  value === undefined ? "nil" : JSON.stringify(value);

/**
 * The catalog as Swift. Every face is written out in full, with the defaults the web applies when
 * a field is absent, so the native rig reads plain numbers.
 */
function swiftCatalog() {
  const face = (shape: (typeof avatarShapes)[number]) => {
    const {
      cx = 50,
      cy,
      scale,
      spacing = 30 * scale,
      radius = FACE_RADIUS,
      top,
      hat,
    } = shapes[shape].face;
    return `Face(cx: ${cx}, cy: ${cy}, scale: ${scale}, spacing: ${spacing}, radius: ${radius}, top: ${top}, hat: ${hat})`;
  };
  return [
    "// Written by tests/avatar-art-parity.test.ts from the web's avatar catalog. Do not edit: run",
    "// `UPDATE_AVATAR_ART=1 pnpm exec vitest run tests/avatar-art-parity.test.ts`. docs/AvatarShapes.md",
    "// says where each shape comes from.",
    "import Foundation",
    "",
    "extension AvatarShape {",
    ...avatarShapes.map(
      (shape) => `  static let ${swiftName(shape)} = Self(rawValue: ${JSON.stringify(shape)})`,
    ),
    "}",
    "",
    "/// Every avatar shape's outline and face, the picker's groups, and the shapes retired mascots became.",
    "enum AvatarCatalog {",
    "  /// Where a silhouette's face sits, like `Face` in src/components/avatar-shapes.ts.",
    "  struct Face: Equatable {",
    "    /// The middle of the eye pair.",
    "    var cx: Double",
    "    var cy: Double",
    "    /// Eye size, against the full-size eyes of the blob.",
    "    var scale: Double",
    "    /// Distance between the eye centers.",
    "    var spacing: Double",
    "    /// The radius of the sphere the face turns on: the half-width of the part the face sits on.",
    "    var radius: Double",
    "    /// The top of the head and the size of a hat on it.",
    "    var top: Double",
    "    var hat: Double",
    "  }",
    "  struct Art {",
    "    /// The outline in a 0-100 box, as absolute M L H V Q C Z. The first contour is the outside;",
    "    /// any later one is a hole.",
    "    let path: String",
    "    let face: Face",
    "  }",
    "  struct Group {",
    "    let id: String",
    "    let label: String",
    "    let shapes: [AvatarShape]",
    "  }",
    "  /// The shape picker's sections, in order.",
    "  static let groups: [Group] = [",
    ...shapeGroups.map(
      ({ id, label }) =>
        `    Group(id: ${JSON.stringify(id)}, label: ${JSON.stringify(label)}, shapes: [${avatarShapeGroups[id].map((shape) => "." + swiftName(shape)).join(", ")}]),`,
    ),
    "  ]",
    "  /// The name under a shape's tile, and what VoiceOver calls it.",
    "  static let labels: [AvatarShape: String] = [",
    ...avatarShapes.map(
      (shape) => `    .${swiftName(shape)}: ${JSON.stringify(shapeLabel(shape))},`,
    ),
    "  ]",
    "  /// The color a seasonal shape arrives in when picked.",
    "  static let seasonalColors: [AvatarShape: String] = [",
    ...Object.entries(seasonalColors).map(
      ([shape, color]) => `    .${swiftName(shape)}: ${JSON.stringify(color)},`,
    ),
    "  ]",
    "  /// The shape that took each retired mascot's place. A seasonal mascot kept a fixed face color:",
    "  /// `was` is that color and `now` what its shape wears instead. See src/shared/avatar-legacy.ts.",
    "  static let legacyMascots: [String: (shape: AvatarShape, was: String?, now: String?)] = [",
    ...Object.entries(legacyMascots).map(
      ([family, { shape, was, now }]) =>
        `    ${JSON.stringify(family)}: (.${swiftName(shape)}, ${swiftText(was)}, ${swiftText(now)}),`,
    ),
    "  ]",
    "  static let art: [AvatarShape: Art] = [",
    ...avatarShapes.flatMap((shape) => [
      `    .${swiftName(shape)}: Art(`,
      `      path: ${JSON.stringify(shapes[shape].path)},`,
      `      face: ${face(shape)}),`,
    ]),
    "  ]",
    "}",
    "",
  ].join("\n");
}

describe("native avatar art", () => {
  it("matches the web catalog and path data", () => {
    // One short entry per line keeps an art change readable in review.
    const current =
      "{\n" +
      Object.entries(catalog())
        .map(([key, value]) =>
          Array.isArray(value) && value.length > 4
            ? `${JSON.stringify(key)}: [\n${value.map((item) => " " + JSON.stringify(item)).join(",\n")}\n]`
            : value &&
                typeof value === "object" &&
                !Array.isArray(value) &&
                Object.keys(value).length > 4
              ? `${JSON.stringify(key)}: {\n${Object.entries(value)
                  .map(([name, item]) => " " + JSON.stringify(name) + ": " + JSON.stringify(item))
                  .join(",\n")}\n}`
              : `${JSON.stringify(key)}: ${JSON.stringify(value)}`,
        )
        .join(",\n") +
      "\n}\n";
    if (process.env.UPDATE_AVATAR_ART) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, current);
      writeFileSync(swiftFile, swiftCatalog());
    }
    expect(existsSync(file), instruction).toBe(true);
    expect(readFileSync(file, "utf8") === current, instruction).toBe(true);
    expect(existsSync(swiftFile), instruction).toBe(true);
    expect(readFileSync(swiftFile, "utf8") === swiftCatalog(), instruction).toBe(true);
  });
});
