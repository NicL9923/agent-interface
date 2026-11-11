import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { all, conditionsMeet, conditionsOf, inKeyframes, motionsOf, selectorsOf, type Declaration } from "./helpers/css-declarations";

// src/motion.css overrides other stylesheets at equal specificity by loading after them, and that order holds only
// for the sheets src/main.tsx imports before it in the same chunk. Against any other stylesheet the order is the
// bundler's: on the dev server App's imports run first, so home.css and shell.css come before motion.css, while the
// build splits them into files it links after it, where they win. So a property the motion layer sets on a selector
// must not be set on that selector by any other stylesheet, or dev and the built app show different things.
const before = [...readFileSync("src/main.tsx", "utf8").split(/import\s+["']\.\/motion\.css["']/)[0]
  .matchAll(/import\s+["']\.\/([\w./-]+\.css)["']/g)].map(match => `src/${match[1]}`);

/** Shorthands and their longhands set the same thing, so `background` on one rule meets `background-image` on another. */
const family = (property: string) => {
  if (/^(top|right|bottom|left|inset(-.*)?)$/.test(property)) return "inset";
  if (/^border(-\w+)?-radius$/.test(property)) return "border-radius";
  const shorthand = /^(animation|transition|background|border|margin|padding|font|grid|flex|outline|overflow|list-style|text-decoration|mask)(-|$)/
    .exec(property);
  return shorthand?.[1] ?? property;
};

/**
 * The `background` shorthand sets every background longhand, but two longhands are independent: the rail's color in
 * home.css and the grain image here do not meet. Any other family stays whole, which can only over-report.
 */
const sameBackground = (first: string, second: string) => family(first) !== "background"
  || first === "background" || second === "background" || first === second
  || first.startsWith(`${second}-`) || second.startsWith(`${first}-`);

const overlap = (motion: Declaration, other: Declaration) => family(motion.property) === family(other.property)
  && sameBackground(motion.property, other.property)
  && motionsOf(motion).some(setting => motionsOf(other).includes(setting))
  && conditionsMeet(conditionsOf(motion), conditionsOf(other));

describe("the motion layer's stylesheet order", () => {
  it("is guaranteed only for the sheets main.tsx imports before it", () => {
    // If this list grew to a sheet the build could split out, the check below would stop looking at it.
    expect(before).toEqual(["src/ui.css", "src/styles.css"]);
  });

  it("leaves each property it sets on a selector to it alone", () => {
    const layer = all.filter(declaration => declaration.path === "src/motion.css" && !inKeyframes(declaration));
    const others = all.filter(declaration => declaration.path !== "src/motion.css" && !before.includes(declaration.path)
      && !inKeyframes(declaration));
    // Each entry counts the other stylesheet's declarations that meet the layer's on that selector and property family,
    // so a second box-shadow added to a listed selector in a listed file shows up as a new count.
    const shared = new Map<string, Set<Declaration>>();
    for (const motion of layer) {
      for (const selector of selectorsOf(motion)) {
        for (const other of others.filter(other => selectorsOf(other).includes(selector) && overlap(motion, other))) {
          const key = `${selector} ${family(motion.property)}: ${other.path}`;
          shared.set(key, (shared.get(key) ?? new Set()).add(other));
        }
      }
    }
    expect([...shared].map(([key, found]) => `${key} x${found.size}`).sort()).toEqual([]);
  });

  // The lit edge is one shared rule for selectors with no shadow of their own. A selector that has one gets its own
  // rule with both, because the shared one replaces whatever a sheet before it set, in the build and on the dev server.
  it("lists in the lit-edge rule only selectors no other sheet gives a shadow", () => {
    const edge = all.filter(declaration => declaration.path === "src/motion.css" && declaration.property === "box-shadow"
      && declaration.value === "inset 0 1px 0 var(--depth-edge)");
    expect(edge.length).toBeGreaterThan(0);
    const replaced = edge.flatMap(motion => selectorsOf(motion).flatMap(selector =>
      all.filter(other => other.path !== "src/motion.css" && other.property === "box-shadow" && selectorsOf(other).includes(selector))
        .map(other => `${selector}: ${other.path}:${other.line}`)));
    expect(replaced).toEqual([]);
  });

  // The phone layout ends at `max-width: 620px`, so its counterpart is `width > 620px`. `min-width: 621px` leaves the
  // widths between 620 and 621 px, which a fractional viewport can have, in neither.
  it("pairs the phone layout's width with a range that has no gap", () => {
    expect([...new Set(all.filter(({ blocks }) => blocks.some(block => /min-width:\s*621px/.test(block))).map(({ path }) => path))]).toEqual([]);
  });
});
