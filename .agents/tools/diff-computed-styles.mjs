#!/usr/bin/env node
// Compares the computed styles of the same screens in the production build and on the Vite dev server, in real
// Chromium against e2e/server.ts. The two load the same stylesheets in a different order (the build links
// home.css, shell.css and the component sheets around index.css; dev injects them in import order and motion.css
// last), so a rule that wins in one and loses in the other shows as a property whose value differs. Prints each
// difference as `screen  element  property  build -> dev`, and exits 1 when there is any.
//   npm run build && node .agents/tools/diff-computed-styles.mjs
// WIDTH=390 reads the phone layout. SCHEMES=light,dark picks the color schemes (both by default). MOTION=no-preference
// reads with motion allowed; the default is reduce, so a running animation does not differ by the frame it was read at.
// Uses ports 4199 and the next one (E2E_PORT moves them), and 5199 for dev (DEV_PORT).
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";

const port = Number(process.env.E2E_PORT) || 4199, api = `http://127.0.0.1:${port}`;
const devPort = Number(process.env.DEV_PORT) || 5199;
const width = Number(process.env.WIDTH) || 900;
const schemes = (process.env.SCHEMES || "light,dark").split(",");
const motion = process.env.MOTION || "reduce";
const server = spawn("npx", ["tsx", "e2e/server.ts"], { stdio: ["ignore", "ignore", "inherit"], detached: true, env: { ...process.env, E2E_PORT: String(port) } });
process.on("exit", () => { try { process.kill(-server.pid, "SIGTERM"); } catch {} });
for (let i = 0; ; i++) { try { if ((await fetch(`${api}/api/auth/config`)).ok) break; } catch {} if (i > 120) throw new Error("no server"); await sleep(250); }
const { createServer } = await import("vite");
// The server refuses a write whose Origin is not its own, so the proxy presents the app server's origin.
const configure = proxy => proxy.on("proxyReq", request => { if (request.getHeader("origin")) request.setHeader("origin", api); });
const vite = await createServer({ logLevel: "silent", server: { port: devPort, strictPort: true, proxy: { "/api": { target: api, ws: true, configure }, "/inline-ui": api } } });
await vite.listen();

/** Every element under the body with the computed value of every property, keyed by its tag, classes and position. */
const snapshot = () => {
  const out = {};
  const skip = new Set(["SCRIPT", "STYLE", "LINK", "META", "TITLE", "HEAD", "NOSCRIPT"]);
  const walk = (element, path) => {
    const style = getComputedStyle(element);
    const values = {};
    // Custom properties are left out: the build's minifier writes their text differently, and what they feed is read here.
    for (const property of style) if (!property.startsWith("--")) values[property] = style.getPropertyValue(property);
    out[path] = values;
    [...element.children].filter(child => !skip.has(child.tagName) && !child.tagName.startsWith("VITE-")).forEach((child, index) =>
      walk(child, `${path} > ${child.tagName.toLowerCase()}${[...child.classList].map(name => `.${name}`).join("")}:${index}`));
  };
  walk(document.body, "body");
  return out;
};

/** Each screen: how to reach it from a signed-in home, and how to leave it. */
const screens = [
  ["home", async () => {}],
  ["bot menu", async page => { await page.getByRole("region", { name: "Your assistants" }).getByRole("button", { name: /Trail Cook/ }).click({ button: "right" }); await page.locator(".bot-menu").waitFor(); }],
  ["account menu", async page => { await page.getByRole("button", { name: "Account" }).click(); await page.getByRole("menu", { name: "Account" }).waitFor(); }],
  ["settings", async page => {
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: /Settings/ }).click();
    await page.locator(".settings-sheet[open]").waitFor();
  }],
  ["command palette", async page => { await page.keyboard.press("Control+k"); await page.locator(".command-palette[open]").waitFor(); }],
  ["chat", async page => {
    await page.getByRole("region", { name: "Your assistants" }).getByRole("button", { name: /Ranch Hand/ }).click();
    await page.getByText("Morning. The north fence is fixed.").waitFor();
    // The jump button shows only after scrolling up; a bare one carries the cascade's answer for its class.
    await page.evaluate(() => { const button = document.createElement("button"); button.className = "jump-latest"; button.textContent = "Latest"; document.querySelector(".conversation-panel")?.appendChild(button); });
  }],
];

const browser = await chromium.launch();
const differences = new Map();
// The minifier writes a zero position as 0px, the dev server as 0%.
const normal = (property, value) => property === "background-position" ? value.replace(/\b0px\b/g, "0%") : value;
const notes = [];
const note = (line) => differences.set(line, (differences.get(line) ?? 0) + 1);
// One line per screen, element and property however many elements share the selector, with how many do.
const last = path => path.split(" > ").at(-1).replace(/:\d+$/, "");
for (const colorScheme of schemes) {
  const read = async base => {
    const context = await browser.newContext({ baseURL: base, serviceWorkers: "block", viewport: { width, height: 700 }, reducedMotion: motion, colorScheme });
    const page = await context.newPage();
    await page.goto("/");
    // A hovered control is still easing toward its hover color, and where it is differs by when it was read.
    await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
    await page.getByRole("button", { name: "Enter local workspace" }).click();
    await page.getByRole("region", { name: "Your assistants" }).getByRole("button", { name: /Ranch Hand/ }).waitFor();
    const found = {};
    for (const [name, reach] of screens) {
      await reach(page);
      await page.waitForTimeout(150);
      found[name] = await page.evaluate(snapshot);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
    }
    await context.close();
    return found;
  };
  const built = await read(api), dev = await read(`http://127.0.0.1:${devPort}`);
  for (const [name] of screens) {
    for (const [path, values] of Object.entries(built[name])) {
      const other = dev[name][path];
      if (!other) { notes.push(`${colorScheme}  ${name}  ${last(path)}  only in the build`); continue; }
      for (const [property, value] of Object.entries(values)) if (normal(property, other[property]) !== normal(property, value)) note(`${colorScheme}  ${name}  ${last(path)}  ${property}  ${value} -> ${other[property]}`);
    }
    for (const path of Object.keys(dev[name])) if (!built[name][path]) notes.push(`${colorScheme}  ${name}  ${last(path)}  only in dev`);
  }
}
await browser.close();
await vite.close();
const lines = [...differences].map(([line, count]) => count > 1 ? `${line}  x${count}` : line);
// An element present in one and not the other is a different screen (a footnote that shows a release, say), not a cascade difference.
if (notes.length) console.error(`not compared, ${new Set(notes).size} elements in one build only`);
console.log(lines.length ? lines.join("\n") : `no differences (${schemes.join(", ")}, ${width}px, motion ${motion})`);
process.exit(lines.length ? 1 : 0);
