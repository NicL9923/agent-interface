import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkBundleBudget, measureBundleClosures } from "../scripts/check-bundle-budget.mjs";
import type { BuildManifestEntry } from "../scripts/precache-plan.mjs";

const manifest: Record<string, BuildManifestEntry> = {
  "index.html": {
    file: "assets/index.js",
    isEntry: true,
    css: ["assets/index.css"],
    imports: ["_vendor.js", "_shared.js"],
  },
  "_vendor.js": {
    file: "assets/vendor.js",
  },
  "_shared.js": {
    file: "assets/shared.js",
    css: ["assets/shared.css"],
    imports: ["_vendor.js"],
  },
  "src/BotSettings.tsx": {
    file: "assets/BotSettings.js",
    isDynamicEntry: true,
    css: ["assets/BotSettings.css"],
    imports: ["_vendor.js", "_shared.js"],
  },
};

const files: Record<string, Buffer> = {
  "assets/index.js": Buffer.from("export const app = 'hello world';\n".repeat(40)),
  "assets/index.css": Buffer.from(".app { color: red; display: grid; }\n".repeat(20)),
  "assets/vendor.js": Buffer.from("export function react() { return 12345; }\n".repeat(60)),
  "assets/shared.js": Buffer.from("export const shared = 'common';\n".repeat(30)),
  "assets/shared.css": Buffer.from(".shared { padding: 8px; }\n".repeat(15)),
  "assets/BotSettings.js": Buffer.from(
    "export function BotSettings() { return null; }\n".repeat(35),
  ),
  "assets/BotSettings.css": Buffer.from(".settings { gap: 12px; }\n".repeat(15)),
};

const readBuffer = (file: string) => {
  const buf = files[file];
  if (!buf) throw new Error(`Missing test file ${file}`);
  return buf;
};

describe("bundle gzip budget check", () => {
  it("measures deduplicated JS and CSS gzip closure sizes across shared transitive imports", () => {
    const [entry] = measureBundleClosures(manifest, readBuffer, ["index.html"]);
    const expectedJs =
      gzipSync(files["assets/index.js"]).length +
      gzipSync(files["assets/vendor.js"]).length +
      gzipSync(files["assets/shared.js"]).length;
    const expectedCss =
      gzipSync(files["assets/index.css"]).length + gzipSync(files["assets/shared.css"]).length;

    expect(entry.jsBytes).toBe(expectedJs);
    expect(entry.cssBytes).toBe(expectedCss);
    expect(entry.totalBytes).toBe(expectedJs + expectedCss);
    expect(entry.files).toEqual([
      "assets/index.css",
      "assets/index.js",
      "assets/shared.css",
      "assets/shared.js",
      "assets/vendor.js",
    ]);
  });

  it("passes when every target closure is at or under its gzip ceiling", () => {
    const [entry, settings] = measureBundleClosures(manifest, readBuffer, [
      "index.html",
      "src/BotSettings.tsx",
    ]);
    const results = checkBundleBudget({
      manifest,
      readBuffer,
      budgets: {
        "index.html": {
          maxJsGzipBytes: entry.jsBytes,
          maxCssGzipBytes: entry.cssBytes,
          maxTotalGzipBytes: entry.totalBytes,
        },
        "src/BotSettings.tsx": {
          maxTotalGzipBytes: settings.totalBytes + 50,
        },
      },
    });
    expect(results).toHaveLength(2);
  });

  it("throws a clear error naming every target and metric that exceeds its gzip ceiling", () => {
    const [entry] = measureBundleClosures(manifest, readBuffer, ["index.html"]);
    expect(() =>
      checkBundleBudget({
        manifest,
        readBuffer,
        budgets: {
          "index.html": {
            maxJsGzipBytes: entry.jsBytes - 1,
            maxCssGzipBytes: entry.cssBytes - 1,
            maxTotalGzipBytes: entry.totalBytes - 2,
          },
        },
      }),
    ).toThrow(
      /Bundle gzip budget exceeded:[\s\S]*index\.html JS gzip[\s\S]*index\.html CSS gzip[\s\S]*index\.html total gzip/,
    );
  });

  it("throws when a budgeted target is missing from Vite's manifest or config has no targets", () => {
    expect(() =>
      checkBundleBudget({
        manifest,
        readBuffer,
        budgets: {
          "src/MissingPanel.tsx": { maxTotalGzipBytes: 10_000 },
        },
      }),
    ).toThrow(/src\/MissingPanel\.tsx.*not found/);

    expect(() =>
      checkBundleBudget({
        manifest,
        readBuffer,
        budgets: {},
      }),
    ).toThrow(/no targets/);
  });

  it("ships a valid scripts/bundle-budget.json with positive ceilings for index.html and lazy screens", () => {
    const config = JSON.parse(
      readFileSync(new URL("../scripts/bundle-budget.json", import.meta.url), "utf8"),
    ) as {
      targets: Record<
        string,
        { maxTotalGzipBytes?: number; maxJsGzipBytes?: number; maxCssGzipBytes?: number }
      >;
    };
    expect(config.targets["index.html"]?.maxTotalGzipBytes).toBeGreaterThan(0);
    expect(config.targets["index.html"]?.maxJsGzipBytes).toBeGreaterThan(0);
    expect(Object.keys(config.targets).length).toBeGreaterThanOrEqual(8);
  });
});
