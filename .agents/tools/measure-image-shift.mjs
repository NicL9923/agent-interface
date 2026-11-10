#!/usr/bin/env node
// Measures layout shift from transcript images in real Chromium against e2e/server.ts. The Ranch Hand's chat read is
// given six image files of different shapes, followed by one text reply, and each image is served only after a delay,
// as on a slow network; the rest of the page runs under Chromium's network emulation (400 ms latency, 400 kbit/s).
// Scenarios, each in a fresh page so no image size is known in advance:
//   open    the chat opens from its link; cumulative layout shift (CLS) over the images' arrival, and how far the last
//           message ends from the bottom of the view, which "follow" mode pins it to.
//   reader  the reader scrolls up with the wheel by 300, 900 and 1500 px before the images arrive; which images were
//           then above, in and below the view, how far the first message below the view's top moved while they
//           loaded ("keep the reader's place"), and the most any message then in view moved.
//   send    the person attaches an image and sends; how far the sent message moves from where the send anchor put it
//           while its image loads, and the CLS meanwhile. send-images does the same while the six images above it load.
//   failed  the six images, the third answering 404 after its delay; that image's link height before and after.
//   special an animated GIF and a 8000 x 4500 PNG: their frames after load, whether the GIF's frame changes on screen.
// --shapes far swaps the six shapes for six far from 4:3. --viewport sets the page's size, 1280x800 by default.
// The reader and send scenarios also sample the followed message every frame twice: in requestAnimationFrame, before
// that frame's layout and ResizeObserver callbacks, and in a ResizeObserver made in that callback, which runs after the
// app's own observers and so reads the position the frame paints. Each reports the largest step between two frames.
// A move larger than the transcript's content height cannot be real; it is reported as a measurement fault with both
// readings and that height, never as a number of pixels. The open scenario reports each image frame's box.
// Run `npm run build` first. It uses port 4187 and the next one; E2E_PORT picks others. It can measure another build:
// run it with that build's checkout as the working directory.
//   node .agents/tools/measure-image-shift.mjs [--runs 3] [--only open,reader,send,send-images,failed,special] [--shapes mixed|far] [--viewport 390x844]
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const RUNS = Number(flag("--runs", 3));
const ONLY = new Set(flag("--only", "open,reader,send,send-images,failed,special").split(","));
const SHAPES = flag("--shapes", "mixed");
const [VIEW_WIDTH, VIEW_HEIGHT] = flag("--viewport", "1280x800").split("x").map(Number);
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
/** A looping GIF of solid frames. LZW codes stay 9 bits wide: a clear code every 254 literals keeps the table small. */
function gif(width, height, colors) {
  const bytes = [...Buffer.from("GIF89a"), width & 255, width >> 8, height & 255, height >> 8, 0xf7, 0, 0];
  for (let index = 0; index < 256; index++) bytes.push(...(colors[index] ?? [0, 0, 0]));
  bytes.push(0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0);
  colors.forEach((_, color) => {
    bytes.push(0x21, 0xf9, 4, 0, 30, 0, 0, 0, 0x2c, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0, 8);
    const out = [];
    let buffer = 0, bits = 0;
    const put = code => { buffer |= code << bits; bits += 9; while (bits >= 8) { out.push(buffer & 255); buffer >>= 8; bits -= 8; } };
    for (let pixel = 0; pixel < width * height; pixel++) { if (pixel % 254 === 0) put(256); put(color); }
    put(257);
    if (bits) out.push(buffer & 255);
    for (let at = 0; at < out.length; at += 255) bytes.push(Math.min(255, out.length - at), ...out.slice(at, at + 255));
    bytes.push(0);
  });
  return Buffer.from([...bytes, 0x3b]);
}
const shapes = SHAPES === "far"
  ? [[1920, 1080], [1170, 2532], [2520, 1080], [1000, 1000], [900, 1600], [3000, 1000]]
  : [[1600, 1200], [1920, 1080], [1170, 2532], [1000, 1000], [900, 1200], [2520, 1080]];
const images = shapes.map(([width, height], index) => ({ id: `img-${index + 1}`, width, height, body: png(width, height, [40 + index * 30, 120, 200 - index * 20]), delay: 1200 + index * 250 }));
const specials = [
  { id: "anim-1", name: "spinner.gif", mime: "image/gif", width: 480, height: 270, body: gif(480, 270, [[220, 60, 60], [60, 60, 220]]), delay: 1200 },
  { id: "huge-1", name: "survey.png", mime: "image/png", width: 8000, height: 4500, body: png(8000, 4500, [90, 160, 90]), delay: 1500 },
];
const upload = { id: "up-1", width: 1600, height: 900, body: png(1600, 900, [200, 90, 60]), delay: 2000 };

const browser = await chromium.launch();
async function page({ withImages, special = false, failing }) {
  const context = await browser.newContext({ baseURL: base, serviceWorkers: "block", viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT } });
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
  const shown = special ? specials : images;
  if (withImages) await tab.route("**/api/bots/ranch/conversation*", async route => {
    const response = await fresh(route), body = await response.json();
    const seed = body.messages.filter(message => message.id === "seed-1");
    const rest = body.messages.filter(message => message.id !== "seed-1");
    body.messages = [...seed, ...shown.map((image, index) => ({ id: `photo-${index + 1}`, role: "assistant", text: `Photo ${index + 1} of the north fence.`,
      createdAt: "2026-11-05T14:0" + index + ":00Z", files: [{ id: image.id, name: image.name ?? `fence-${index + 1}.png`, mime: image.mime ?? "image/png" }] })),
      { id: "last", role: "assistant", text: "That is every post on the north line.", createdAt: "2026-11-05T14:10:00Z" }, ...rest];
    await route.fulfill({ status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, json: body });
  });
  await tab.route("**/api/files/*", async route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
    const image = [...images, ...specials, upload].find(item => item.id === id);
    if (!image) return route.fulfill({ status: 404 });
    await sleep(image.delay);
    if (id === failing) return route.fulfill({ status: 404 });
    await route.fulfill({ status: 200, contentType: image.mime ?? "image/png", body: image.body });
  });
  // The faked upload is not one the server knows, so the send is held unanswered: its echo stays, sending, to measure.
  await tab.route("**/api/bots/ranch/messages", () => {});
  await tab.route("**/api/bots/ranch/uploads", route => route.fulfill({ json: { id: upload.id, name: "gate.png", mime: "image/png", size: upload.body.length } }));
  return { tab, context };
}
/**
 * A move between two readings of one element's top, or a fault when it is larger than the scroller's content: no move
 * inside the transcript can exceed its own height, so such a reading is a measurement fault, not a shift.
 */
function moved(start, end, contentHeight) {
  const value = Math.round(end - start);
  return Math.abs(value) > contentHeight ? { fault: "move larger than the transcript's content height", start, end, contentHeight } : value;
}
const contentHeight = tab => tab.evaluate(() => document.querySelector('[role="region"][aria-label="Conversation"]').scrollHeight);
/** Starts sampling one message's top every frame, before layout and as painted; the returned function stops it. */
async function sampleFrames(tab, selector) {
  await tab.evaluate(selector => {
    const top = () => document.querySelector(selector)?.getBoundingClientRect().top;
    const series = window.__frames = { early: [], painted: [], stop: false };
    const frame = () => {
      series.early.push(top());
      // Made now, so it is the last observer the browser calls this frame: after the transcript's own correction.
      const late = new ResizeObserver(() => { late.disconnect(); series.painted.push(top()); });
      late.observe(document.body);
      if (!series.stop) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, selector);
  return async () => {
    const [series, height] = await Promise.all([tab.evaluate(() => { window.__frames.stop = true; return window.__frames; }), contentHeight(tab)]);
    const largest = values => {
      let best = { step: 0 };
      for (let index = 1; index < values.length; index++) {
        if (values[index] === undefined || values[index - 1] === undefined) continue;
        const step = moved(values[index - 1], values[index], height);
        if (typeof step === "object") return step;
        if (Math.abs(step) > Math.abs(best.step)) best = { step, frame: index, from: Math.round(values[index - 1]), to: Math.round(values[index]) };
      }
      return best;
    };
    return { frames: series.painted.length, beforeLayoutPx: largest(series.early), paintedPx: largest(series.painted) };
  };
}
const cls = tab => tab.evaluate(() => ({ all: window.__shifts.reduce((sum, item) => sum + item.value, 0), counted: window.__shifts.filter(item => !item.input).reduce((sum, item) => sum + item.value, 0), shifts: window.__shifts.length }));
// Settled: each image loaded, or failed and gone from the frame (or, before frames, complete with no size).
const allLoaded = tab => tab.waitForFunction(() => [...document.querySelectorAll(".file-link")].every(link => {
  const img = link.querySelector("img");
  return img ? img.complete && (img.naturalWidth > 0 || !link.querySelector(".file-frame")) : true;
}), null, { timeout: 60_000 });
const linkHeight = (tab, id) => tab.evaluate(id => Math.round(document.querySelector(`[data-message-id="${id}"] .file-link`).getBoundingClientRect().height * 10) / 10, id);

const results = { open: [], reader: [], send: [], "send-images": [], failed: [], special: [] };
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
    const frames = await tab.evaluate(() => [...document.querySelectorAll(".file-link img")].map(img => {
      const box = img.parentElement.getBoundingClientRect();
      return `${img.naturalWidth}x${img.naturalHeight} in ${Math.round(box.width)}x${Math.round(box.height)}`;
    }));
    results.open.push({ ...await cls(tab), endFromBottomPx: gap, frames });
    await context.close();
  }
  if (ONLY.has("reader")) for (const up of [300, 900, 1500]) {
    const { tab, context } = await page({ withImages: true });
    await tab.goto("/?bot=ranch");
    await tab.getByText("That is every post on the north line.").waitFor();
    const view = tab.getByRole("region", { name: "Conversation" });
    await view.hover();
    await tab.mouse.wheel(0, -up);
    await sleep(300);
    const mark = () => tab.evaluate(() => {
      const view = document.querySelector('[role="region"][aria-label="Conversation"]'), box = view.getBoundingClientRect();
      const rows = [...view.querySelectorAll("[data-message-id]")];
      const first = rows.find(row => row.getBoundingClientRect().top >= box.top);
      const visible = Object.fromEntries(rows.filter(row => row.getBoundingClientRect().bottom > box.top && row.getBoundingClientRect().top < box.bottom)
        .map(row => [row.dataset.messageId, row.getBoundingClientRect().top]));
      const where = Object.fromEntries([...view.querySelectorAll("[data-message-id^='photo-']")].map(row => {
        const { top, bottom } = row.getBoundingClientRect();
        return [row.dataset.messageId, bottom <= box.top ? "above" : top >= box.bottom ? "below" : "in"];
      }));
      return { id: first?.dataset.messageId, top: first?.getBoundingClientRect().top, visible, where };
    });
    const before = await mark();
    const frames = await sampleFrames(tab, `[data-message-id="${before.id}"]`);
    await allLoaded(tab);
    await sleep(1000);
    const perFrame = await frames();
    const after = await tab.evaluate(ids => Object.fromEntries(ids.map(id => [id, document.querySelector(`[data-message-id="${id}"]`).getBoundingClientRect().top])),
      [...new Set([before.id, ...Object.keys(before.visible)])]);
    const height = await contentHeight(tab);
    const inView = Object.entries(before.visible).map(([id, top]) => moved(top, after[id], height));
    results.reader.push({ wheelUpPx: up, images: before.where, message: before.id, movedPx: moved(before.top, after[before.id], height),
      inViewMaxMovedPx: inView.find(item => typeof item === "object") ?? Math.max(...inView.map(Math.abs)), perFrame, ...await cls(tab) });
    await context.close();
  }
  for (const scenario of ["send", "send-images"]) if (ONLY.has(scenario)) {
    const { tab, context } = await page({ withImages: scenario === "send-images" });
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
    await sent.evaluate(element => { element.dataset.measured = ""; });
    const frames = await sampleFrames(tab, ".message-user[data-measured]");
    await tab.waitForFunction(() => [...document.querySelectorAll(".message-user .file-link img")].some(img => img.complete && img.naturalWidth), null, { timeout: 30_000 });
    await sleep(800);
    const end = await sent.evaluate(element => element.getBoundingClientRect().top);
    if (scenario === "send-images") await allLoaded(tab);
    await sleep(800);
    const settled = await sent.evaluate(element => element.getBoundingClientRect().top);
    const height = await contentHeight(tab);
    results[scenario].push({ ...await cls(tab), sentMessageMovedPx: moved(start, end, height), afterAllImagesPx: moved(start, settled, height), perFrame: await frames() });
    await context.close();
  }
  if (ONLY.has("failed")) {
    const { tab, context } = await page({ withImages: true, failing: "img-3" });
    await tab.goto("/?bot=ranch");
    await tab.getByText("That is every post on the north line.").waitFor();
    await tab.locator('[data-message-id="photo-3"] .file-link').waitFor();
    const pending = await linkHeight(tab, "photo-3");
    await allLoaded(tab);
    await sleep(1000);
    results.failed.push({ ...await cls(tab), pendingPx: pending, failedPx: await linkHeight(tab, "photo-3"),
      shows: await tab.evaluate(() => document.querySelector('[data-message-id="photo-3"] .file-link').innerText.replace(/\s+/g, " ").trim()) });
    await context.close();
  }
  if (ONLY.has("special")) {
    const { tab, context } = await page({ withImages: true, special: true });
    await tab.goto("/?bot=ranch");
    await tab.getByText("That is every post on the north line.").waitFor();
    const pending = { gif: await linkHeight(tab, "photo-1"), huge: await linkHeight(tab, "photo-2") };
    await allLoaded(tab);
    await sleep(1000);
    const frames = await tab.evaluate(() => [...document.querySelectorAll(".file-link img")].map(img => ({ natural: `${img.naturalWidth}x${img.naturalHeight}`,
      box: `${Math.round(img.getBoundingClientRect().width)}x${Math.round(img.getBoundingClientRect().height)}` })));
    const gif = tab.locator('[data-message-id="photo-1"] .file-link img');
    await gif.scrollIntoViewIfNeeded();
    const shots = [];
    for (let shot = 0; shot < 4; shot++) { shots.push((await gif.screenshot()).toString("base64")); await sleep(150); }
    results.special.push({ ...await cls(tab), pendingPx: pending, settledPx: { gif: await linkHeight(tab, "photo-1"), huge: await linkHeight(tab, "photo-2") },
      frames, gifChangesOnScreen: new Set(shots).size > 1 });
    await context.close();
  }
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
stop();
process.exit(0);
