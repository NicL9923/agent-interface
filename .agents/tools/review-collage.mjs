#!/usr/bin/env node
/** Combine labeled screenshots without cropping. */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

function escapeHtml(text) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function imageDataUrl(imagePath) {
  const buf = readFileSync(imagePath);
  const ext =
    imagePath.toLowerCase().endsWith(".jpg") || imagePath.toLowerCase().endsWith(".jpeg")
      ? "image/jpeg"
      : "image/png";
  return `data:${ext};base64,${buf.toString("base64")}`;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: { height: { type: "string", default: "720" } },
  });
  const [outputArg, ...panelArgs] = positionals;
  if (!outputArg || !panelArgs.length) {
    console.error("Usage: review-collage.mjs OUTPUT.png 'Label=path' ... [--height 720]");
    process.exit(2);
  }
  const height = Number(values.height);
  if (!Number.isInteger(height) || height < 100) {
    console.error("Panel height must be at least 100 pixels");
    process.exit(2);
  }
  const panels = panelArgs.map((item) => {
    const eq = item.indexOf("=");
    if (eq < 0) {
      console.error("Each panel needs Label=path");
      process.exit(2);
    }
    return { label: item.slice(0, eq), src: imageDataUrl(item.slice(eq + 1)) };
  });

  const labelSize = Math.max(16, Math.round(height / 75));
  const headerHeight = Math.max(44, labelSize + 20);
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { margin: 0; background: #eeeeee; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", DejaVu Sans, Arial, sans-serif; }
  .collage { display: inline-flex; gap: 16px; padding: 0 16px 16px 16px; background: #eeeeee; }
  .panel { display: flex; flex-direction: column; }
  .label { height: ${headerHeight}px; line-height: ${headerHeight}px; font-size: ${labelSize}px; color: #222222; white-space: nowrap; }
  img { height: ${height}px; width: auto; display: block; }
</style>
</head>
<body>
<div class="collage" id="collage">
${panels.map((p) => `<div class="panel"><div class="label">${escapeHtml(p.label)}</div><img src="${p.src}" /></div>`).join("")}
</div>
</body>
</html>`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const output = resolve(outputArg);
    mkdirSync(dirname(output), { recursive: true });
    await page.locator("#collage").screenshot({ path: output });
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
