#!/usr/bin/env node
// Times how long a sent message sits alone before the assistant's activity row appears, in real Chromium
// against e2e/server.ts with its scripted assistant. Each run sends "Echo: …" to the Trail Cook, whose turn
// reports thinking as soon as Hermes admits it, and records with a MutationObserver: when the echo row
// appears, when the activity row appears, how many activity row nodes were inserted and removed until the
// reply's first words show, whether the status line's text changed in between, and how far the sent message
// moved on screen in that time (the send anchor holds it near the top).
// Run `npm run build` first. It uses port 4183 and the next one; E2E_PORT picks others.
//   node .agents/tools/measure-thinking-gap.mjs [--runs 10] [--delays 0,1500]
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const RUNS = Number(flag("--runs", 10));
const DELAYS = flag("--delays", "0,1500").split(",").map(Number);
const port = Number(process.env.E2E_PORT) || 4183;
const base = `http://127.0.0.1:${port}`, control = `http://127.0.0.1:${port + 1}`;
// A server already there would be another worktree's build, measured by mistake.
if (await fetch(`${base}/api/auth/config`).then(() => true, () => false)) throw new Error(`Port ${port} is taken; set E2E_PORT.`);
const server = spawn("npx", ["tsx", "e2e/server.ts"], { stdio: ["ignore", "inherit", "inherit"], detached: true, env: { ...process.env, E2E_PORT: String(port) } });
const stop = () => { try { process.kill(-server.pid, "SIGTERM"); } catch { /* Already gone. */ } };
process.on("exit", stop);
for (let tries = 0; ; tries++) {
  try { if ((await fetch(`${base}/api/auth/config`)).ok) break; } catch { /* Not up yet. */ }
  if (tries > 120) throw new Error("e2e server did not start");
  await sleep(250);
}

const browser = await chromium.launch();
const results = {};
for (const delay of DELAYS) {
  const runs = [];
  for (let run = 0; run < RUNS; run++) {
    await fetch(`${control}/reset`, { method: "DELETE" });
    if (delay) await fetch(`${control}/admission-delay?ms=${delay}`, { method: "POST" });
    const context = await browser.newContext({ baseURL: base, serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: "Enter local workspace" }).click();
    await page.getByRole("region", { name: "Your assistants" }).getByRole("button", { name: /Trail Cook/ }).click();
    const field = page.getByRole("textbox", { name: "Message Trail Cook" });
    const text = `Echo: run ${run} howdy`;
    await field.fill(text);
    await page.evaluate(sent => {
      const marks = window.__gap = { inserted: 0, removed: 0, statuses: [] };
      const row = () => document.querySelector(".conversation-activity");
      new MutationObserver(records => {
        const now = performance.now();
        for (const record of records) {
          for (const node of record.addedNodes) if (node instanceof HTMLElement && node.matches(".conversation-activity")) marks.inserted++;
          for (const node of record.removedNodes) if (node instanceof HTMLElement && node.matches(".conversation-activity")) marks.removed++;
        }
        const echo = [...document.querySelectorAll(".message-user")].find(item => item.textContent?.includes(sent));
        if (marks.echo === undefined && echo) marks.echo = now;
        if (echo && marks.reply === undefined) {
          const top = echo.getBoundingClientRect().top;
          marks.firstTop ??= top;
          marks.shift = Math.max(marks.shift ?? 0, Math.abs(top - marks.firstTop));
        }
        if (marks.row === undefined && row()) marks.row = now;
        const status = row()?.querySelector('[role="status"]')?.textContent?.trim();
        if (status && marks.statuses.at(-1) !== status) marks.statuses.push(status);
        if (marks.reply === undefined && document.querySelector('[data-message-id="trail-inflight"] .message-markdown')?.textContent?.includes("run")) marks.reply = now;
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }, text);
    await page.getByRole("button", { name: "Send message" }).click();
    await page.waitForFunction(() => window.__gap.reply !== undefined, null, { timeout: 15_000 });
    const marks = await page.evaluate(() => window.__gap);
    runs.push({ echoToRowMs: Math.round(marks.row - marks.echo), echoToReplyMs: Math.round(marks.reply - marks.echo),
      rowInserted: marks.inserted, rowRemoved: marks.removed, statuses: marks.statuses, echoMovedPx: Math.round(marks.shift) });
    await context.close();
  }
  const gaps = runs.map(run => run.echoToRowMs).sort((a, b) => a - b);
  results[`admissionDelayMs=${delay}`] = {
    echoToRowMs: { median: gaps[Math.floor(gaps.length / 2)], min: gaps[0], max: gaps.at(-1) },
    echoMovedPxMax: Math.max(...runs.map(run => run.echoMovedPx)),
    rowInsertedMax: Math.max(...runs.map(run => run.rowInserted)), rowRemovedMax: Math.max(...runs.map(run => run.rowRemoved)),
    statuses: [...new Set(runs.map(run => run.statuses.join(" → ")))], runs,
  };
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
stop();
process.exit(0);
