import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { isHashedAsset, isPreviousAsset, previousAssetFile, readPreviousAssets } from "../src/server/static-cache.js";
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

// Two releases laid out as the host lays them out: releases/<name>/dist/client, and the live one's
// dist/previous-release.json naming the replaced release's assets directory.
function releases({ name = "previous-release.json", directory }: { name?: string; directory?: (root: string) => string } = {}) {
  const root = realRoot();
  const live = join(root, "releases/live/dist"), previous = join(root, "releases/previous/dist/client");
  for (const path of [join(live, "client/assets"), join(previous, "assets"), join(root, "outside")]) mkdirSync(path, { recursive: true });
  for (const [path, body] of Object.entries({
    [join(live, "client/index.html")]: "<html>live</html>", [join(live, "client/assets/live-AbC12345.js")]: "live body",
    [join(live, "client/assets/both-AbC12345.js")]: "live copy",
    [join(previous, "assets/old-AbC12345.js")]: "old body", [join(previous, "assets/old-Zx_9-Q01.css")]: "old css",
    [join(previous, "assets/both-AbC12345.js")]: "previous copy", [join(previous, "assets/logo.png")]: "logo",
    [join(previous, "assets/old-short.js")]: "short", [join(previous, "secret-AbC12345.js")]: "SECRET beside the assets",
    [join(root, "outside/secret.js")]: "SECRET outside the release", [join(previous, "assets/index-AbC12345.js")]: "old index",
  })) writeFileSync(path, body);
  mkdirSync(join(previous, "assets/nested")); writeFileSync(join(previous, "assets/nested/old-AbC12345.js"), "nested body");
  mkdirSync(join(previous, "assets/dir-AbC12345.js"));
  symlinkSync(join(root, "outside/secret.js"), join(previous, "assets/link-AbC12345.js"));
  symlinkSync(join(root, "outside"), join(previous, "assets/folder-AbC12345.js"));
  symlinkSync(join(previous, "assets/old-AbC12345.js"), join(previous, "assets/alias-AbC12345.js"));
  const file = join(live, name);
  writeFileSync(file, JSON.stringify({ assets: directory ? directory(root) : join(previous, "assets") }));
  return { root, live, previous, file, clientRoot: join(live, "client") };
}
function realRoot() { const root = mkdtempSync(join(tmpdir(), "agent-releases-")); directories.push(root); return root; }

async function withReleases(layout: ReturnType<typeof releases>) {
  const config = loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" });
  const { app } = await createApp(config, fakeRuntime({ close: async () => {} }), { background: false, clientRoot: layout.clientRoot, previousRelease: layout.file });
  apps.push(app);
  return app;
}
const NOT_FOUND = { statusCode: 404, "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", body: "Not found" };
const summary = (response: { statusCode: number; headers: Record<string, unknown>; body: string }) =>
  ({ statusCode: response.statusCode, "cache-control": response.headers["cache-control"], "content-type": response.headers["content-type"], body: response.body });

describe("a page from the previous release after a deploy", () => {
  it("loads a hashed file only the previous release still has, cached exactly like a live asset", async () => {
    const app = await withReleases(releases());
    const live = await app.inject("/assets/live-AbC12345.js");
    const old = await app.inject("/assets/old-AbC12345.js");
    expect([old.statusCode, old.body]).toEqual([200, "old body"]);
    expect(old.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(old.headers["cache-control"]).toBe(live.headers["cache-control"]);
    expect(old.headers["content-type"]).toBe(live.headers["content-type"]);
    const css = await app.inject("/assets/old-Zx_9-Q01.css?v=1");
    expect([css.statusCode, css.body, css.headers["content-type"]]).toEqual([200, "old css", expect.stringContaining("text/css")]);
    const head = await app.inject({ method: "HEAD", url: "/assets/old-AbC12345.js" });
    expect([head.statusCode, head.headers["cache-control"]]).toEqual([200, "public, max-age=31536000, immutable"]);
  });

  it("serves the live release's copy when both have the name", async () => {
    const app = await withReleases(releases());
    expect((await app.inject("/assets/both-AbC12345.js")).body).toBe("live copy");
  });

  it("answers the uncached 404 when neither release has the file", async () => {
    const app = await withReleases(releases());
    for (const url of ["/assets/gone-AbC12345.js", "/assets/gone-AbC12345.js?v=1"])
      expect([url, summary(await app.inject(url))]).toEqual([url, NOT_FOUND]);
  });

  it("serves only hashed names directly inside the directory, though the files exist there", async () => {
    const app = await withReleases(releases());
    // Each file below is in the previous release's assets: the name rule alone refuses it.
    for (const url of ["/assets/logo.png", "/assets/old-short.js", "/assets/nested/old-AbC12345.js", "/assets/dir-AbC12345.js"])
      expect([url, summary(await app.inject(url))]).toEqual([url, NOT_FOUND]);
    // The shell and the worker are not assets: the previous release's copies are never offered for them.
    expect((await app.inject("/index.html")).body).toBe("<html>live</html>");
  });

  it("never leaves the directory, by path or by link", async () => {
    const app = await withReleases(releases());
    // A secret sits beside assets/ and another outside the release. None of these may return either.
    for (const url of ["/assets/%2e%2e/secret-AbC12345.js", "/assets/..%2fsecret-AbC12345.js", "/assets/%2e%2e%2fsecret-AbC12345.js",
      "/assets/..%5csecret-AbC12345.js", "/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2foutside%2fsecret.js", "/assets/old-AbC12345.js%00"]) {
      const response = await app.inject(url);
      // The router folds a literal `..` into /secret-AbC12345.js, which is no asset and gets the shell; the escaped
      // forms reach the asset rule and get the 404, and the static plugin refuses a backslash itself.
      // Either way no secret comes back and nothing is an error.
      const shell = response.statusCode === 200 && response.body === "<html>live</html>";
      expect([url, shell || response.statusCode >= 400 && response.statusCode < 500, response.body.includes("SECRET")]).toEqual([url, true, false]);
    }
    for (const url of ["/assets/..%2fsecret-AbC12345.js", "/assets/%2e%2e%2fsecret-AbC12345.js"])
      expect([url, summary(await app.inject(url))]).toEqual([url, NOT_FOUND]);
    // A hashed name that is a link out of the directory, to a file or to a directory, is refused.
    for (const url of ["/assets/link-AbC12345.js", "/assets/folder-AbC12345.js"])
      expect([url, summary(await app.inject(url))]).toEqual([url, NOT_FOUND]);
    // A link to another file inside the directory stays inside it.
    expect((await app.inject("/assets/alias-AbC12345.js")).body).toBe("old body");
  });

  it("answers a method that is not a read with the 404, and a malformed escape with no file", async () => {
    const layout = releases();
    const app = await withReleases(layout);
    expect(summary(await app.inject({ method: "POST", url: "/assets/old-AbC12345.js" }))).toEqual(NOT_FOUND);
    // Fastify refuses a malformed escape before routing; the lookup still holds if one ever reaches it.
    expect((await app.inject("/assets/%E0%A4%A-AbC12345.js")).statusCode).toBe(400);
    expect(previousAssetFile({ directory: join(layout.previous, "assets") }, "/assets/%E0%A4%A-AbC12345.js")).toBeUndefined();
  });

  it("follows a configured directory that is itself a link, with the same headers", async () => {
    const layout = releases({ directory: root => { symlinkSync(join(root, "releases/previous/dist/client/assets"), join(root, "previous")); return join(root, "previous"); } });
    const old = await (await withReleases(layout)).inject("/assets/old-AbC12345.js");
    expect([old.statusCode, old.body, old.headers["cache-control"]]).toEqual([200, "old body", "public, max-age=31536000, immutable"]);
  });

  it("falls back to the 404 when the previous release's directory is gone", async () => {
    const layout = releases({ directory: root => join(root, "releases/pruned/dist/client/assets") });
    const app = await withReleases(layout);
    expect(summary(await app.inject("/assets/old-AbC12345.js"))).toEqual(NOT_FOUND);
    expect((await app.inject("/assets/live-AbC12345.js")).body).toBe("live body");
  });

  it("serves nothing from a previous release the tooling never named", async () => {
    const layout = releases();
    rmSync(layout.file);
    expect(summary(await (await withReleases(layout)).inject("/assets/old-AbC12345.js"))).toEqual(NOT_FOUND);
  });

  it("reads the file the deploy tooling writes, in the place the tooling writes it", () => {
    // deploy_common.py writes <release>/dist/previous-release.json; the server reads dist/previous-release.json
    // beside dist/client. If the two drift apart the grace silently stops, so the names are compared.
    const tooling = readFileSync(".agents/tools/deploy_common.py", "utf8");
    expect(tooling).toContain('PREVIOUS_RELEASE_FILE = "dist/previous-release.json"');
    // The server derives it from the client root it serves, so the two cannot name different dist directories.
    expect(readFileSync("src/server/app.ts", "utf8")).toContain('join(dirname(clientRoot), "previous-release.json")');
  });

  it("uses the file beside dist/client when the app is started without a client root", async () => {
    const layout = releases();
    const here = process.cwd();
    process.chdir(join(layout.root, "releases/live"));
    try {
      const config = loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" });
      const { app } = await createApp(config, fakeRuntime({ close: async () => {} }), { background: false });
      apps.push(app);
      expect((await app.inject("/assets/old-AbC12345.js")).body).toBe("old body");
    } finally { process.chdir(here); }
  });
});

describe("which files in the previous release's directory are immutable", () => {
  it("counts a hashed name there and nothing else, though the directory is the right one", () => {
    const layout = releases();
    const previous = { directory: join(layout.previous, "assets") };
    const assets = join(layout.previous, "assets");
    expect(isPreviousAsset(previous, join(assets, "old-AbC12345.js"))).toBe(true);
    // previousAssetFile never sends these, but a file that lives in the directory and is served another way,
    // such as an unhashed name beside the hashed ones, must not be told to cache for a year.
    for (const name of ["logo.png", "old-short.js", "index.html"])
      expect([name, isPreviousAsset(previous, join(assets, name))]).toEqual([name, false]);
  });

  it("is false for a file outside the directory, an unnamed release and a directory that is gone", () => {
    const layout = releases();
    const previous = { directory: join(layout.previous, "assets") };
    expect(isPreviousAsset(previous, join(layout.live, "client/assets/live-AbC12345.js"))).toBe(false);
    expect(isPreviousAsset(undefined, join(layout.previous, "assets/old-AbC12345.js"))).toBe(false);
    expect(isPreviousAsset({ directory: join(layout.root, "pruned") }, join(layout.root, "pruned/old-AbC12345.js"))).toBe(false);
  });
});

describe("the file naming the previous release's assets", () => {
  it("is read only when it is an object whose assets is an absolute path, and says why when it is not", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-previous-"));
    directories.push(directory);
    const file = join(directory, "previous-release.json");
    const read = (text: string) => { writeFileSync(file, text); const warnings: string[] = []; return { previous: readPreviousAssets(file, message => warnings.push(message)), warnings }; };
    expect(read('{"assets": "/srv/releases/old/dist/client/assets"}')).toEqual({ previous: { directory: "/srv/releases/old/dist/client/assets" }, warnings: [] });
    for (const bad of ["{", "[]", "null", '"/srv/assets"', "{}", '{"assets": 7}', '{"assets": ["/srv/assets"]}', '{"assets": "releases/old/assets"}'])
      expect([bad, read(bad)]).toEqual([bad, { previous: undefined, warnings: [expect.stringContaining('"assets" is an absolute path')] }]);
    // A file that is not there is the normal first release, not worth a warning.
    const warnings: string[] = [];
    expect(readPreviousAssets(join(directory, "missing.json"), message => warnings.push(message))).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(readPreviousAssets(directory, message => warnings.push(message))).toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining("EISDIR")]);
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
