import { describe, expect, it } from "vitest";
import { assertPopupLibraryIsLazy, precachePlan } from "../scripts/precache-plan.mjs";

const manifest = {
  "index.html": { file: "assets/index-a.js", isEntry: true, css: ["assets/index-a.css"], imports: ["_shared-s.js"] },
  "_shared-s.js": { file: "assets/shared-s.js" },
  "src/BotSettings.tsx": { file: "assets/BotSettings-b.js", isDynamicEntry: true, imports: ["_shared-s.js"] },
  "node_modules/@novnc/novnc/core/rfb.js": { file: "assets/rfb-c.js", isDynamicEntry: true, imports: ["_shared-s.js", "_remote-r.js"] },
  "node_modules/@xterm/xterm/lib/xterm.mjs": { file: "assets/xterm-d.js", isDynamicEntry: true },
  "_remote-r.js": { file: "assets/remote-r.js" },
};
const files = [
  "index.html", "sw.js", "assets/index-a.js", "assets/index-a.css", "assets/shared-s.js", "assets/BotSettings-b.js",
  "assets/rfb-c.js", "assets/xterm-d.js", "assets/remote-r.js",
].sort();

describe("service worker install cache", () => {
  it("leaves the terminal and remote desktop code to first use", () => {
    const { precache, onDemand } = precachePlan(manifest, files);
    expect(onDemand).toEqual(["assets/remote-r.js", "assets/rfb-c.js", "assets/xterm-d.js"]);
    expect(precache).toEqual(files.filter((file) => !onDemand.includes(file)));
  });

  it("keeps shared code and other lazy chunks installed, since the app and offline panels need them", () => {
    const { precache } = precachePlan(manifest, files);
    expect(precache).toEqual(expect.arrayContaining(["assets/shared-s.js", "assets/BotSettings-b.js", "assets/index-a.css"]));
  });

  it("fails the build when no admin-only chunk is found, instead of quietly precaching them again", () => {
    const { "node_modules/@novnc/novnc/core/rfb.js": _rfb, "node_modules/@xterm/xterm/lib/xterm.mjs": _xterm, ...app } = manifest;
    expect(() => precachePlan(app, files)).toThrow(/terminal or remote desktop/);
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
