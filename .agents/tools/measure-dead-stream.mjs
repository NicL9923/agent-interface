#!/usr/bin/env node
// Times how long the web app takes to notice event streams a network silently cut. It runs real Chromium
// against e2e/server.ts through a TCP proxy on port 4180. At the cut, the proxy stops forwarding every
// open connection without closing it, as a proxy, a sleeping laptop or a phone's radio can. New
// connections pass, so a reconnect works. Prints JSON: seconds from the cut to each stream's next open.
// Run `npm run build` first; ports 4173, 4174 and 4180 must be free.
//   node .agents/tools/measure-dead-stream.mjs [--give-up-ms 180000]
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const at = args.indexOf("--give-up-ms");
const GIVE_UP_MS = at < 0 ? 180_000 : Number(args[at + 1]);
const PROXY = 4180, APP = 4173;

const server = spawn("npx", ["tsx", "e2e/server.ts"], { stdio: ["ignore", "inherit", "inherit"], detached: true });
const stop = () => { try { process.kill(-server.pid, "SIGTERM"); } catch { /* Already gone. */ } };
process.on("exit", stop);
for (let tries = 0; ; tries++) {
  try { if ((await fetch(`http://127.0.0.1:${APP}/api/auth/config`)).ok) break; } catch { /* Not up yet. */ }
  if (tries > 120) throw new Error("e2e server did not start");
  await sleep(250);
}

// Each connection forwards both ways until the cut, which stops the bytes and leaves the sockets open.
const open = new Set();
const proxy = createServer(client => {
  const upstream = connect(APP, "127.0.0.1");
  const pair = { client, upstream };
  open.add(pair);
  client.pipe(upstream);
  upstream.pipe(client);
  const forget = () => { open.delete(pair); client.destroy(); upstream.destroy(); };
  client.on("error", forget); upstream.on("error", forget); client.on("close", forget); upstream.on("close", forget);
});
await new Promise(resolve => proxy.listen(PROXY, "127.0.0.1", resolve));
const cut = () => {
  for (const { client, upstream } of open) {
    client.unpipe(upstream); upstream.unpipe(client);
    client.pause(); upstream.pause();
  }
  open.clear();
};

const browser = await chromium.launch();
const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
// Sign-in checks the request's origin against the app's own, so it goes direct. The session cookie
// names the host, not the port, so the proxied page carries it.
await page.goto(`http://127.0.0.1:${APP}/`);
await page.getByRole("button", { name: "Enter local workspace" }).click();
await page.getByRole("region", { name: "Your assistants" }).waitFor();
await page.goto(`http://127.0.0.1:${PROXY}/?bot=ranch`);
await page.getByRole("region", { name: "Conversation" }).waitFor();
await sleep(8_000);

const streams = { household: /^\/api\/events(\?|$)/, chat: /^\/api\/bots\/ranch\/events/ };
const reopened = {};
let cutAt = 0;
page.on("request", request => {
  if (!cutAt) return;
  const url = new URL(request.url());
  for (const [name, pattern] of Object.entries(streams))
    if (!(name in reopened) && pattern.test(url.pathname + url.search)) reopened[name] = (Date.now() - cutAt) / 1000;
});
cut();
cutAt = Date.now();
while (Object.keys(reopened).length < Object.keys(streams).length && Date.now() - cutAt < GIVE_UP_MS) await sleep(250);
for (const name of Object.keys(streams)) reopened[name] ??= null;
console.log(JSON.stringify({ secondsToReopen: reopened, gaveUpAfterSeconds: GIVE_UP_MS / 1000 }, null, 2));
await browser.close();
proxy.close();
stop();
process.exit(0);
