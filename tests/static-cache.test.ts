import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { isHashedAsset } from "../src/server/static-cache.js";
import { fakeRuntime } from "./helpers/server.js";

const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function client({ boot = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-static-"));
  directories.push(root);
  mkdirSync(join(root, "assets"));
  for (const file of [
    "index.html", "native-computer.html", "sw.js", "manifest.webmanifest", "icon-192.png", "index-AbC12345.js",
    "assets/index-AbC12345.js", "assets/xterm-Zx_9-Q01.css", "assets/logo.png", ...boot ? ["boot.js"] : [],
  ]) writeFileSync(join(root, file), "x");
  const config = loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" });
  const { app } = await createApp(config, fakeRuntime({ close: async () => {} }), { background: false, clientRoot: root });
  apps.push(app);
  return app;
}

describe("client cache headers", () => {
  it("lets browsers keep content-hashed assets for a year", async () => {
    const app = await client();
    for (const url of ["/assets/index-AbC12345.js", "/assets/xterm-Zx_9-Q01.css"])
      expect((await app.inject(url)).headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("keeps the shell, worker, manifest and unhashed files revalidating", async () => {
    const app = await client();
    // boot.js must be the copy of the shell that loads it, so it is never kept for an hour.
    for (const url of ["/index.html", "/sw.js", "/boot.js"])
      expect((await app.inject(url)).headers["cache-control"]).toBe("no-cache");
    // A hash-shaped name outside assets/ and an unhashed name inside it are not content-addressed.
    for (const url of ["/manifest.webmanifest", "/icon-192.png", "/index-AbC12345.js", "/assets/logo.png"])
      expect((await app.inject(url)).headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("serves the shell, never a cached asset, for a route the client handles", async () => {
    const app = await client();
    for (const url of ["/today", "/assetsgone-AbC12345.js", "/?bot=ranch&view=today"]) {
      const response = await app.inject(url);
      expect([url, response.statusCode, response.headers["cache-control"], response.headers["content-type"]])
        .toEqual([url, 200, "no-cache", expect.stringContaining("text/html")]);
    }
  });

  it("answers a bundle a release retired with an uncached 404 that is not the shell", async () => {
    const app = await client();
    for (const url of ["/assets/gone-AbC12345.js", "/assets/gone-AbC12345.css?v=1", "/assets/nested/gone.js"]) {
      const response = await app.inject(url);
      expect([url, response.statusCode, response.headers["cache-control"], response.headers["content-type"], response.body])
        .toEqual([url, 404, "no-store", "text/plain; charset=utf-8", "Not found"]);
    }
  });

  it("answers a missing boot.js with an uncached 404, never the shell as a script", async () => {
    const app = await client({ boot: false });
    for (const url of ["/boot.js", "/boot.js?v=1"]) {
      const response = await app.inject(url);
      expect([url, response.statusCode, response.headers["cache-control"], response.body]).toEqual([url, 404, "no-store", "Not found"]);
    }
  });

  it("serves boot.js as a script the app's policy lets the shell run", async () => {
    const app = await client();
    const response = await app.inject("/boot.js");
    expect(response.headers["content-type"]).toMatch(/^(text|application)\/javascript/);
    // An external same-origin script: 'self' allows it, and no inline script is allowed for it.
    const scripts = String(response.headers["content-security-policy"]).split("; ").find(directive => directive.startsWith("script-src "));
    expect(scripts).toBe("script-src 'self' https://accounts.google.com/gsi/client");
  });

  it("recognizes hashed assets only inside the assets directory", () => {
    expect(isHashedAsset("/srv/client", "/srv/client/assets/index-AbC12345.js")).toBe(true);
    expect(isHashedAsset("/srv/client", "/srv/client/assets/addon-fit-DIOBYJe3.js")).toBe(true);
    expect(isHashedAsset("/srv/client", "/srv/client/assets/nested/index-AbC12345.js")).toBe(false);
    expect(isHashedAsset("/srv/client", "/srv/client/assets/index-short.js")).toBe(false);
  });
});

describe("native shared desktop page", () => {
  it("serves the viewer at /native/computer with the app's content security policy, revalidating", async () => {
    const app = await client();
    const response = await app.inject("/native/computer");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-cache");
    const policy = String(response.headers["content-security-policy"]);
    for (const directive of ["default-src 'self'", "script-src 'self' https://accounts.google.com/gsi/client", "connect-src 'self' ws://127.0.0.1:3000", "object-src 'none'", "frame-ancestors 'none'"])
      expect(policy).toContain(directive);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });
});
