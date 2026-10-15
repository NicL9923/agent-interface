import { describe, expect, it } from "vitest";
import { precachePlan } from "../scripts/precache-plan.mjs";

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
