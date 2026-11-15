#!/usr/bin/env node
// Computes home's seasonal accents: each theme's --accent and --accent-soft shifted toward the season's
// color at the base token's own WCAG luminance, so no contrast ratio drops below the unseasoned theme's.
// `node .agents/tools/season-tint.mjs` prints the block; `--write` replaces it in src/motion.css.
// tests/season-tint.test.ts fails when the CSS and this computation disagree.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Share of the season's hue in the accent and in the soft accent. */
export const SHARE = { accent: 0.12, soft: 0.18 };
export const BEGIN = "/* season-tint:begin */";
export const END = "/* season-tint:end */";

const channel = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
const linear = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const gamma = c => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
const toHex = rgb => "#" + rgb.map(c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0")).join("");

/** WCAG 2 relative luminance of a #rrggbb color. */
export function luminance(hex) {
  const [r, g, b] = channel(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function oklab(hex) {
  const [r, g, b] = channel(hex).map(linear);
  const [l, m, s] = [
    0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
    0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
  ].map(Math.cbrt);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]) {
  const [l, m, s] = [L + 0.3963377774 * a + 0.2158037573 * b, L - 0.1055613458 * a - 0.0638541728 * b, L - 0.0894841775 * a - 1.291485548 * b].map(x => x ** 3);
  return toHex([
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(c => gamma(Math.min(1, Math.max(0, c)))));
}

/**
 * `base` moved `share` of the way toward `season`'s hue in OKLab, at `base`'s luminance. `darker` picks the
 * side of that luminance the rounded color may land on: darker for a color that must stand out against
 * lighter surroundings, lighter for the reverse.
 */
export function tint(base, season, share, darker) {
  const [, a0, b0] = oklab(base), [, a1, b1] = oklab(season);
  const a = a0 + (a1 - a0) * share, b = b0 + (b1 - b0) * share, target = luminance(base);
  let low = 0, high = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (luminance(fromOklab([mid, a, b])) < target) low = mid; else high = mid;
  }
  for (let L = (low + high) / 2, i = 0; i < 400; i++, L += darker ? -0.0005 : 0.0005) {
    const hex = fromOklab([L, a, b]);
    if (darker ? luminance(hex) <= target : luminance(hex) >= target) return hex;
  }
  throw new Error(`No ${darker ? "darker" : "lighter"} tint of ${base} toward ${season}`);
}

const token = (css, selector, name) => {
  const block = css.slice(css.indexOf(selector + " {"));
  const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6});`).exec(block.slice(0, block.indexOf("}")));
  if (!match) throw new Error(`${selector} has no ${name}`);
  return match[1];
};

/** The theme tokens and season colors the block is computed from. */
export function inputs(styles, motion) {
  const themes = {
    light: { accent: token(styles, ":root", "--accent"), soft: token(styles, ":root", "--accent-soft") },
    dark: { accent: token(styles, ':root[data-theme="dark"]', "--accent"), soft: token(styles, ':root[data-theme="dark"]', "--accent-soft") },
  };
  const seasons = [...motion.matchAll(/\.bot-rail\[data-season="(\w+)"\] \{ --season-color: (#[0-9a-f]{6}); \}/g)].map(m => ({ name: m[1], color: m[2] }));
  if (!seasons.length) throw new Error("src/motion.css names no --season-color");
  return { themes, seasons };
}

/** Each season's light and dark accent and soft accent. Light text sits on light fills, dark on dark. */
export function tints({ themes, seasons }) {
  return seasons.map(({ name, color }) => ({
    name,
    accent: [tint(themes.light.accent, color, SHARE.accent, true), tint(themes.dark.accent, color, SHARE.accent, false)],
    soft: [tint(themes.light.soft, color, SHARE.soft, false), tint(themes.dark.soft, color, SHARE.soft, true)],
  }));
}

export function block(rows) {
  const lines = rows.map(({ name, accent, soft }) =>
    `  .bot-rail[data-season="${name}"] { --season-accent: light-dark(${accent[0]}, ${accent[1]}); --season-accent-soft: light-dark(${soft[0]}, ${soft[1]}); }`);
  return [BEGIN, "@supports (color: light-dark(#000, #fff)) {", ...lines, "}", END].join("\n");
}

export const root = fileURLToPath(new URL("../..", import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const motionPath = root + "src/motion.css", motion = readFileSync(motionPath, "utf8");
  const next = block(tints(inputs(readFileSync(root + "src/styles.css", "utf8"), motion)));
  if (!process.argv.includes("--write")) console.log(next);
  else {
    const start = motion.indexOf(BEGIN), end = motion.indexOf(END);
    if (start < 0 || end < start) throw new Error("src/motion.css has no season-tint markers");
    writeFileSync(motionPath, motion.slice(0, start) + next + motion.slice(end + END.length));
  }
}
