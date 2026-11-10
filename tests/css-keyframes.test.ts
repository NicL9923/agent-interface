import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every stylesheet the web client ships. Keyframes share one global namespace, so a second definition of a name
// silently replaces the first wherever it loads later, and an animation naming a missing one does nothing.
const sheets = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sheets(join(dir, entry.name)) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : []);

interface Declaration {
  path: string;
  line: number;
  /** The enclosing blocks, outermost first: at-rule preludes and the rule's selector list. */
  blocks: string[];
  property: string;
  value: string;
}

/** Splits on commas that are not inside parentheses, so `cubic-bezier(0.2, 0.9, …)` stays one part. */
const splitTopLevel = (text: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") depth -= 1;
    else if (text[index] === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  return [...parts, text.slice(start)].map(part => part.trim()).filter(Boolean);
};

/** A small block scanner: enough structure to know which media and selector each declaration sits under. */
const declarations = (path: string, source: string): Declaration[] => {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, " "));
  const found: Declaration[] = [];
  const stack: string[] = [];
  let start = 0;
  let quote = "";
  const lineAt = (index: number) => text.slice(0, index).split("\n").length;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === "{") {
      stack.push(text.slice(start, index).trim().replace(/\s+/g, " "));
      start = index + 1;
    } else if (char === ";" || char === "}") {
      const chunk = text.slice(start, index);
      const colon = chunk.indexOf(":");
      if (colon > 0 && !chunk.trim().startsWith("@")) {
        found.push({
          path,
          line: lineAt(start + chunk.search(/\S/)),
          blocks: [...stack],
          property: chunk.slice(0, colon).trim().toLowerCase(),
          value: chunk.slice(colon + 1).trim(),
        });
      }
      if (char === "}") stack.pop();
      start = index + 1;
    }
  }
  return found;
};

const css = sheets("src").map(path => ({ path, text: readFileSync(path, "utf8") }));
const all = css.flatMap(({ path, text }) => declarations(path, text));
const defined = css.flatMap(({ path, text }) => [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/@keyframes\s+([\w-]+)/g)]
  .map(match => ({ name: match[1], path })));
const animating = all.filter(({ blocks, property }) =>
  (property === "animation" || property === "animation-name") && !blocks.some(block => block.startsWith("@keyframes")));

type Motion = "no-preference" | "reduce";
/** Which motion settings a declaration applies under, from the `prefers-reduced-motion` media around it. */
const motionsOf = ({ blocks }: Declaration): Motion[] => {
  const settings = blocks.flatMap(block => [...block.matchAll(/prefers-reduced-motion\s*:\s*(no-preference|reduce)/g)]
    .map(match => match[1] as Motion));
  return settings.length ? [...new Set(settings)] : ["no-preference", "reduce"];
};
const selectorsOf = ({ blocks }: Declaration): string[] => splitTopLevel(blocks.at(-1) ?? "");
const at = ({ path, line }: Declaration) => `${path}:${line}`;
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
    // A second rule silently loses to whichever loads later, as `.message-outgoing`'s 380 ms rise in styles.css
    // did to motion.css's. `animation: none` under reduced motion removes an animation rather than giving one.
    // Other media, container and supports conditions are part of the context, so a narrow-screen variant of an
    // animation is not a second rule for the same screen.
    const rules = new Map<string, Set<string>>();
    for (const declaration of animating.filter(declaration => !removesAnimation(declaration))) {
      const rule = `${declaration.path} ${declaration.blocks.join(" > ")}`;
      const conditions = declaration.blocks.slice(0, -1)
        .map(block => block.replace(/\(\s*prefers-reduced-motion\s*:\s*[\w-]+\s*\)/g, "").replace(/^@media(\s+and)?\s*$/, ""))
        .filter(Boolean).join(" > ");
      for (const motion of motionsOf(declaration)) {
        for (const selector of selectorsOf(declaration)) {
          const key = [motion, conditions, selector].filter(Boolean).join(" | ");
          rules.set(key, new Set([...rules.get(key) ?? [], rule]));
        }
      }
    }
    const repeated = [...rules].filter(([, owners]) => owners.size > 1).map(([key]) => key);
    // The same dead base rule motion.css's springs replace, as `.message-outgoing` had. Removing these is its own
    // change; a selector that stops repeating may leave this list, and no new one may join it.
    const known = ["no-preference | .bot-menu", "no-preference | .dock-item", "no-preference | .toast", "no-preference | .jump-latest"];
    expect(repeated.filter(key => !known.includes(key))).toEqual([]);
  });

  it("animates the sent message from one rule, only when motion is allowed", () => {
    const outgoing = animating.filter(declaration => selectorsOf(declaration).includes(".message-outgoing"));
    expect(outgoing.map(declaration => ({ motions: motionsOf(declaration), value: declaration.value }))).toEqual([
      { motions: ["no-preference"], value: expect.stringMatching(/^message-send\b/) },
    ]);
  });
});
