#!/usr/bin/env node
// Measures how soon a production build shows something useful, in Chromium against the real app server
// (e2e/server.ts) with a slow phone's network and CPU. Run `npm run build` first; the server must not be
// running, since this starts it on the e2e port.
//
//   node .agents/tools/measure-first-load.mjs [--runs 7] [--json out.json] [--theme dark|light|system] [--only cold,warm,worker]
//     [--compare main=/path/to/client,branch=/path/to/client --rounds 3]
//
// --compare serves each saved build (a copy of a dist/client) in turn, alternating them over --rounds,
// and puts the current dist/client back afterwards. Use it on a shared or busy machine.
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
import { spawn } from 'node:child_process';
import { cp, rename, rm, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
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

const server = spawn('npx', ['tsx', 'e2e/server.ts'], { stdio: ['ignore', 'inherit', 'inherit'] });
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

const median = (values) => {
  const sorted = values.filter(value => value !== null).sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null;
};

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
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
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

const keys = ['bootstrapSent', 'bootstrapAnswered', 'firstPaint', 'themeApplied', 'rosterPainted'];
const maxShift = (samples) => Math.max(...samples.map(sample => sample.layoutShift ?? 0));
function summarize(samples) {
  const summary = Object.fromEntries(keys.map(key => [key, median(samples.map(sample => sample[key]))]));
  summary.bootstrapRequests = Math.max(...samples.map(sample => sample.bootstrapRequests));
  summary.layoutShiftMax = maxShift(samples);
  summary.controlled = samples.every(sample => sample.controlled);
  // How long a light page showed before the chosen theme, taking each load on its own.
  summary.lightFlashMs = median(samples.map(sample => sample.themeApplied === null || sample.firstPaint === null ? null : Math.max(0, sample.themeApplied - sample.firstPaint)));
  summary.shell = samples[0]?.shell;
  summary.samples = samples.length;
  return summary;
}

// Builds to compare, each served in turn from dist/client. Rounds alternate them, so a busy machine
// slows every build alike instead of whichever ran last.
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
try {
  for (let round = 0; round < rounds; round++) {
    for (const build of builds.length ? builds : [{ label: 'current' }]) {
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
const results = [...samples].map(([name, list]) => ({ name, summary: summarize(list), samples: list }));
console.log(`\nTheme ${chosenTheme}; ${rounds} round(s) of ${runs} runs, Slow 4G (150 ms, 1.6 Mbps down) and ${CPU_SLOWDOWN}x CPU; medians in ms from navigation start.`);
console.table(Object.fromEntries(results.map(result => [result.name, result.summary])));
if (jsonOut) await writeFile(jsonOut, JSON.stringify({ network: NETWORK, cpuSlowdown: CPU_SLOWDOWN, runs, rounds, results }, null, 2));
