import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * Collects all static JS and CSS files reachable from `entryKey` in Vite's build manifest.
 */
export function closureFiles(manifest, entryKey) {
  const seenKeys = new Set();
  const files = new Set();
  const visit = (key) => {
    if (seenKeys.has(key) || !manifest[key]) return;
    seenKeys.add(key);
    const entry = manifest[key];
    if (entry.file) files.add(entry.file);
    for (const css of entry.css ?? []) files.add(css);
    for (const next of entry.imports ?? []) visit(next);
  };
  visit(entryKey);
  return [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Measures gzipped JS, CSS, and total byte sizes for each manifest entry's static import closure.
 */
export function measureBundleClosures(manifest, readBuffer, keys) {
  const gzipCache = new Map();
  const gzipBytesOf = (file) => {
    if (!gzipCache.has(file)) {
      gzipCache.set(file, gzipSync(readBuffer(file)).length);
    }
    return gzipCache.get(file);
  };

  return keys.map((key) => {
    if (!manifest[key]) {
      throw new Error(`Bundle budget target "${key}" was not found in Vite's build manifest.`);
    }
    const files = closureFiles(manifest, key);
    let jsBytes = 0;
    let cssBytes = 0;
    for (const file of files) {
      if (file.endsWith(".js")) jsBytes += gzipBytesOf(file);
      else if (file.endsWith(".css")) cssBytes += gzipBytesOf(file);
    }
    return {
      key,
      jsBytes,
      cssBytes,
      totalBytes: jsBytes + cssBytes,
      files,
    };
  });
}

const formatKiB = (bytes) => `${(bytes / 1024).toFixed(2)} KiB (${bytes} B)`;

/**
 * Verifies every budgeted manifest entry's static closure stays within its gzip ceilings.
 */
export function checkBundleBudget({ manifest, readBuffer, budgets }) {
  const entries = Object.entries(budgets);
  if (!entries.length) {
    throw new Error("Bundle budget configuration has no targets.");
  }
  const measurements = measureBundleClosures(
    manifest,
    readBuffer,
    entries.map(([key]) => key),
  );
  const failures = [];

  for (const measured of measurements) {
    const limits = budgets[measured.key];
    if (typeof limits.maxJsGzipBytes === "number" && measured.jsBytes > limits.maxJsGzipBytes) {
      failures.push(
        `${measured.key} JS gzip ${formatKiB(measured.jsBytes)} exceeds budget ${formatKiB(limits.maxJsGzipBytes)} (+${measured.jsBytes - limits.maxJsGzipBytes} B)`,
      );
    }
    if (typeof limits.maxCssGzipBytes === "number" && measured.cssBytes > limits.maxCssGzipBytes) {
      failures.push(
        `${measured.key} CSS gzip ${formatKiB(measured.cssBytes)} exceeds budget ${formatKiB(limits.maxCssGzipBytes)} (+${measured.cssBytes - limits.maxCssGzipBytes} B)`,
      );
    }
    if (
      typeof limits.maxTotalGzipBytes === "number" &&
      measured.totalBytes > limits.maxTotalGzipBytes
    ) {
      failures.push(
        `${measured.key} total gzip ${formatKiB(measured.totalBytes)} exceeds budget ${formatKiB(limits.maxTotalGzipBytes)} (+${measured.totalBytes - limits.maxTotalGzipBytes} B)`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`Bundle gzip budget exceeded:\n- ${failures.join("\n- ")}`);
  }

  return measurements;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const distDir = join(root, "dist/client");
  const manifest = JSON.parse(readFileSync(join(distDir, ".vite/manifest.json"), "utf8"));
  const config = JSON.parse(readFileSync(join(root, "scripts/bundle-budget.json"), "utf8"));
  const results = checkBundleBudget({
    manifest,
    readBuffer: (file) => readFileSync(join(distDir, file)),
    budgets: config.targets,
  });
  for (const item of results) {
    const max = config.targets[item.key].maxTotalGzipBytes;
    console.log(
      `[bundle-budget] ${item.key}: total=${formatKiB(item.totalBytes)} (js=${item.jsBytes} B, css=${item.cssBytes} B, limit=${max} B)`,
    );
  }
}
