// Drives the probe build: signs in, opens Ranch Hand, loads the whole history when FULL=1, sends,
// and records SECONDS_WINDOW seconds (default 5) of the streaming answer. CPU sets Chrome's throttle.
// Run through run-measure.sh, which copies it under scripts/ so it resolves @playwright/test.
import { chromium } from "@playwright/test";
const port = Number(process.argv[2] ?? 4190), label = process.argv[3] ?? "run";
const seconds = Number(process.env.SECONDS_WINDOW ?? 5), throttle = Number(process.env.CPU ?? 1);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.addInitScript(() => {
  const parse = JSON.parse;
  JSON.parse = function (...args) { const probe = globalThis.__probe; if (probe?.on) probe.counts["JSON.parse"] = (probe.counts["JSON.parse"] ?? 0) + 1; return parse.apply(this, args); };
});
await page.goto(`http://127.0.0.1:${port}/`);
await page.getByRole("button", { name: "Enter local workspace" }).click();
await page.getByRole("region", { name: "Your assistants" }).getByRole("button", { name: /Ranch Hand/ }).click();
const transcript = page.getByRole("region", { name: "Conversation" });
await transcript.getByText("Section", { exact: false }).first().waitFor();
if (process.env.FULL === "1") {
  for (let i = 0; i < 40; i++) {
    if (await transcript.getByText(/This is the start of your conversation/).count()) break;
    await transcript.evaluate(node => { node.scrollTop = 0; });
    await page.waitForTimeout(400);
  }
}
const loaded = await transcript.locator("[data-message-id]").count();
if (throttle > 1) { const cdp = await page.context().newCDPSession(page); await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle }); }
await page.getByRole("textbox", { name: "Message Ranch Hand" }).fill("Is the gate latched?");
await page.getByRole("button", { name: "Send message" }).click();
await transcript.getByText("North pasture").waitFor({ timeout: 30_000 });
await page.waitForTimeout(500);
await page.evaluate(() => { const probe = globalThis.__probe; probe.counts = {}; probe.renders = []; probe.on = true; });
await page.waitForTimeout(seconds * 1000);
const result = await page.evaluate(() => { const probe = globalThis.__probe; probe.on = false; return { counts: probe.counts, renders: probe.renders }; });
await browser.close();
const stats = renders => {
  const durations = renders.map(render => render.actual).sort((a, b) => a - b);
  const pick = q => durations.length ? +durations[Math.min(durations.length - 1, Math.floor(q * durations.length))].toFixed(2) : null;
  return { commits: durations.length, perSecond: +(durations.length / seconds).toFixed(1), median: pick(0.5), p95: pick(0.95), max: pick(1), totalMs: +durations.reduce((a, b) => a + b, 0).toFixed(1) };
};
const perSecond = Object.fromEntries(Object.entries(result.counts).sort().map(([key, value]) => [key, +(value / seconds).toFixed(1)]));
console.log(JSON.stringify({ label, loadedRows: loaded, cpuThrottle: throttle, seconds, 
  conversationCommits: stats(result.renders.filter(render => render.body)), otherCommits: stats(result.renders.filter(render => !render.body)), perSecond }, null, 1));
