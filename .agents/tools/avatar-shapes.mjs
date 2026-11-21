#!/usr/bin/env node
// Builds src/components/avatar-shape-art.ts from the avatar definitions in
// .agents/tools/avatar-shapes/. Each definition is one silhouette path in a 0-100 box plus where
// the eyes sit, in the Open Bot Avatar format (https://github.com/DominikScholz/open-bot-avatar,
// MIT), so an avatar made in that project's editor imports unchanged.
//
// The avatar rig fills, strokes, clips and morphs one outline, and the iOS reader takes only
// absolute M L C Z. So this merges a definition's overlapping parts into their true outline,
// turns arcs into cubics, scales the drawing to the size of the app's own shapes, and measures
// the face anchor the rig needs.
//
//   npm install --no-save paper@0.12.18     # the one dependency, kept out of package.json
//   node .agents/tools/avatar-shapes.mjs            # rewrite the art file
//   node .agents/tools/avatar-shapes.mjs --check    # exit 1 if the art file is stale
//   node .agents/tools/avatar-shapes.mjs --sheet out.html   # also write a contact sheet
//
// A manifest entry may set "face": { "radius": n, "hat": n } where the measurement is fooled: a
// part beside the face at eye level, such as a bat's wings, widens the radius, and ears or horns
// beside the head widen the hat.
//
// To add an avatar: save its JSON as avatar-shapes/definitions/<id>.json, list it in
// avatar-shapes/manifest.json, run this, then add the id to avatarShapes in src/shared/types.ts
// and to the catalog in src/components/avatar-shapes.ts. The compiler names every place that
// still misses it.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const source = join(here, "avatar-shapes");
const output = join(root, "src", "components", "avatar-shape-art.ts");

let paper;
try {
  paper = createRequire(join(root, "package.json"))(
    process.env.PAPER_PATH ?? "paper/dist/paper-core.js",
  );
} catch {
  console.error("This tool needs paper.js: npm install --no-save paper@0.12.18");
  process.exit(2);
}
paper.setup(new paper.Size(100, 100));

const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
const round = (value, places = 2) => Number(value.toFixed(places));
const text = (value) => String(round(value));

/** The filled outline of a definition: overlapping parts merged, holes kept, scaled about the center. */
function outline(definition, scale) {
  const drawn = new paper.CompoundPath({ pathData: definition.body.path, fillRule: "nonzero" });
  const merged = drawn.unite(new paper.Path(), { insert: false });
  merged.scale(scale, new paper.Point(50, 50));
  const contours = (merged.children ?? [merged])
    .filter((contour) => Math.abs(contour.area) > 0.5)
    .sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  const d = contours
    .map((contour) => {
      const first = contour.firstSegment.point;
      const parts = [`M${text(first.x)} ${text(first.y)}`];
      for (const curve of contour.curves) {
        const { point1, point2, handle1, handle2 } = curve;
        // The closing command draws the last straight edge.
        if (curve === contour.lastCurve && curve.isStraight()) continue;
        parts.push(
          curve.isStraight()
            ? `L${text(point2.x)} ${text(point2.y)}`
            : `C${text(point1.x + handle1.x)} ${text(point1.y + handle1.y)} ${text(point2.x + handle2.x)} ${text(point2.y + handle2.y)} ${text(point2.x)} ${text(point2.y)}`,
        );
      }
      return parts.join(" ") + "Z";
    })
    .join(" ");
  // The rounded string is what ships, so measure and check that, not the exact geometry.
  const shipped = new paper.CompoundPath({ pathData: d, fillRule: "nonzero" });
  drawn.scale(scale, new paper.Point(50, 50));
  let filled = 0;
  let differs = 0;
  // Off the half-unit grid, where a drawing's straight edges tend to sit and a point would be on one.
  for (let x = 0.317; x < 100; x += 1)
    for (let y = 0.683; y < 100; y += 1) {
      const point = new paper.Point(x, y);
      const before = drawn.contains(point);
      if (before) filled += 1;
      if (before !== shipped.contains(point)) differs += 1;
    }
  if (differs > filled * 0.004)
    throw new Error(
      `${definition.id}: the merged outline differs from the drawing at ${differs} of ${filled} points`,
    );
  return { d, shape: shipped };
}

/** Where the rig draws the face, measured on the outline. */
function anchor(definition, shape, scale, overrides = {}) {
  const at = (value) => 50 + (value - 50) * scale;
  const cx = at(definition.eyes.x);
  const cy = at(definition.eyes.y);
  const spacing = definition.eyes.spacing * scale;
  const inside = (x, y) => shape.contains(new paper.Point(x, y));
  const reach = (direction, y) => {
    let distance = 0;
    while (distance < 60 && inside(cx + direction * (distance + 0.25), y)) distance += 0.25;
    return distance;
  };
  // The face turns on a sphere as wide as the part it sits on, so the eyes stay on that part.
  const radius =
    overrides.radius ??
    Math.min(42, Math.max(spacing / 2 + 6, Math.min(reach(-1, cy), reach(1, cy))));
  // A hat sits on the top of that part: as far up as the body stays as wide as the eyes.
  let top = cy;
  while (top > 0 && inside(cx - spacing / 2, top - 0.25) && inside(cx + spacing / 2, top - 0.25))
    top -= 0.25;
  const brim = Math.min(reach(-1, top + 7), reach(1, top + 7)) * 2;
  const eyes = 0.64 * definition.eyes.scale * scale;
  // The rig sinks a hat 15 units per unit of size into the head and its brim hangs 5 lower. Eyes
  // near the top of the head would end up under it, so the hat rides higher, by up to 10 units
  // per unit of size, where the brim only rests on the head, and beyond that it shrinks.
  const room = cy - 12.5 * eyes - 1 - top;
  const hat = Math.min(
    overrides.hat ?? Math.round(Math.min(1, Math.max(0.35, brim / 80)) * 20) / 20,
    Math.max(0.3, Math.floor(room * 2) / 20),
  );
  return {
    cx: round(cx, 1),
    cy: round(cy, 1),
    // An Open Bot Avatar eye is 16 units tall at scale 1 as drawn; this rig's pill is 25.
    scale: round(eyes),
    spacing: round(spacing, 1),
    radius: round(radius, 1),
    top: round(Math.min(top, top + room - 20 * hat), 1),
    hat,
  };
}

const shapes = manifest.shapes.map(({ id, face }) => {
  const definition = JSON.parse(readFileSync(join(source, "definitions", `${id}.json`), "utf8"));
  if (definition.id !== id) throw new Error(`${id}.json names itself ${definition.id}`);
  const { d, shape } = outline(definition, manifest.scale);
  return {
    id,
    name: definition.name,
    path: d,
    face: anchor(definition, shape, manifest.scale, face),
  };
});

const file =
  `// Generated by .agents/tools/avatar-shapes.mjs from .agents/tools/avatar-shapes/. Do not edit.\n` +
  `// Each outline is one avatar definition with its parts merged, scaled by ${manifest.scale} about the center.\n` +
  `export const shapeArt = {\n` +
  shapes
    .map(
      ({ id, path, face }) =>
        `  ${JSON.stringify(id)}: {\n    path: ${JSON.stringify(path)},\n    face: ${JSON.stringify(
          face,
        )
          .replace(/"(\w+)":/g, " $1: ")
          .replace("}", " }")},\n  },\n`,
    )
    .join("") +
  `} as const;\n`;

const sheet = process.argv.indexOf("--sheet");
if (sheet > 0) {
  const tile = ({ id, name, path, face }, size) => {
    const eye = (side) =>
      `<rect x="${face.cx + (side * face.spacing) / 2 - 5.5 * face.scale}" y="${face.cy - 12.5 * face.scale}" width="${11 * face.scale}" height="${25 * face.scale}" rx="${5.5 * face.scale}" fill="#fff9ee"/>`;
    return `<figure><svg viewBox="-8 -8 116 116" width="${size}" height="${size}"><path d="${path}" fill="#1084FE"/>${eye(-1)}${eye(1)}</svg><figcaption>${size > 40 ? `${name} <small>${id}</small>` : ""}</figcaption></figure>`;
  };
  writeFileSync(
    process.argv[sheet + 1],
    `<!doctype html><meta charset="utf-8"><style>body{font:12px system-ui;background:#f6f1e7;margin:16px}section{display:flex;flex-wrap:wrap;gap:8px}figure{margin:0;text-align:center;width:112px}small{display:block;color:#777}.small figure{width:36px}</style>` +
      `<section>${shapes.map((shape) => tile(shape, 104)).join("")}</section><section class="small">${shapes.map((shape) => tile(shape, 28)).join("")}</section>`,
  );
}

if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== file) {
    console.error(
      "src/components/avatar-shape-art.ts is stale: run node .agents/tools/avatar-shapes.mjs",
    );
    process.exit(1);
  }
} else {
  writeFileSync(output, file);
  console.log(`Wrote ${shapes.length} shapes to src/components/avatar-shape-art.ts`);
}
