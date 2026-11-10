#!/usr/bin/env node
// Measures how long a streamed word takes to show in the web client, and how steadily the paced reveal paints,
// in real Chromium against .agents/tools/streaming-preview.ts. The preview's answer is numbered words and it
// records when each growth happened; the page records when each word arrived on the event stream and when the
// DOM first showed it, on the same wall clock. Prints one JSON object.
//
//   npm run build && node .agents/tools/measure-live-latency.mjs [--cps 150 | --bursty] [--words 400] [--seed-turns 0] [--cpu-throttle 1] [--port 4192] [--label name]
//
// - produced → arrived: the server's batching, the tick this measures. produced → shown: what a person sees.
// - Paints: each change to the live row's text length, and the gaps between them while the answer streams. Gaps
//   between DOM changes that showed a new word, and "dry" time: the share of the answer's streaming during which
//   the reveal had shown everything that had arrived, so the text stood still waiting for the next tick.
// - React commits a second (a stub devtools hook counts them), long tasks, and Chromium's script and layout time
//   a second from the DevTools Protocol. --seed-turns puts that many finished turns before the send, as the
//   preview's SEED_TURNS does, and --cpu-throttle slows Chromium's CPU that many times, as for a slower phone.
// Steady rates step every 40 ms with cps × 0.04 characters, or 2 characters every 67 ms at 30. Ports must be free.
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const BURSTY = args.includes("--bursty"), CPS = Number(flag("--cps", 150)), WORDS = Number(flag("--words", 400));
const PORT = Number(flag("--port", 4192)), LABEL = flag("--label", "checkout");
const SEED = flag("--seed-turns", "0"), THROTTLE = Number(flag("--cpu-throttle", 1));
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "live-latency-"));
const timelineFile = join(dir, "timeline.json");
const steady = CPS >= 75 ? { STREAM_CHARS: String(Math.round(CPS * 0.04)), STREAM_MS: "40" } : { STREAM_CHARS: "2", STREAM_MS: String(Math.round(2000 / CPS)) };
const server = spawn("npx", ["tsx", ".agents/tools/streaming-preview.ts", String(PORT)], { stdio: ["ignore", "inherit", "inherit"], detached: true,
  env: { ...process.env, SEED_TURNS: SEED, TOKENS: String(WORDS), TIMELINE_FILE: timelineFile, SAVE_DELAY_MS: "1500", ...BURSTY ? { BURSTY: "1" } : steady } });
const stop = () => { try { process.kill(-server.pid, "SIGTERM"); } catch { /* Already gone. */ } rmSync(dir, { recursive: true, force: true }); };
process.on("exit", stop);
for (let tries = 0; ; tries++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/auth/config`)).ok) break; } catch { /* Not up yet. */ }
  if (tries > 120) throw new Error("preview did not start");
  await sleep(250);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
await page.addInitScript(() => {
  const now = () => performance.timeOrigin + performance.now();
  const largest = text => { let max = 0; for (const match of text.matchAll(/w(\d{4})/g)) max = Math.max(max, Number(match[1])); return max; };
  const record = window.__live = { arrived: [], events: [], shown: [], paints: [], commits: 0, longTasks: [] };
  // React reports each commit to a devtools hook when one is installed, in production builds too.
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), isDisabled: false, checkDCE() {}, inject() { return 1; },
    onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onCommitFiberRoot() { record.commits++; } };
  // The live reply as the stream has delivered it, rebuilt from whole replies and growth, and its largest
  // whole word each time that grew.
  const Native = window.EventSource;
  let held = "", reached = 0;
  window.EventSource = class extends Native {
    constructor(...rest) {
      super(...rest);
      for (const type of ["turn", "inflight", "inflight-delta"]) this.addEventListener(type, event => {
        const data = JSON.parse(event.data);
        held = type === "inflight-delta" ? held + (data.appendText ?? "") : data.message?.text ?? "";
        const word = largest(held);
        if (word > reached) { reached = word; record.arrived.push([now(), word]); }
        record.events.push(now());
      });
    }
  };
  // Each change to the live row's largest shown word, when the DOM changed.
  let last = 0, length = 0;
  new MutationObserver(() => {
    const row = document.querySelector('[data-message-id="session-inflight"] .message-markdown');
    const text = row?.textContent ?? "";
    if (text.length !== length) { length = text.length; record.paints.push(now()); }
    const word = largest(text);
    if (word > last) { last = word; record.shown.push([now(), word]); }
  }).observe(document, { subtree: true, childList: true, characterData: true });
  new PerformanceObserver(list => { for (const entry of list.getEntries()) record.longTasks.push(entry.duration); }).observe({ type: "longtask", buffered: true });
});
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
if (THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));

await page.goto(`http://127.0.0.1:${PORT}/`);
await page.getByRole("button", { name: "Enter local workspace" }).click();
await page.getByRole("region", { name: "Your assistants" }).getByRole("button", { name: /Ranch Hand/ }).click();
await page.getByRole("textbox", { name: "Message Ranch Hand" }).fill("How are the gates?");
await page.getByRole("button", { name: "Send message" }).click();
await page.waitForFunction(() => window.__live.shown.length > 0, null, { timeout: 120_000 });
const startMetrics = await metrics(), startCommits = await page.evaluate(() => window.__live.commits), startedAt = Date.now();
while (!existsSync(timelineFile)) await sleep(100);
const endMetrics = await metrics(), endCommits = await page.evaluate(() => window.__live.commits), seconds = (Date.now() - startedAt) / 1000;
// The reveal's last third of a second, before the preview saves the answer.
await sleep(800);
const record = await page.evaluate(() => window.__live);
await browser.close();

const { points } = JSON.parse(readFileSync(timelineFile, "utf8"));
const answer = Array.from({ length: WORDS }, (_, index) => `w${String(index + 1).padStart(4, "0")}${index % 12 === 11 ? "\n\n" : " "}`).join("").trimEnd();
// When each word was first whole in the streamed answer.
const produced = [];
for (let word = 1, at = 0; word <= WORDS; word++) {
  const end = answer.indexOf(`w${String(word).padStart(4, "0")}`) + 5;
  while (at < points.length && points[at][1] < end) at++;
  produced[word] = points[at]?.[0];
}
const firstAt = (series, word) => series.find(([, reached]) => reached >= word)?.[0];
const quantiles = values => {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  const at = q => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
  return { median: at(0.5), p95: at(0.95), max: Math.round(sorted.at(-1)), n: sorted.length };
};
// The first second is left out: the reveal starts from the answer's first text at once.
const skip = points[0][0] + 1000, words = [];
for (let word = 1; word <= WORDS; word++) if (produced[word] >= skip) words.push(word);
const arrival = quantiles(words.map(word => firstAt(record.arrived, word) - produced[word]));
const visible = quantiles(words.map(word => firstAt(record.shown, word) - produced[word]));
const end = points.at(-1)[0];
const shownDuring = record.shown.filter(([at]) => at >= skip && at <= end);
const paints = record.paints.filter(at => at >= skip && at <= end);
const paintGaps = paints.slice(1).map((at, index) => at - paints[index]);
const gaps = shownDuring.slice(1).map(([at], index) => at - shownDuring[index][0]);
// Dry: from a paint that showed everything arrived so far, until the next arrival.
let dry = 0;
for (const [at, word] of shownDuring) {
  const arrivedBefore = record.arrived.filter(([when]) => when <= at).at(-1)?.[1] ?? 0;
  if (word >= arrivedBefore) {
    const next = record.arrived.find(([when]) => when > at)?.[0] ?? end;
    dry += Math.max(0, Math.min(next, end) - at);
  }
}
const streaming = (end - skip) / 1000;
console.log(JSON.stringify({
  label: LABEL, input: BURSTY ? "bursty" : `${CPS} cps`, words: WORDS, seedTurns: Number(SEED), cpuThrottle: THROTTLE, streamingSeconds: +streaming.toFixed(1),
  producedToArrivedMs: arrival, producedToShownMs: visible,
  liveEventsPerSecond: +(record.events.filter(at => at >= skip && at <= end).length / streaming).toFixed(1),
  paintsPerSecond: +(paints.length / streaming).toFixed(1), gapBetweenPaintsMs: quantiles(paintGaps),
  paintGapsOver100Ms: paintGaps.filter(gap => gap > 100).length,
  shownChangesPerSecond: +(shownDuring.length / streaming).toFixed(1), gapBetweenShownChangesMs: quantiles(gaps),
  gapsOver100Ms: gaps.filter(gap => gap > 100).length, dryShare: +(dry / (end - skip)).toFixed(3),
  reactCommitsPerSecond: +((endCommits - startCommits) / seconds).toFixed(1), longTasks: record.longTasks.length,
  scriptMsPerSecond: +((endMetrics.ScriptDuration - startMetrics.ScriptDuration) * 1000 / seconds).toFixed(1),
  layoutAndStyleMsPerSecond: +(((endMetrics.LayoutDuration - startMetrics.LayoutDuration) + (endMetrics.RecalcStyleDuration - startMetrics.RecalcStyleDuration)) * 1000 / seconds).toFixed(1),
  taskMsPerSecond: +((endMetrics.TaskDuration - startMetrics.TaskDuration) * 1000 / seconds).toFixed(1),
}));
process.exit(0);
