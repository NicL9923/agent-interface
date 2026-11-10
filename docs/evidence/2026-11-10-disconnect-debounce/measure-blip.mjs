// One failed conversation read, then a successful one, on the seeded preview's first page. Counts turn
// renders, Markdown parses and reply action rows, and samples whether the chat shows it is disconnected.
// Usage: node measure-blip.mjs <port> <label>
import { chromium } from "@playwright/test";
const port = Number(process.argv[2] ?? 4190), label = process.argv[3] ?? "run";
const gapMs = Number(process.env.GAP_MS ?? 200);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(`http://127.0.0.1:${port}/`);
await page.getByRole("button", { name: "Enter local workspace" }).click();
await page.getByRole("region", { name: "Your assistants" }).getByRole("button", { name: /Ranch Hand/ }).click();
const transcript = page.getByRole("region", { name: "Conversation" });
await transcript.getByText("Section", { exact: false }).first().waitFor();
await page.waitForTimeout(1500);
const shown = () => page.evaluate(() => !!document.querySelector(".connection-panel") || !!document.querySelector(".activity-status.state-disconnected"));
const reads = { failed: 0, passed: 0 };
let fail = true;
await page.route(/\/api\/bots\/ranch\/conversation/, route => {
  if (fail) { reads.failed++; return route.abort("connectionrefused"); }
  reads.passed++;
  return route.continue();
});
await page.evaluate(() => { const probe = globalThis.__probe; probe.counts = {}; probe.renders = []; probe.on = true; });
await page.evaluate(() => window.dispatchEvent(new Event("agent-interface:reconnect")));
const samples = [];
for (let at = 0; at < gapMs; at += 50) { await page.waitForTimeout(50); samples.push(await shown()); }
fail = false;
await page.evaluate(() => window.dispatchEvent(new Event("agent-interface:reconnect")));
await page.waitForTimeout(1500);
const after = await shown();
const result = await page.evaluate(() => { const probe = globalThis.__probe; probe.on = false; return { counts: probe.counts, renders: probe.renders.map(render => +render.actual.toFixed(2)) }; });
const rows = await transcript.locator("[data-message-id]").count();
await browser.close();
console.log(JSON.stringify({ label, rows, reads, shownDuringFailure: samples.some(Boolean), shownAfterSuccess: after, counts: result.counts,
  commits: result.renders.length, commitMs: result.renders }, null, 1));
