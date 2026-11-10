#!/usr/bin/env node
// Samples a sent message's rise in real Chromium against e2e/server.ts, with motion allowed and reduced: the computed
// animation name, duration, easing and transform origin, then opacity and transform at fixed times read from the
// paused animation through the Web Animations API, so two builds can be compared value for value. The send is held
// unanswered so the message stays outgoing. With SHOT=prefix it also saves a screenshot per motion setting, which
// live motion elsewhere on the page keeps from matching pixel for pixel.
// Run `npm run build` first. It uses port 4197 and the next one; E2E_PORT picks others.
//   node .agents/tools/sample-send-animation.mjs > before.json
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";
const port = Number(process.env.E2E_PORT) || 4197, base = `http://127.0.0.1:${port}`;
const server = spawn("npx", ["tsx", "e2e/server.ts"], { stdio: ["ignore", "ignore", "inherit"], detached: true, env: { ...process.env, E2E_PORT: String(port) } });
process.on("exit", () => { try { process.kill(-server.pid, "SIGTERM"); } catch {} });
for (let i = 0; ; i++) { try { if ((await fetch(`${base}/api/auth/config`)).ok) break; } catch {} if (i > 120) throw new Error("no server"); await sleep(250); }
const browser = await chromium.launch();
const out = {};
for (const motion of ["no-preference", "reduce"]) {
  const context = await browser.newContext({ baseURL: base, serviceWorkers: "block", viewport: { width: 900, height: 700 }, reducedMotion: motion });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "Enter local workspace" }).click();
  await page.getByRole("region", { name: "Your assistants" }).getByRole("button", { name: /Ranch Hand/ }).click();
  await page.route("**/api/bots/ranch/messages", () => {});
  await page.getByRole("textbox", { name: "Message Ranch Hand" }).fill("Is the gate latched?");
  await page.getByRole("button", { name: "Send message" }).click();
  const sent = page.locator(".message-outgoing");
  await sent.waitFor();
  out[motion] = await sent.evaluate(element => {
    const style = getComputedStyle(element);
    const [animation] = element.getAnimations();
    const samples = [];
    if (animation) {
      animation.pause();
      for (const t of [0, 60, 120, 200, 300, 380, 460]) { animation.currentTime = t; const s = getComputedStyle(element); samples.push(`${t}ms opacity ${(+s.opacity).toFixed(3)} ${s.transform}`); }
    }
    return { name: style.animationName, duration: style.animationDuration, easing: style.animationTimingFunction.slice(0, 60), origin: style.transformOrigin,
      effect: animation ? JSON.stringify(animation.effect.getTiming()) : null, samples };
  });
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}-${motion}.png` });
  await context.close();
}
console.log(JSON.stringify(out, null, 1));
await browser.close(); process.exit(0);
