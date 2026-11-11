#!/usr/bin/env node
// Counts the app's /api requests in real Chromium against e2e/server.ts, for a cold load of a chat,
// a tab woken after a minute in the background, an idle stretch on a chat and on home, and a turn that streams through
// a tool (the Trail Cook's scripted reply, whose tool finishes in the middle of it).
// Run `npm run build` first; port 4173 must be free. Prints JSON: per scenario, requests by path.
//   node .agents/tools/count-stream-requests.mjs [--idle-ms 600000] [--only cold,wake,idle,turn]
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const IDLE_MS = Number(flag("--idle-ms", 600_000));
const HIDDEN_MS = Number(flag("--hidden-ms", 70_000));
const ONLY = new Set(flag("--only", "cold,wake,idle,turn").split(","));
const base = "http://127.0.0.1:4173";

const server = spawn("npx", ["tsx", "e2e/server.ts"], { stdio: ["ignore", "inherit", "inherit"], detached: true });
const stop = () => { try { process.kill(-server.pid, "SIGTERM"); } catch { /* Already gone. */ } };
process.on("exit", stop);
for (let tries = 0; ; tries++) {
  try { if ((await fetch(`${base}/api/auth/config`)).ok) break; } catch { /* Not up yet. */ }
  if (tries > 120) throw new Error("e2e server did not start");
  await sleep(250);
}

// The page sees `hidden` only through these, so a test can hide and show it as a backgrounded tab would.
const visibility = () => {
  Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => window.__hidden ? "hidden" : "visible" });
  Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => !!window.__hidden });
};
const setHidden = (page, hidden) => page.evaluate(value => {
  window.__hidden = value;
  document.dispatchEvent(new Event("visibilitychange"));
  if (!value) window.dispatchEvent(new Event("focus"));
}, hidden);

const browser = await chromium.launch();
async function signedInPage() {
  // A blocked worker keeps each request counted once, from the page.
  const context = await browser.newContext({ baseURL: base, serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
  await context.addInitScript(visibility);
  // Sign in on a tab of its own, so the measured tab starts cold with only the session cookie.
  const signIn = await context.newPage();
  await signIn.goto("/");
  await signIn.getByRole("button", { name: "Enter local workspace" }).click();
  await signIn.getByRole("region", { name: "Your assistants" }).waitFor();
  await signIn.close();
  const page = await context.newPage();
  const seen = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/") && url.pathname !== "/api/csp-report") seen.push(`${request.method()} ${url.pathname}${url.search}`);
  });
  return { page, context, count: () => { const tally = {}; for (const key of seen) tally[key] = (tally[key] ?? 0) + 1; return { total: seen.length, byPath: tally }; }, reset: () => { seen.length = 0; } };
}

const results = {};
const settle = 8_000;
if (ONLY.has("cold") || ONLY.has("wake")) {
  const tab = await signedInPage();
  tab.reset();
  await tab.page.goto("/?bot=ranch");
  await tab.page.getByRole("region", { name: "Conversation" }).waitFor();
  await sleep(settle);
  results.cold = tab.count();
  if (ONLY.has("wake")) {
    await setHidden(tab.page, true);
    await sleep(HIDDEN_MS);
    tab.reset();
    await setHidden(tab.page, false);
    await sleep(settle);
    results.wake = tab.count();
  }
  await tab.context.close();
}
if (ONLY.has("turn")) {
  // The conversation reads one turn costs: the chat opens first, so those that follow are the turn's own.
  const tab = await signedInPage();
  await tab.page.goto("/?bot=trail");
  await tab.page.getByRole("region", { name: "Conversation" }).waitFor();
  await sleep(settle);
  tab.reset();
  await tab.page.getByRole("textbox", { name: "Message Trail Cook" }).fill("Is the gate latched?");
  await tab.page.getByRole("button", { name: "Send message" }).click();
  await tab.page.getByText("Post two is loose, so I tightened the wire and checked the gate.").first().waitFor({ timeout: 20_000 });
  await sleep(settle);
  results.turn = tab.count();
  await tab.context.close();
}
if (ONLY.has("idle")) {
  const [chat, home] = await Promise.all([signedInPage(), signedInPage()]);
  await home.page.goto("/");
  await chat.page.goto("/?bot=ranch");
  await chat.page.getByRole("region", { name: "Conversation" }).waitFor();
  await sleep(settle);
  chat.reset(); home.reset();
  await sleep(IDLE_MS);
  results.idleChat = { minutes: IDLE_MS / 60_000, ...chat.count() };
  results.idleHome = { minutes: IDLE_MS / 60_000, ...home.count() };
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
stop();
process.exit(0);
