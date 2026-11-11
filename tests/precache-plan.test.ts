import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { assertPopupLibraryIsLazy, precachePlan } from "../scripts/precache-plan.mjs";

const manifest = {
  "index.html": { file: "assets/index-a.js", isEntry: true, css: ["assets/index-a.css"], assets: ["assets/font-f.woff2"], imports: ["_shared-s.js"] },
  // The iOS app's desktop viewer is a second HTML entry with its own graph.
  "native-computer.html": { file: "assets/native-n.js", isEntry: true, css: ["assets/native-n.css"], imports: ["_shared-s.js", "_native-only-o.js"] },
  "_shared-s.js": { file: "assets/shared-s.js" },
  "_native-only-o.js": { file: "assets/native-only-o.js" },
  "src/BotSettings.tsx": { file: "assets/BotSettings-b.js", isDynamicEntry: true, css: ["assets/BotSettings-b.css"], assets: ["assets/photo-p.png"], imports: ["_shared-s.js", "_lazy-shared-l.js"] },
  "_lazy-shared-l.js": { file: "assets/lazy-shared-l.js" },
  "node_modules/@novnc/novnc/core/rfb.js": { file: "assets/rfb-c.js", isDynamicEntry: true, imports: ["_shared-s.js", "_remote-r.js"] },
  "node_modules/@xterm/xterm/lib/xterm.mjs": { file: "assets/xterm-d.js", isDynamicEntry: true },
  "_remote-r.js": { file: "assets/remote-r.js" },
};
const files = [
  "index.html", "native-computer.html", "manifest.webmanifest", "icon-192.png",
  "assets/index-a.js", "assets/index-a.css", "assets/font-f.woff2", "assets/native-n.js", "assets/native-n.css",
  "assets/shared-s.js", "assets/native-only-o.js",
  "assets/BotSettings-b.js", "assets/BotSettings-b.css", "assets/photo-p.png", "assets/lazy-shared-l.js",
  "assets/rfb-c.js", "assets/xterm-d.js", "assets/remote-r.js", "voice-previews/marin.m4a", "voice-previews/cedar.m4a",
].sort();

describe("service worker precache plan", () => {
  it("installs the pages and both entries' static graphs, so the app opens offline", () => {
    const { install } = precachePlan(manifest, files);
    expect(install).toEqual([
      "assets/font-f.woff2", "assets/index-a.css", "assets/index-a.js", "assets/native-n.css", "assets/native-n.js",
      "assets/native-only-o.js", "assets/shared-s.js", "icon-192.png", "index.html", "manifest.webmanifest", "native-computer.html",
    ]);
  });

  it("warms lazy screens and what only they import, without installing them", () => {
    const { warm, install } = precachePlan(manifest, files);
    expect(warm).toEqual(["assets/BotSettings-b.css", "assets/BotSettings-b.js", "assets/lazy-shared-l.js", "assets/photo-p.png"]);
    expect(install).not.toContain("assets/BotSettings-b.js");
  });

  it("leaves the terminal and remote desktop code to first use", () => {
    const { onDemand, install, warm } = precachePlan(manifest, files);
    expect(onDemand).toEqual(["assets/remote-r.js", "assets/rfb-c.js", "assets/xterm-d.js"]);
    expect([...install, ...warm].filter((file) => onDemand.includes(file))).toEqual([]);
  });

  it("leaves voice previews to the network, so no visit downloads them unasked", () => {
    const { network } = precachePlan(manifest, files);
    expect(network).toEqual(["voice-previews/cedar.m4a", "voice-previews/marin.m4a"]);
  });

  it("puts every built file in exactly one group", () => {
    const { install, warm, onDemand, network } = precachePlan(manifest, files);
    expect([...install, ...warm, ...onDemand, ...network].sort()).toEqual(files);
  });

  it("fails the build when no admin-only chunk is found, instead of quietly precaching them again", () => {
    const { "node_modules/@novnc/novnc/core/rfb.js": _rfb, "node_modules/@xterm/xterm/lib/xterm.mjs": _xterm, ...app } = manifest;
    expect(() => precachePlan(app, files)).toThrow(/terminal or remote desktop/);
  });

  it("finds the terminal and remote desktop chunks when node_modules is a symlink, which Vite records by the path it resolved", () => {
    const base = mkdtempSync(join(tmpdir(), "precache-symlink-"));
    try {
      // A shared install outside the project, linked in as the project's node_modules.
      const project = join(base, "project"), shared = join(base, "shared/node_modules");
      for (const file of ["@novnc/novnc/core/rfb.js", "@xterm/xterm/lib/xterm.mjs"]) {
        mkdirSync(join(shared, file, ".."), { recursive: true });
        writeFileSync(join(shared, file), "");
      }
      mkdirSync(project);
      symlinkSync(shared, join(project, "node_modules"));
      const keyFor = (file: string, form: "plain" | "absolute" | "relative") => {
        const resolved = realpathSync(join(project, "node_modules", file));
        expect(resolved.startsWith(realpathSync(project))).toBe(false); // the link really leads outside the project
        return form === "plain" ? `node_modules/${file}` : form === "absolute" ? resolved : relative(realpathSync(project), resolved);
      };
      const withKeys = (form: "plain" | "absolute" | "relative") => Object.fromEntries(Object.entries(manifest).map(([key, entry]) => {
        const file = key.replace(/^node_modules\//, "");
        return [key.startsWith("node_modules/") ? keyFor(file, form) : key, entry];
      }));
      const plain = precachePlan(withKeys("plain"), files);
      expect(plain.onDemand).toEqual(["assets/remote-r.js", "assets/rfb-c.js", "assets/xterm-d.js"]);
      expect(precachePlan(withKeys("absolute"), files)).toEqual(plain);
      expect(precachePlan(withKeys("relative"), files)).toEqual(plain);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("does not take a package that merely has a similar name for an admin-only one", () => {
    const lookalikes = { ...manifest, "node_modules/@xterm-lookalike/x/index.js": { file: "assets/look-l.js", isDynamicEntry: true }, "src/my_node_modules/@xterm/y.js": { file: "assets/my-m.js", isDynamicEntry: true } };
    const { onDemand } = precachePlan(lookalikes, [...files, "assets/look-l.js", "assets/my-m.js"].sort());
    expect(onDemand).not.toContain("assets/look-l.js");
    expect(onDemand).not.toContain("assets/my-m.js");
  });

  it("fails the build when there is no HTML entry, instead of installing nothing", () => {
    const lazyOnly = Object.fromEntries(Object.entries(manifest).filter(([, entry]) => !("isEntry" in entry)));
    expect(() => precachePlan(lazyOnly, files)).toThrow(/no HTML entries/);
  });
});


describe("popup library stays off the entry's static imports", () => {
  const popup = 'export const x = `data-base-ui-focusable`;';
  const sources: Record<string, string> = { "assets/index-a.js": "app code", "assets/shared-s.js": "shared code", "assets/BotSettings-b.js": popup };
  const read = (file: string) => sources[file] ?? "";

  it("accepts a popup library that only a lazy chunk imports", () => {
    expect(() => assertPopupLibraryIsLazy(manifest, read)).not.toThrow();
  });

  it("names the chunk when the entry imports it again, whether in the entry or a shared chunk", () => {
    expect(() => assertPopupLibraryIsLazy(manifest, (file) => file === "assets/shared-s.js" ? popup : read(file))).toThrow(/assets\/shared-s\.js/);
    expect(() => assertPopupLibraryIsLazy(manifest, (file) => file === "assets/index-a.js" ? 'var e=`https://base-ui.com/production-error`' : read(file))).toThrow(/assets\/index-a\.js/);
  });

  it("covers every HTML entry, including the iOS desktop viewer", () => {
    const withViewer = { ...manifest, "native-computer.html": { file: "assets/nativeComputer-n.js", isEntry: true, imports: ["_popup-p.js"] }, "_popup-p.js": { file: "assets/popup-p.js" } };
    expect(() => assertPopupLibraryIsLazy(withViewer, (file) => file === "assets/popup-p.js" ? popup : read(file))).toThrow(/popup-p/);
  });
});
