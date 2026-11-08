import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// Font sizes are rem so the browser's text-size setting reaches the whole UI. A glyph sized to a
// fixed px box may stay px with a `/* px: reason */` comment on the same line. The avatar specimen
// is a standalone design page, not part of the app.
const cssFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? cssFiles(join(dir, entry.name)) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : []);

it("sizes text in rem, not px, so it follows the browser text-size setting", () => {
  const offenders = cssFiles("src").filter(file => !file.endsWith("avatar-specimen.css")).flatMap(file =>
    readFileSync(file, "utf8").split("\n").flatMap((line, index) => {
      if (line.includes("/* px:")) return [];
      const sizes = [...line.matchAll(/\bfont(?:-size)?:[^;}]*/g)].map(match => match[0]);
      // Inputs keep a 16px floor so iOS Safari does not zoom into them.
      return sizes.some(size => /\d(?:\.\d+)?px/.test(size.replace("max(16px, 1rem)", ""))) ? [`${file}:${index + 1}: ${line.trim()}`] : [];
    }));
  expect(offenders).toEqual([]);
});
