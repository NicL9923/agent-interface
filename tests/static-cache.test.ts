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

async function client() {
  const root = mkdtempSync(join(tmpdir(), "agent-static-"));
  directories.push(root);
  mkdirSync(join(root, "assets"));
  for (const file of [
    "index.html", "sw.js", "manifest.webmanifest", "icon-192.png", "index-AbC12345.js",
    "assets/index-AbC12345.js", "assets/xterm-Zx_9-Q01.css", "assets/logo.png",
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
    for (const url of ["/index.html", "/sw.js"])
      expect((await app.inject(url)).headers["cache-control"]).toBe("no-cache");
    // A hash-shaped name outside assets/ and an unhashed name inside it are not content-addressed.
    for (const url of ["/manifest.webmanifest", "/icon-192.png", "/index-AbC12345.js", "/assets/logo.png"])
      expect((await app.inject(url)).headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("serves the shell, never a cached asset, for a route the client handles", async () => {
    const app = await client();
    const response = await app.inject("/assets/gone-AbC12345.js");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers["content-type"]).toContain("text/html");
  });

  it("recognizes hashed assets only inside the assets directory", () => {
    expect(isHashedAsset("/srv/client", "/srv/client/assets/index-AbC12345.js")).toBe(true);
    expect(isHashedAsset("/srv/client", "/srv/client/assets/addon-fit-DIOBYJe3.js")).toBe(true);
    expect(isHashedAsset("/srv/client", "/srv/client/assets/nested/index-AbC12345.js")).toBe(false);
    expect(isHashedAsset("/srv/client", "/srv/client/assets/index-short.js")).toBe(false);
  });
});
