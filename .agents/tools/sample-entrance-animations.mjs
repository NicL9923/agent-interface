#!/usr/bin/env node
// Reads which animation each small entrance pop takes, in real Chromium against e2e/server.ts, with motion allowed and
// reduced: the computed animation name, duration and easing, then opacity and transform at fixed times from the paused
// animation, so a spring's overshoot shows as numbers. Each selector is read from a bare element with that class added
// after sign-in, so the result is the cascade's answer for that class alone. The window is 900 px wide, the desktop
// layout; WIDTH=390 reads the phone layout, where the palette and settings sheet rise from the bottom instead.
// `npm run build` first. MODE=dev reads the Vite dev server instead, whose stylesheet order can differ from the
// build's; it proxies /api to the same e2e server. Uses port 4199 and the next one (E2E_PORT moves them), plus 5199
// for dev (DEV_PORT). With SHOT=prefix it also saves the real bot menu and undo toast at 40, 140 and 260 ms into
// their entrance, per motion setting.
//   node .agents/tools/sample-entrance-animations.mjs > prod.json
//   MODE=dev node .agents/tools/sample-entrance-animations.mjs > dev.json
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";

// Each entry is an element to add: its tag, class and whether it is an open dialog.
const ELEMENTS = [
  { label: ".bot-menu", tag: "div", className: "bot-menu" },
  { label: ".dock-item", tag: "div", className: "dock-item" },
  { label: ".toast", tag: "div", className: "toast" },
  { label: ".jump-latest", tag: "button", className: "jump-latest" },
  { label: ".command-palette[open]", tag: "dialog", className: "command-palette", open: true },
  { label: ".settings-sheet[open]", tag: "dialog", className: "settings-sheet", open: true },
];
const TIMES = [0, 40, 80, 140, 200, 260, 320, 380, 420];
const port = Number(process.env.E2E_PORT) || 4199, api = `http://127.0.0.1:${port}`;
const dev = process.env.MODE === "dev";
const server = spawn("npx", ["tsx", "e2e/server.ts"], { stdio: ["ignore", "ignore", "inherit"], detached: true, env: { ...process.env, E2E_PORT: String(port) } });
let vite;
process.on("exit", () => { try { process.kill(-server.pid, "SIGTERM"); } catch {} });
for (let i = 0; ; i++) { try { if ((await fetch(`${api}/api/auth/config`)).ok) break; } catch {} if (i > 120) throw new Error("no server"); await sleep(250); }
let base = api;
if (dev) {
  const { createServer } = await import("vite");
  const devPort = Number(process.env.DEV_PORT) || 5199;
  // The server refuses a write whose Origin is not its own, so the proxy presents the app server's origin.
  const configure = proxy => proxy.on("proxyReq", request => { if (request.getHeader("origin")) request.setHeader("origin", api); });
  vite = await createServer({ logLevel: "silent", server: { port: devPort, strictPort: true, proxy: { "/api": { target: api, ws: true, configure }, "/inline-ui": api } } });
  await vite.listen();
  base = `http://127.0.0.1:${devPort}`;
}

const browser = await chromium.launch();
const out = { mode: dev ? "dev" : "production", width: Number(process.env.WIDTH) || 900 };
for (const motion of ["no-preference", "reduce"]) {
  const context = await browser.newContext({ baseURL: base, serviceWorkers: "block", viewport: { width: Number(process.env.WIDTH) || 900, height: 700 }, reducedMotion: motion });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "Enter local workspace" }).click();
  const assistants = page.getByRole("region", { name: "Your assistants" });
  await assistants.getByRole("button", { name: /Ranch Hand/ }).waitFor();
  out[motion] = await page.evaluate(({ elements, times }) => Object.fromEntries(elements.map(({ label, tag, className, open }) => {
    const element = document.body.appendChild(document.createElement(tag));
    element.className = className;
    if (open) element.setAttribute("open", "");
    const style = getComputedStyle(element);
    const [animation] = element.getAnimations();
    const samples = [];
    if (animation) {
      animation.pause();
      for (const t of times) { animation.currentTime = t; const s = getComputedStyle(element); samples.push(`${t}ms ${(+s.opacity).toFixed(3)} ${s.transform}`); }
    }
    const result = { name: style.animationName, duration: style.animationDuration, easing: style.animationTimingFunction.slice(0, 40), samples };
    element.remove();
    return [label, result];
  })), { elements: ELEMENTS, times: TIMES });
  if (process.env.SHOT) {
    // The real menu and toast: right-click an assistant, then pin it from the menu. Each frame holds the element's
    // own animations paused at a fixed time, so two builds' frames compare at the same moment.
    const frames = async (selector, label) => {
      const element = page.locator(selector);
      for (const t of [40, 140, 260]) {
        await element.evaluate((node, time) => node.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = time; }), t);
        await page.screenshot({ path: `${process.env.SHOT}-${motion}-${label}-${t}ms.png`, clip: await element.boundingBox().then(box => ({ x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 })) });
      }
      await element.evaluate(node => node.getAnimations().forEach(animation => animation.finish()));
    };
    await assistants.getByRole("button", { name: /Trail Cook/ }).click({ button: "right" });
    await frames(".bot-menu", "menu");
    await page.locator(".bot-menu").getByRole("menuitem", { name: /^Pin/ }).click();
    await frames(".toast", "toast");
    // The pin is saved on the server, so undo it for the next motion setting's home.
    await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
    await page.locator(".toast").waitFor({ state: "detached" });
  }
  await context.close();
}
console.log(JSON.stringify(out, null, 1));
await browser.close();
await vite?.close();
process.exit(0);
