import { describe, expect, it } from "vitest";
import { all, at, conditionsMeet, conditionsOf, css, inKeyframes, motionsOf, selectorsOf, splitTopLevel, type Declaration } from "./helpers/css-declarations";

// Keyframes share one global namespace, so a second definition of a name silently replaces the first wherever it
// loads later, and an animation naming a missing one does nothing.
const defined = css.flatMap(({ path, text }) => [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/@keyframes\s+([\w-]+)/g)]
  .map(match => ({ name: match[1], path })));
const animating = all.filter(declaration =>
  (declaration.property === "animation" || declaration.property === "animation-name") && !inKeyframes(declaration));
const removesAnimation = ({ value }: Declaration) => /^none(\s*!important)?$/i.test(value);

describe("CSS keyframes", () => {
  it("defines each keyframe name once across the app's stylesheets", () => {
    const seen = new Map<string, string[]>();
    for (const { name, path } of defined) seen.set(name, [...seen.get(name) ?? [], path]);
    expect([...seen].filter(([, paths]) => paths.length > 1)).toEqual([]);
  });

  it("names only keyframes that exist", () => {
    const names = new Set(defined.map(({ name }) => name));
    // Each animation layer must name a defined keyframe. Whatever else the layer holds (durations, easings,
    // keywords this test has never heard of) does not matter; a layer naming no keyframe at all is a typo or
    // a deleted keyframe. `none`, CSS-wide keywords and a layer that is only a custom property are left alone.
    const unnamed = animating.flatMap(declaration => splitTopLevel(declaration.value.replace(/!important$/i, ""))
      .filter(layer => !/^(none|inherit|initial|unset|revert|revert-layer)$/i.test(layer) && !/^var\(.*\)$/.test(layer)
        && !layer.split(/\s+/).some(token => names.has(token)))
      .map(layer => `${at(declaration)} ${layer}`));
    expect(unnamed).toEqual([]);
  });

  it("gives no selector an animation from more than one rule under the same motion setting", () => {
    // A second rule silently loses to whichever loads later, and the built app's stylesheet order is not the source's:
    // home.css and shell.css link after motion.css there, so their 140 to 220 ms ease-outs on `.bot-menu`,
    // `.dock-item`, `.toast`, `.command-palette[open]` and `.settings-sheet[open]` beat the motion layer's springs,
    // while the dev server ran the springs. `animation: none` under reduced motion removes an animation rather than
    // giving one. Media, container and supports conditions other than the motion setting are part of the context: a
    // rule with none meets every other, as the unconditional palette rule met the desktop spring, and two different
    // conditions are taken as different screens. A conditioned rule later in the same file as an unconditioned one is
    // an override, such as a phone variant, and both stay live. A rule is its file and the line its selector starts on.
    type Owner = { path: string; line: number; conditions: string };
    const rules = new Map<string, Owner[]>();
    for (const declaration of animating.filter(declaration => !removesAnimation(declaration))) {
      const owner = { path: declaration.path, line: declaration.ruleLine, conditions: conditionsOf(declaration) };
      for (const motion of motionsOf(declaration)) {
        for (const selector of selectorsOf(declaration)) {
          const key = `${motion} | ${selector}`;
          const owners = rules.get(key) ?? [];
          if (!owners.some(({ path, line }) => path === owner.path && line === owner.line)) owners.push(owner);
          rules.set(key, owners);
        }
      }
    }
    const override = (base: Owner, variant: Owner) =>
      base.path === variant.path && !base.conditions && !!variant.conditions && variant.line > base.line;
    const clash = (first: Owner, second: Owner) => (first.path !== second.path || first.line !== second.line)
      && conditionsMeet(first.conditions, second.conditions) && !override(first, second) && !override(second, first);
    const named = ({ path, line, conditions }: Owner) => `${path}:${line} [${conditions}]`;
    const repeated = [...rules].flatMap(([key, owners]) => owners.flatMap((first, index) => owners.slice(index + 1)
      .filter(second => clash(first, second)).map(second => `${key}: ${named(first)} and ${named(second)}`)));
    expect(repeated).toEqual([]);
  });

  it("animates the sent message from one rule, only when motion is allowed", () => {
    const outgoing = animating.filter(declaration => selectorsOf(declaration).includes(".message-outgoing"));
    expect(outgoing.map(declaration => ({ motions: motionsOf(declaration), value: declaration.value }))).toEqual([
      { motions: ["no-preference"], value: expect.stringMatching(/^message-send\b/) },
    ]);
  });
});
