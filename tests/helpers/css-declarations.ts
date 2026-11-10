import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Every stylesheet the web client ships, read as declarations that know their file, line, selector and the at-rules
// around them. Enough structure for the cascade checks in tests/css-keyframes.test.ts and tests/motion-layer.test.ts.
const sheets = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sheets(join(dir, entry.name)) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : []);

export interface Declaration {
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
export const splitTopLevel = (text: string): string[] => {
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

export const css = sheets("src").map(path => ({ path, text: readFileSync(path, "utf8") }));
export const all = css.flatMap(({ path, text }) => declarations(path, text));
export const inKeyframes = ({ blocks }: Declaration) => blocks.some(block => block.startsWith("@keyframes"));

export type Motion = "no-preference" | "reduce";
/** Which motion settings a declaration applies under, from the `prefers-reduced-motion` media around it. */
export const motionsOf = ({ blocks }: Declaration): Motion[] => {
  const settings = blocks.flatMap(block => [...block.matchAll(/prefers-reduced-motion\s*:\s*(no-preference|reduce)/g)]
    .map(match => match[1] as Motion));
  return settings.length ? [...new Set(settings)] : ["no-preference", "reduce"];
};
export const selectorsOf = ({ blocks }: Declaration): string[] => splitTopLevel(blocks.at(-1) ?? "");
export const at = ({ path, line }: Declaration) => `${path}:${line}`;

/** The media, container and supports conditions around a declaration other than its motion setting, as one string. */
export const conditionsOf = ({ blocks }: Declaration): string => blocks.slice(0, -1)
  .map(block => block.replace(/\(\s*prefers-reduced-motion\s*:\s*[\w-]+\s*\)/g, "").replace(/^@media(\s+and)?\s*$/, ""))
  .filter(Boolean).join(" > ");

/**
 * Whether two rules can apply to the same screen. A rule with no condition applies everywhere, so it meets every
 * other. Two different conditions are taken as different screens, such as a phone variant beside a desktop one.
 */
export const conditionsMeet = (first: string, second: string) => !first || !second || first === second;
