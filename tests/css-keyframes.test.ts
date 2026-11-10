import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every stylesheet the web client ships. Keyframes share one global namespace, so a second definition of a name
// silently replaces the first wherever it loads later, and an animation naming a missing one does nothing.
const sheets = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sheets(join(dir, entry.name)) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : []);
const css = sheets("src").map(path => ({ path, text: readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "") }));
const defined = css.flatMap(({ path, text }) => [...text.matchAll(/@keyframes\s+([\w-]+)/g)].map(match => ({ name: match[1], path })));
/** The keyframe names animations use: the first name in each `animation` shorthand, and `animation-name`. */
const used = css.flatMap(({ path, text }) => [...text.matchAll(/(?<![\w-])animation(?:-name)?\s*:\s*([^;}]+)/g)]
  .flatMap(match => match[1].split(",").map(part => part.trim().split(/\s+/).find(token => /^[a-z][\w-]*$/i.test(token)
    && !/^(none|inherit|initial|unset|revert|infinite|alternate|alternate-reverse|reverse|normal|forwards|backwards|both|running|paused|linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/.test(token))))
  .filter((name): name is string => !!name).map(name => ({ name, path })));

describe("CSS keyframes", () => {
  it("defines each keyframe name once across the app's stylesheets", () => {
    const seen = new Map<string, string[]>();
    for (const { name, path } of defined) seen.set(name, [...seen.get(name) ?? [], path]);
    expect([...seen].filter(([, paths]) => paths.length > 1)).toEqual([]);
  });

  it("names only keyframes that exist", () => {
    const names = new Set(defined.map(({ name }) => name));
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter(({ name }) => !names.has(name))).toEqual([]);
  });
});
