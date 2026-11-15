import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The repository tool is plain JavaScript without declarations.
import { BEGIN, END, block, inputs, tints } from "../.agents/tools/season-tint.mjs";

const read = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8");
const styles = read("src/styles.css"), motion = read("src/motion.css");

// WCAG 2 contrast, written out here rather than imported so the check does not share the generator's math.
const channel = (hex: string, i: number) => {
  const c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = (hex: string) => 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
const contrast = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

const tokens = (selector: string) => {
  const start = styles.indexOf(selector + " {");
  const body = styles.slice(start, styles.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6});/g)].map(m => [m[1], m[2]])) as Record<string, string>;
};

describe("home's seasonal accents", () => {
  const { themes, seasons } = inputs(styles, motion);
  const rows = tints({ themes, seasons }) as { name: string; accent: [string, string]; soft: [string, string] }[];

  it("match the generator's output for the current theme tokens and season colors", () => {
    const current = motion.slice(motion.indexOf(BEGIN), motion.indexOf(END) + END.length);
    expect(current, "Run `node .agents/tools/season-tint.mjs --write`").toBe(block(rows));
  });

  it("read the dark tokens the system dark theme also uses", () => {
    const system = tokens('  :root[data-theme="system"]');
    expect([system["--accent"], system["--accent-soft"]]).toEqual([themes.dark.accent, themes.dark.soft]);
  });

  // Every pair the rail draws with the accent: the accent against each surface, as text or as a fill under
  // surface-colored text, and against its own soft fill; and ink on the soft fill. None may lose contrast
  // to the season.
  it.each([["light", 0, ":root"], ["dark", 1, ':root[data-theme="dark"]']] as const)("keep every %s contrast at or above the unseasoned theme's", (_, side, selector) => {
    const theme = tokens(selector);
    const pairs = (accent: string, soft: string) => [
      ...[theme["--surface"]!, theme["--rail"]!, theme["--raised"]!, soft].map(fill => contrast(accent, fill)),
      contrast(theme["--ink"]!, soft),
    ];
    const base = pairs(theme["--accent"]!, theme["--accent-soft"]!);
    for (const row of rows) {
      const seasonal = pairs(row.accent[side], row.soft[side]);
      seasonal.forEach((ratio, i) => expect(ratio, `${row.name} pair ${i}`).toBeGreaterThanOrEqual(base[i]!));
    }
  });

  it("give every season its own visible shift from the base accent", () => {
    const colors = rows.flatMap(row => [...row.accent, ...row.soft]);
    expect(new Set(colors).size).toBe(colors.length);
    expect(colors).not.toContain(themes.light.accent);
    expect(colors).not.toContain(themes.dark.soft);
  });
});
