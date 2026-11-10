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
  /** The line the rule's selector list starts on, so two rules for one selector in one file stay two. */
  ruleLine: number;
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
  const lines: number[] = [];
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
      const prelude = text.slice(start, index);
      stack.push(prelude.trim().replace(/\s+/g, " "));
      lines.push(lineAt(start + Math.max(0, prelude.search(/\S/))));
      start = index + 1;
    } else if (char === ";" || char === "}") {
      const chunk = text.slice(start, index);
      const colon = chunk.indexOf(":");
      if (colon > 0 && !chunk.trim().startsWith("@")) {
        found.push({
          path,
          line: lineAt(start + chunk.search(/\S/)),
          blocks: [...stack],
          ruleLine: lines.at(-1) ?? 0,
          property: chunk.slice(0, colon).trim().toLowerCase(),
          value: chunk.slice(colon + 1).trim(),
        });
      }
      if (char === "}") { stack.pop(); lines.pop(); }
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
    // animation is not a second rule for the same screen. A rule is its file and the line its selector starts on.
    const rules = new Map<string, Set<string>>();
    for (const declaration of animating.filter(declaration => !removesAnimation(declaration))) {
      const rule = `${declaration.path}:${declaration.ruleLine}`;
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
    // Pairs that already exist, each a base rule and a spring in motion.css. The built app links its stylesheets in
    // the order index (styles.css with motion.css), home, shell, so at equal specificity the later file wins. Read in
    // Chromium on the built app: `.bot-menu` runs home.css's bot-menu-in 140 ms ease-out, `.dock-item` shell.css's
    // dock-in 200 ms and `.toast` shell.css's toast-in 200 ms, so motion.css's springs for those three do not apply
    // today, a defect of its own for a separate change. Only `.jump-latest` runs motion.css's 420 ms spring; its
    // 180 ms base in styles.css loses. Each entry allows exactly one rule from each file it lists, matched by file so
    // an edit that moves lines does not fail it: a known selector that gains a rule, in a new file or as a second in
    // the same one, fails, and one that loses a rule passes.
    const known: Record<string, string[]> = {
      "no-preference | .bot-menu": ["src/app/home.css", "src/motion.css"],
      "no-preference | .dock-item": ["src/app/shell.css", "src/motion.css"],
      "no-preference | .toast": ["src/app/shell.css", "src/motion.css"],
      "no-preference | .jump-latest": ["src/styles.css", "src/motion.css"],
    };
    const beyondKnown = (key: string, owners: Set<string>) => {
      const allowed = [...known[key] ?? []];
      return [...owners].filter(owner => {
        const index = allowed.indexOf(owner.replace(/:\d+$/, ""));
        if (index >= 0) allowed.splice(index, 1);
        return index < 0;
      });
    };
    const repeated = [...rules].filter(([, owners]) => owners.size > 1)
      .map(([key, owners]) => ({ key, unknown: beyondKnown(key, owners) }))
      .filter(({ unknown }) => unknown.length);
    expect(repeated).toEqual([]);
  });

  it("animates the sent message from one rule, only when motion is allowed", () => {
    const outgoing = animating.filter(declaration => selectorsOf(declaration).includes(".message-outgoing"));
    expect(outgoing.map(declaration => ({ motions: motionsOf(declaration), value: declaration.value }))).toEqual([
      { motions: ["no-preference"], value: expect.stringMatching(/^message-send\b/) },
    ]);
  });
});
