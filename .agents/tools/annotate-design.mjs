#!/usr/bin/env node
/** Render numbered pointers and matching before/after notes from a JSON specification. */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function imageDataUrl(imagePath) {
  const buf = readFileSync(imagePath);
  const ext =
    imagePath.toLowerCase().endsWith(".jpg") || imagePath.toLowerCase().endsWith(".jpeg")
      ? "image/jpeg"
      : "image/png";
  return `data:${ext};base64,${buf.toString("base64")}`;
}

async function renderSpec(page, spec, output) {
  const panels = await Promise.all(
    [
      ["before", "#A33C32"],
      ["after", "#246F59"],
    ].map(async ([side, color]) => {
      const info = spec[side];
      const dataUrl = imageDataUrl(info.image);
      return {
        side,
        color,
        title: `${side[0].toUpperCase()}${side.slice(1)}  |  ${spec.title}`,
        dataUrl,
        notes: info.notes,
      };
    }),
  );

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #EBEEE9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", DejaVu Sans, Arial, sans-serif; color: #202A24; }
  .grid { display: flex; gap: 24px; align-items: flex-start; width: max-content; }
  .panel { background: #FFFFFF; display: flex; flex-direction: column; }
  .header { padding: 16px 24px; font-weight: 700; line-height: 1.25; }
  .shot-wrap { position: relative; line-height: 0; }
  .shot-wrap img { display: block; }
  .shot-wrap svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
  .legend { padding: 24px; display: flex; flex-direction: column; gap: 10px; line-height: 1.4; }
</style>
</head>
<body>
<div class="grid" id="canvas">
${panels
  .map(
    (p, idx) => `
  <div class="panel" data-panel="${idx}">
    <div class="header">${escapeHtml(p.title)}</div>
    <div class="shot-wrap">
      <img src="${p.dataUrl}" data-shot="${idx}" />
      <svg data-svg="${idx}"></svg>
    </div>
    <div class="legend">
      ${p.notes.map((n, i) => `<div>${i + 1}. ${escapeHtml(n.text)}</div>`).join("")}
    </div>
  </div>`,
  )
  .join("")}
</div>
<script>
window.__renderPointers = (panels) => {
  panels.forEach((p, idx) => {
    const img = document.querySelector(\`[data-shot="\${idx}"]\`);
    const panel = document.querySelector(\`[data-panel="\${idx}"]\`);
    const svg = document.querySelector(\`[data-svg="\${idx}"]\`);
    const w = img.naturalWidth, h = img.naturalHeight;
    const scale = Math.max(1, w / 900);
    panel.style.width = w + "px";
    panel.querySelector(".header").style.fontSize = Math.round(24 * scale) + "px";
    panel.querySelector(".legend").style.fontSize = Math.round(18 * scale) + "px";
    svg.setAttribute("viewBox", \`0 0 \${w} \${h}\`);
    const ns = "http://www.w3.org/2000/svg";
    p.notes.forEach((note, i) => {
      const [x, y] = note.point ? note.point : [note.fraction[0] * w, note.fraction[1] * h];
      const [dx, dy] = note.offset || [30 * scale, -26 * scale];
      const cx = x + dx, cy = y + dy;
      const r = Math.round(13 * scale);
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", cx); line.setAttribute("y1", cy);
      line.setAttribute("x2", x); line.setAttribute("y2", y);
      line.setAttribute("stroke", p.color); line.setAttribute("stroke-width", Math.round(3 * scale));
      svg.appendChild(line);
      const angle = Math.atan2(cy - y, cx - x);
      const arrow = 8 * scale;
      const poly = document.createElementNS(ns, "polygon");
      poly.setAttribute("points", \`\${x},\${y} \${x + arrow * Math.cos(angle + 0.5)},\${y + arrow * Math.sin(angle + 0.5)} \${x + arrow * Math.cos(angle - 0.5)},\${y + arrow * Math.sin(angle - 0.5)}\`);
      poly.setAttribute("fill", p.color);
      svg.appendChild(poly);
      const circle = document.createElementNS(ns, "circle");
      circle.setAttribute("cx", cx); circle.setAttribute("cy", cy); circle.setAttribute("r", r);
      circle.setAttribute("fill", p.color); circle.setAttribute("stroke", "#FFFFFF");
      circle.setAttribute("stroke-width", Math.round(2 * scale));
      svg.appendChild(circle);
      const text = document.createElementNS(ns, "text");
      text.setAttribute("x", cx); text.setAttribute("y", cy);
      text.setAttribute("fill", "#FFFFFF"); text.setAttribute("font-size", Math.round(15 * scale));
      text.setAttribute("font-weight", "700"); text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "central");
      text.textContent = String(i + 1);
      svg.appendChild(text);
    });
  });
};
</script>
</body>
</html>`;

  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate((data) => window.__renderPointers(data), panels);
  mkdirSync(dirname(output), { recursive: true });
  await page.locator("#canvas").screenshot({ path: output });
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: { batch: { type: "boolean", default: false } },
  });
  const [specPath, outputPath] = positionals;
  if (!specPath) {
    console.error("Usage: annotate-design.mjs SPEC.json [OUTPUT.png] [--batch]");
    process.exit(2);
  }
  const jobs = [];
  if (values.batch) {
    if (outputPath) {
      console.error("A batch manifest supplies its output paths");
      process.exit(2);
    }
    const root = dirname(resolve(specPath));
    const rows = JSON.parse(readFileSync(specPath, "utf8"));
    if (!Array.isArray(rows) || !rows.length) {
      console.error("A batch manifest must contain a nonempty list");
      process.exit(2);
    }
    for (const row of rows) {
      const source = resolve(root, row.spec);
      const output = resolve(root, row.output);
      if (relative(root, source).startsWith("..") || relative(root, output).startsWith("..")) {
        console.error("Batch paths must stay inside the manifest directory");
        process.exit(2);
      }
      const spec = JSON.parse(readFileSync(source, "utf8"));
      for (const side of ["before", "after"]) {
        if (!existsSync(spec[side].image)) {
          console.error(`Missing ${side} image in ${source}`);
          process.exit(2);
        }
      }
      jobs.push([spec, output]);
    }
  } else {
    if (!outputPath) {
      console.error("Supply an output image, or use --batch");
      process.exit(2);
    }
    jobs.push([JSON.parse(readFileSync(specPath, "utf8")), resolve(outputPath)]);
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const [spec, output] of jobs) {
      await renderSpec(page, spec, output);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
