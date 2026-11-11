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

const overlap = (motion: Declaration, other: Declaration) => family(motion.property) === family(other.property)
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
    // Dark mode's lit top edge on raised panels and the rail's grain, which the built app drops today. Their base
    // rules in home.css and shell.css set the same box-shadow and background. That is its own change; when it lands,
    // this list empties. The rail's two are its base background and the phone layout's.
    expect([...shared].map(([key, found]) => `${key} x${found.size}`).sort()).toEqual([
      ".bot-menu box-shadow: src/app/home.css x1",
      ".bot-rail background: src/app/home.css x2",
      ".command-palette box-shadow: src/app/shell.css x1",
      ".home-new-menu box-shadow: src/app/home.css x1",
      ".settings-sheet box-shadow: src/app/home.css x1",
    ]);
  });
});
