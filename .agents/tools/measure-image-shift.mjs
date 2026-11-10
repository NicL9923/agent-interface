#!/usr/bin/env node
// Measures layout shift from transcript images in real Chromium against e2e/server.ts. The Ranch Hand's chat read is
// given six image files of different shapes, followed by one text reply, and each image is served only after a delay,
// as on a slow network; the rest of the page runs under Chromium's network emulation (400 ms latency, 400 kbit/s).
// Three scenarios, each in a fresh page so no image size is known in advance:
//   open    the chat opens from its link; cumulative layout shift (CLS) over the images' arrival, and how far the last
//           message ends from the bottom of the view, which "follow" mode pins it to.
//   reader  the reader scrolls up with the wheel before the images arrive; how far the first message below the
//           view's top moves while they load ("keep the reader's place").
//   send    the person attaches an image and sends; how far the sent message moves from where the send anchor put it
//           while its image loads, and the CLS meanwhile.
// Run `npm run build` first. It uses port 4187 and the next one; E2E_PORT picks others.
//   node .agents/tools/measure-image-shift.mjs [--runs 3] [--only open,reader,send]
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const RUNS = Number(flag("--runs", 3));
const ONLY = new Set(flag("--only", "open,reader,send").split(","));
const port = Number(process.env.E2E_PORT) || 4187, base = `http://127.0.0.1:${port}`;
if (await fetch(`${base}/api/auth/config`).then(() => true, () => false)) throw new Error(`Port ${port} is taken; set E2E_PORT.`);
const server = spawn("npx", ["tsx", "e2e/server.ts"], { stdio: ["ignore", "ignore", "inherit"], detached: true, env: { ...process.env, E2E_PORT: String(port) } });
const stop = () => { try { process.kill(-server.pid, "SIGTERM"); } catch { /* Already gone. */ } };
process.on("exit", stop);
for (let tries = 0; ; tries++) {
  try { if ((await fetch(`${base}/api/auth/config`)).ok) break; } catch { /* Not up yet. */ }
  if (tries > 120) throw new Error("e2e server did not start");
  await sleep(250);
}

// A solid PNG of the given size, so each image has a known shape and a real decode.
function png(width, height, [r, g, b]) {
  const crc = buffer => { let c = ~0; for (const byte of buffer) { c ^= byte; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return ~c >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length); out.write(type, 4); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.alloc(1 + width * 3); for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}
const shapes = [[1600, 1200], [1920, 1080], [1170, 2532], [1000, 1000], [900, 1200], [2520, 1080]];
const images = shapes.map(([width, height], index) => ({ id: `img-${index + 1}`, width, height, body: png(width, height, [40 + index * 30, 120, 200 - index * 20]), delay: 1200 + index * 250 }));
const upload = { id: "up-1", width: 1600, height: 900, body: png(1600, 900, [200, 90, 60]), delay: 2000 };

const browser = await chromium.launch();
async function page({ withImages }) {
  const context = await browser.newContext({ baseURL: base, serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    window.__shifts = [];
    new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__shifts.push({ value: entry.value, input: entry.hadRecentInput, at: entry.startTime }); })
      .observe({ type: "layout-shift", buffered: true });
  });
  const signIn = await context.newPage();
  await signIn.goto("/");
  await signIn.getByRole("button", { name: "Enter local workspace" }).click();
  await signIn.getByRole("region", { name: "Your assistants" }).waitFor();
  await signIn.close();
  const tab = await context.newPage();
  const cdp = await context.newCDPSession(tab);
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 });
  // Fetched whole every time, without the page's validators, so each read can be rewritten.
  const fresh = route => { const headers = { ...route.request().headers() }; delete headers["if-none-match"]; delete headers["if-modified-since"]; return route.fetch({ headers }); };
  await tab.route("**/api/bootstrap*", async route => {
    const response = await fresh(route), body = await response.json();
    body.capabilities.uploads = { supported: true };
    await route.fulfill({ status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, json: body });
  });
  if (withImages) await tab.route("**/api/bots/ranch/conversation*", async route => {
    const response = await fresh(route), body = await response.json();
    const seed = body.messages.filter(message => message.id === "seed-1");
    const rest = body.messages.filter(message => message.id !== "seed-1");
    body.messages = [...seed, ...images.map((image, index) => ({ id: `photo-${index + 1}`, role: "assistant", text: `Photo ${index + 1} of the north fence.`,
      createdAt: "2026-11-05T14:0" + index + ":00Z", files: [{ id: image.id, name: `fence-${index + 1}.png`, mime: "image/png" }] })),
      { id: "last", role: "assistant", text: "That is every post on the north line.", createdAt: "2026-11-05T14:10:00Z" }, ...rest];
    await route.fulfill({ status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, json: body });
  });
  await tab.route("**/api/files/*", async route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
    const image = [...images, upload].find(item => item.id === id);
    if (!image) return route.fulfill({ status: 404 });
    await sleep(image.delay);
    await route.fulfill({ status: 200, contentType: "image/png", body: image.body });
  });
  // The faked upload is not one the server knows, so the send is held unanswered: its echo stays, sending, to measure.
  await tab.route("**/api/bots/ranch/messages", () => {});
  await tab.route("**/api/bots/ranch/uploads", route => route.fulfill({ json: { id: upload.id, name: "gate.png", mime: "image/png", size: upload.body.length } }));
  return { tab, context };
}
const cls = tab => tab.evaluate(() => ({ all: window.__shifts.reduce((sum, item) => sum + item.value, 0), counted: window.__shifts.filter(item => !item.input).reduce((sum, item) => sum + item.value, 0), shifts: window.__shifts.length }));
const allLoaded = tab => tab.waitForFunction(() => [...document.querySelectorAll(".file-link img")].every(img => img.complete && img.naturalWidth), null, { timeout: 30_000 });

const results = { open: [], reader: [], send: [] };
for (let run = 0; run < RUNS; run++) {
  if (ONLY.has("open")) {
    const { tab, context } = await page({ withImages: true });
    await tab.goto("/?bot=ranch");
    await tab.getByText("That is every post on the north line.").waitFor();
    await allLoaded(tab);
    await sleep(1000);
    const gap = await tab.evaluate(() => {
      const view = document.querySelector('[role="region"][aria-label="Conversation"]');
      return Math.round(view.scrollHeight - view.scrollTop - view.clientHeight);
    });
    results.open.push({ ...await cls(tab), endFromBottomPx: gap });
    await context.close();
  }
  if (ONLY.has("reader")) {
    const { tab, context } = await page({ withImages: true });
    await tab.goto("/?bot=ranch");
    await tab.getByText("That is every post on the north line.").waitFor();
    const view = tab.getByRole("region", { name: "Conversation" });
    await view.hover();
    await tab.mouse.wheel(0, -500);
    await sleep(300);
    const mark = () => tab.evaluate(() => {
      const view = document.querySelector('[role="region"][aria-label="Conversation"]'), top = view.getBoundingClientRect().top;
      const rows = [...view.querySelectorAll("[data-message-id]")];
      const first = rows.find(row => row.getBoundingClientRect().top >= top);
      return { id: first?.dataset.messageId, top: first?.getBoundingClientRect().top };
    });
    const before = await mark();
    await allLoaded(tab);
    await sleep(1000);
    const after = await tab.evaluate(id => document.querySelector(`[data-message-id="${id}"]`).getBoundingClientRect().top, before.id);
    results.reader.push({ message: before.id, movedPx: Math.round(after - before.top) });
    await context.close();
  }
  if (ONLY.has("send")) {
    const { tab, context } = await page({ withImages: false });
    await tab.goto("/?bot=ranch");
    await tab.getByText("Morning. The north fence is fixed.").waitFor();
    await tab.locator('input[type="file"]').first().setInputFiles({ name: "gate.png", mimeType: "image/png", buffer: upload.body });
    await tab.getByRole("button", { name: "Preview gate.png" }).waitFor();
    await tab.waitForFunction(() => document.querySelector(".attachment-thumb img")?.complete);
    await tab.getByRole("textbox", { name: "Message Ranch Hand" }).fill("The gate, as it hangs now");
    await tab.getByRole("button", { name: "Send message" }).click();
    const sent = tab.locator(".message-user").filter({ hasText: "The gate, as it hangs now" }).last();
    await sent.waitFor();
    await sleep(600);
    const start = await sent.evaluate(element => element.getBoundingClientRect().top);
    await tab.waitForFunction(() => [...document.querySelectorAll(".message-user .file-link img")].some(img => img.complete && img.naturalWidth), null, { timeout: 30_000 });
    await sleep(800);
    const end = await sent.evaluate(element => element.getBoundingClientRect().top);
    results.send.push({ ...await cls(tab), sentMessageMovedPx: Math.round(end - start) });
    await context.close();
  }
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
stop();
process.exit(0);
