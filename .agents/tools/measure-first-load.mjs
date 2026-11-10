#!/usr/bin/env node
// Measures how soon a production build shows something useful, in Chromium against the real app server
// (e2e/server.ts) with a slow phone's network and CPU. Run `npm run build` first; the server must not be
// running, since this starts it on the e2e port.
//
//   node .agents/tools/measure-first-load.mjs [--runs 7] [--json out.json] [--theme dark|light|system] [--only cold,warm,worker]
//     [--compare main=/path/to/client,branch=/path/to/client --rounds 3] [--seed N]
//     [--browser-cores 0-7] [--server-cores 8-11] [--max-load N] [--allow-busy]
//
// --compare serves each saved build (a copy of a dist/client) in turn and puts the current dist/client
// back afterwards. Each round runs every build once, in an order shuffled afresh for that round (seeded by
// --seed, printed), so neither a machine that slows down over the run nor a build's place in the round
// favors one build. The browser and the server run pinned to their own cores (taskset on Linux; the
// defaults are two sets of P-cores on a 12-core or larger machine). The load average is recorded at the
// start and the end; above --max-load (a quarter of the logical cores by default) the comparison is
// printed as not a result unless --allow-busy says otherwise. A comparison reports, per load and mark, the
// difference of the medians with a 95% bootstrap interval, and calls it a change only when the interval
// excludes zero.
//
// It signs in as the first local household member, chooses the dark theme while the system is light,
// and reloads home in three ways: with no service worker and no HTTP cache (a first visit), with no
// service worker and a warm HTTP cache, and opened by the service worker's cached shell. For each it
// reports the median across runs of, in milliseconds from navigation start:
// - bootstrap sent / answered: the /api/bootstrap resource entry's requestStart and responseEnd
// - first paint: the paint entry `first-paint`
// - theme: the first time <html data-theme> holds the chosen theme
// - roster: the frame after the first assistant's row is in the rail
// - layout shift: the largest load's summed layout-shift score (CLS's measure), up to 800 ms after
//   bootstrap answered
// The marks are set by an init script with performance.mark, so they come from the page's own clock.
// Each figure is reported as the median with its quartiles and the number of loads.
import { spawn, spawnSync } from 'node:child_process';
import { cp, rename, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const flag = (name) => args.includes(name);

// Pinning: this process runs itself again under taskset with the browser's cores, so Chromium and every
// process it starts inherit them; the server is started under its own.
const logical = cpus().length;
const hasTaskset = process.platform === 'linux' && spawnSync('taskset', ['-V']).status === 0;
const browserCores = option('--browser-cores', hasTaskset && logical >= 12 ? '0-7' : undefined);
const serverCores = option('--server-cores', hasTaskset && logical >= 12 ? '8-11' : undefined);
if (browserCores && !process.env.MEASURE_FIRST_LOAD_PINNED) {
  const pinned = spawnSync('taskset', ['-c', browserCores, process.execPath, ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, MEASURE_FIRST_LOAD_PINNED: browserCores } });
  process.exit(pinned.status ?? 1);
}
const maxLoad = Number(option('--max-load', logical / 4));
const allowBusy = flag('--allow-busy');
const loadAtStart = loadavg();

// A small seeded generator, so a run's shuffles and intervals can be repeated.
const seed = Number(option('--seed', Date.now() % 2 ** 31));
let state = seed || 1;
const random = () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state / 2 ** 32; };
const shuffled = (list) => { const copy = [...list]; for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy; };
const runs = Number(option('--runs', 7));
const jsonOut = option('--json');
// The theme the member chooses. Dark on a light system shows a late theme as a light flash.
const chosenTheme = option('--theme', 'dark');
const only = option('--only');
const { port } = await import('../../e2e/ports.ts').catch(() => ({ port: 4173 }));
const origin = `http://127.0.0.1:${port}`;
// Chrome DevTools' "Slow 4G" preset, a phone on a fair connection.
const NETWORK = { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 };
const CPU_SLOWDOWN = 4;

const server = serverCores
  ? spawn('taskset', ['-c', serverCores, 'npx', 'tsx', 'e2e/server.ts'], { stdio: ['ignore', 'inherit', 'inherit'] })
  : spawn('npx', ['tsx', 'e2e/server.ts'], { stdio: ['ignore', 'inherit', 'inherit'] });
const stop = () => { if (server.exitCode === null) server.kill('SIGTERM'); };
process.on('exit', stop);
for (let tries = 0; ; tries++) {
  try { if ((await fetch(`${origin}/api/auth/config`)).ok) break; } catch { /* Not up yet. */ }
  if (tries > 120) throw new Error('The e2e server did not start.');
  await new Promise(resolve => setTimeout(resolve, 250));
}

const instrument = () => {
  const marked = new Set();
  const mark = (name) => { if (!marked.has(name)) { marked.add(name); performance.mark(name); } };
  // The frame after a change is the one that shows it.
  const afterPaint = (name) => requestAnimationFrame(() => setTimeout(() => mark(name), 0));
  let rosterSeen = false;
  const check = () => {
    if (document.documentElement?.dataset.theme === window.__chosenTheme) mark('theme-applied');
    if (!rosterSeen && /ranch hand/i.test(document.querySelector('.bot-rail')?.textContent ?? '')) { rosterSeen = true; afterPaint('roster-painted'); }
  };
  // Layout shift: the sum of every shift's score during the load, as CLS adds them.
  window.__layoutShift = 0;
  new PerformanceObserver(list => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__layoutShift += entry.value; })
    .observe({ type: 'layout-shift', buffered: true });
  // The init script runs before <html> exists, so the first look waits for the first change.
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-theme'] });
};

const collect = () => {
  const at = (name) => performance.getEntriesByName(name)[0]?.startTime ?? null;
  const boots = performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname === '/api/bootstrap');
  const first = boots[0];
  return {
    bootstrapRequests: boots.length,
    bootstrapSent: first ? first.requestStart || first.startTime : null,
    bootstrapAnswered: first ? first.responseEnd : null,
    firstPaint: performance.getEntriesByType('paint').find(entry => entry.name === 'first-paint')?.startTime ?? null,
    themeApplied: at('theme-applied'),
    rosterPainted: at('roster-painted'),
    layoutShift: Math.round(window.__layoutShift * 1000) / 1000,
    shell: document.querySelector('script[src$="boot.js"]') ? 'boot.js' : 'main',
  };
};

// A quantile by linear interpolation between the order statistics, so the median of an even count is
// the mean of the two middle values.
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q, low = Math.floor(at), high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
};
const present = (values) => values.filter(value => value !== null && value !== undefined).sort((a, b) => a - b);
/** Median, quartiles and count, as "median (q1 to q3, n)". */
const spread = (values) => {
  const sorted = present(values);
  if (!sorted.length) return 'none';
  const round = (value) => Math.round(value);
  return `${round(quantile(sorted, 0.5))} (${round(quantile(sorted, 0.25))} to ${round(quantile(sorted, 0.75))}, n=${sorted.length})`;
};
/** The difference of medians, b minus a, with a 95% bootstrap interval. */
function difference(a, b, resamples = 4000) {
  const xs = present(a), ys = present(b);
  if (!xs.length || !ys.length) return null;
  const pick = (list) => present(Array.from(list, () => list[Math.floor(random() * list.length)]));
  const estimates = Array.from({ length: resamples }, () => quantile(pick(ys), 0.5) - quantile(pick(xs), 0.5)).sort((p, q) => p - q);
  const low = quantile(estimates, 0.025), high = quantile(estimates, 0.975);
  return { median: Math.round(quantile(ys, 0.5) - quantile(xs, 0.5)), low: Math.round(low), high: Math.round(high), beyondNoise: low > 0 || high < 0 };
}

async function scenario(_name, { serviceWorker, httpCache }) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: origin, colorScheme: 'light', serviceWorkers: serviceWorker ? 'allow' : 'block' });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Enter local workspace' }).click();
  await page.locator('.bot-rail').getByText('Ranch Hand').first().waitFor();
  // The chosen theme is dark while the system is light, so a late theme shows as a light flash.
  const saved = await page.evaluate(async (theme) => {
    const boot = await (await fetch('/api/bootstrap', { credentials: 'same-origin' })).json();
    const response = await fetch('/api/preferences', { method: 'PATCH', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken }, body: JSON.stringify({ ...boot.preferences, theme }) });
    return response.status;
  }, chosenTheme);
  if (saved !== 200) throw new Error(`Saving the ${chosenTheme} theme answered ${saved}`);
  if (serviceWorker) {
    // A worker that finished installing after the page loaded controls it from the next load.
    const controlled = () => page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 60_000 });
    await controlled().catch(async () => { await page.reload(); await controlled(); });
    // Two loads under the worker, so the shell, its code and any note about it are settled.
    await page.reload(); await page.locator('.bot-rail').getByText('Ranch Hand').first().waitFor();
  }
  await page.reload(); await page.locator('.bot-rail').getByText('Ranch Hand').first().waitFor();
  await page.addInitScript(`window.__chosenTheme = ${JSON.stringify(chosenTheme)};`);
  await page.addInitScript(instrument);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: !httpCache });
  await cdp.send('Network.emulateNetworkConditions', NETWORK);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
  const samples = [];
  for (let run = 0; run < runs; run++) {
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => performance.getEntriesByName('roster-painted').length > 0, null, { timeout: 60_000 });
    // Past bootstrap's answer and the group catalog's, so a swap's layout shift and a late duplicate
    // bootstrap, if any, are counted.
    await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname === '/api/bootstrap' && entry.responseEnd > 0));
    await page.waitForTimeout(800);
    const sample = await page.evaluate(collect);
    sample.controlled = await page.evaluate(() => navigator.serviceWorker?.controller !== null && navigator.serviceWorker?.controller !== undefined);
    samples.push(sample);
  }
  await browser.close();
  return samples;
}

const keys = ['bootstrapSent', 'bootstrapAnswered', 'firstPaint', 'themeApplied', 'rosterPainted', 'lightFlashMs'];
// How long a light page showed before the chosen theme, taking each load on its own.
const withFlash = (samples) => samples.map(sample => ({ ...sample,
  lightFlashMs: sample.themeApplied === null || sample.firstPaint === null ? null : Math.max(0, sample.themeApplied - sample.firstPaint) }));
const maxShift = (samples) => Math.max(...samples.map(sample => sample.layoutShift ?? 0));
function summarize(samples) {
  const summary = Object.fromEntries(keys.map(key => [key, spread(samples.map(sample => sample[key]))]));
  summary.bootstrapRequests = Math.max(...samples.map(sample => sample.bootstrapRequests));
  summary.layoutShiftMax = maxShift(samples);
  summary.controlled = samples.every(sample => sample.controlled);
  summary.shell = samples[0]?.shell;
  return summary;
}

// Builds to compare, each served in turn from dist/client, in a shuffled order every round.
const builds = (option('--compare') ?? '').split(',').filter(Boolean).map(entry => { const [label, dir] = entry.split('='); return { label, dir }; });
const rounds = Number(option('--rounds', builds.length ? 3 : 1));
const client = 'dist/client', kept = `${client}.measure-kept`;
if (builds.length) await rename(client, kept);
const scenarios = [
  ['cold', 'no worker, cold HTTP cache', { serviceWorker: false, httpCache: false }],
  ['warm', 'no worker, warm HTTP cache', { serviceWorker: false, httpCache: true }],
  ['worker', 'worker cached shell', { serviceWorker: true, httpCache: true }],
].filter(([key]) => !only || only.split(',').includes(key));
const samples = new Map();
const orders = [];
try {
  for (let round = 0; round < rounds; round++) {
    const order = shuffled(builds.length ? builds : [{ label: 'current' }]);
    orders.push(order.map(build => build.label));
    for (const build of order) {
      if (build.dir) { await rm(client, { recursive: true, force: true }); await cp(build.dir, client, { recursive: true }); }
      for (const [, name, settings] of scenarios) {
        const key = `${build.label}: ${name}`;
        samples.set(key, [...samples.get(key) ?? [], ...await scenario(name, settings)]);
      }
    }
  }
} finally {
  stop();
  if (builds.length) { await rm(client, { recursive: true, force: true }); await rename(kept, client); }
}
const loadAtEnd = loadavg();
const results = [...samples].map(([name, list]) => ({ name, summary: summarize(withFlash(list)), samples: withFlash(list) }));
const peak = Math.max(loadAtStart[0], loadAtEnd[0]);
const busy = peak > maxLoad;
const machine = {
  logicalCores: logical, browserCores: browserCores ?? 'unpinned', serverCores: serverCores ?? 'unpinned',
  loadAtStart: loadAtStart.map(value => Math.round(value * 100) / 100), loadAtEnd: loadAtEnd.map(value => Math.round(value * 100) / 100), maxLoad,
};
console.log(`\nTheme ${chosenTheme}; ${rounds} round(s) of ${runs} runs per build and load, Slow 4G (150 ms, 1.6 Mbps down) and ${CPU_SLOWDOWN}x CPU.`);
console.log(`In ms from navigation start: median (first to third quartile, loads). Seed ${seed}; build order per round: ${orders.map(order => order.join(' > ')).join('; ')}.`);
console.log(`Browser on cores ${machine.browserCores}, server on ${machine.serverCores}; load average (1, 5, 15 min) ${machine.loadAtStart.join(', ')} at the start, ${machine.loadAtEnd.join(', ')} at the end.`);
console.table(Object.fromEntries(results.map(result => [result.name, result.summary])));
// Each build against the first one named, per load and mark.
const comparisons = [];
if (builds.length > 1) {
  for (const [, name] of scenarios) {
    const base = withFlash(samples.get(`${builds[0].label}: ${name}`));
    for (const build of builds.slice(1)) {
      const other = withFlash(samples.get(`${build.label}: ${name}`));
      for (const key of keys) {
        const change = difference(base.map(sample => sample[key]), other.map(sample => sample[key]));
        if (change) comparisons.push({ load: name, build: build.label, against: builds[0].label, mark: key, ...change });
      }
    }
  }
  if (busy && !allowBusy) {
    console.log(`\nNOT A RESULT: the load average reached ${peak.toFixed(1)}, above ${maxLoad}. The figures above describe this machine's other work as much as the builds. Run again on a quieter machine, or pass --allow-busy to print the comparison anyway.`);
  } else {
    if (busy) console.log(`\nThe load average reached ${peak.toFixed(1)}, above ${maxLoad}; printed because of --allow-busy.`);
    console.log(`\nDifference of medians against ${builds[0].label}, in ms, with a 95% bootstrap interval; a change only when the interval excludes zero.`);
    console.table(comparisons.map(({ load, build, mark, median: diff, low, high, beyondNoise }) =>
      ({ load, build, mark, difference: diff, interval: `${low} to ${high}`, verdict: beyondNoise ? (diff < 0 ? 'sooner' : 'later') : 'within noise' })));
  }
}
if (jsonOut) await writeFile(jsonOut, JSON.stringify({ network: NETWORK, cpuSlowdown: CPU_SLOWDOWN, runs, rounds, seed, orders, machine, busy, comparisons, results }, null, 2));
