import { describe, expect, it } from "vitest";
import {
  assertNoBannedEntryImports,
  assertNoChunkCycles,
  chunkCycleGuardPlugin,
  type OutputBundleLike,
} from "../scripts/chunk-cycle-guard-plugin.mjs";

const acyclicBundle: OutputBundleLike = {
  "assets/index.js": {
    type: "chunk",
    fileName: "assets/index.js",
    name: "index",
    isEntry: true,
    facadeModuleId: "/repo/index.html",
    imports: ["assets/vendor-react.js", "assets/vendor-markdown.js"],
    modules: {
      "/repo/src/main.tsx": {},
      "/repo/src/App.tsx": {},
    },
  },
  "assets/vendor-react.js": {
    type: "chunk",
    fileName: "assets/vendor-react.js",
    name: "vendor-react",
    isEntry: false,
    imports: [],
    modules: {
      "/repo/node_modules/react/index.js": {},
      "/repo/node_modules/react-dom/client.js": {},
    },
  },
  "assets/vendor-markdown.js": {
    type: "chunk",
    fileName: "assets/vendor-markdown.js",
    name: "vendor-markdown",
    isEntry: false,
    imports: ["assets/vendor-react.js"],
    modules: {
      "/repo/node_modules/react-markdown/index.js": {},
      "/repo/node_modules/remark-gfm/index.js": {},
    },
  },
  "assets/rfb.js": {
    type: "chunk",
    fileName: "assets/rfb.js",
    name: "rfb",
    isEntry: false,
    imports: [],
    modules: {
      "/repo/node_modules/@novnc/novnc/core/rfb.js": {},
    },
  },
  "assets/xterm.js": {
    type: "chunk",
    fileName: "assets/xterm.js",
    name: "xterm",
    isEntry: false,
    imports: [],
    modules: {
      "/repo/node_modules/@xterm/xterm/lib/xterm.mjs": {},
    },
  },
  "assets/code-highlight.js": {
    type: "chunk",
    fileName: "assets/code-highlight.js",
    name: "code-highlight",
    isEntry: false,
    imports: [],
    modules: {
      "/repo/node_modules/highlight.js/lib/core.js": {},
    },
  },
  "assets/index.css": {
    type: "asset",
    fileName: "assets/index.css",
  },
};

describe("chunk cycle guard", () => {
  it("passes on an acyclic bundle where heavy packages stay in lazy chunks", () => {
    expect(() => assertNoChunkCycles(acyclicBundle)).not.toThrow();
    expect(() => assertNoBannedEntryImports(acyclicBundle)).not.toThrow();
  });

  it("throws naming the exact cycle on a 2-chunk static import cycle", () => {
    const cyclic: OutputBundleLike = {
      ...acyclicBundle,
      "assets/a.js": {
        type: "chunk",
        fileName: "assets/a.js",
        imports: ["assets/b.js"],
      },
      "assets/b.js": {
        type: "chunk",
        fileName: "assets/b.js",
        imports: ["assets/a.js"],
      },
    };
    expect(() => assertNoChunkCycles(cyclic)).toThrow(
      /assets\/a\.js -> assets\/b\.js -> assets\/a\.js/,
    );
  });

  it("throws naming the exact cycle on a 3-chunk cycle and a self-cycle", () => {
    const threeCycle: OutputBundleLike = {
      "assets/a.js": { type: "chunk", fileName: "assets/a.js", imports: ["assets/b.js"] },
      "assets/b.js": { type: "chunk", fileName: "assets/b.js", imports: ["assets/c.js"] },
      "assets/c.js": { type: "chunk", fileName: "assets/c.js", imports: ["assets/a.js"] },
    };
    expect(() => assertNoChunkCycles(threeCycle)).toThrow(
      /assets\/a\.js -> assets\/b\.js -> assets\/c\.js -> assets\/a\.js/,
    );

    const selfCycle: OutputBundleLike = {
      "assets/self.js": { type: "chunk", fileName: "assets/self.js", imports: ["assets/self.js"] },
    };
    expect(() => assertNoChunkCycles(selfCycle)).toThrow(/assets\/self\.js -> assets\/self\.js/);
  });

  it("throws when a banned heavy package is directly in the index.html entry chunk", () => {
    const directLeak: OutputBundleLike = {
      ...acyclicBundle,
      "assets/index.js": {
        ...acyclicBundle["assets/index.js"],
        type: "chunk",
        modules: {
          "/repo/src/main.tsx": {},
          "/repo/node_modules/highlight.js/lib/core.js": {},
        },
      },
    };
    expect(() => assertNoBannedEntryImports(directLeak)).toThrow(/highlight\.js/);
    expect(() => assertNoBannedEntryImports(directLeak)).toThrow(/assets\/index\.js/);
  });

  it("throws when a banned heavy package is transitively imported by index.html", () => {
    const transitiveLeak: OutputBundleLike = {
      ...acyclicBundle,
      "assets/vendor-markdown.js": {
        type: "chunk",
        fileName: "assets/vendor-markdown.js",
        isEntry: false,
        imports: ["assets/xterm.js"],
        modules: {
          "/repo/node_modules/react-markdown/index.js": {},
        },
      },
    };
    expect(() => assertNoBannedEntryImports(transitiveLeak)).toThrow(/@xterm\/xterm/);
    expect(() => assertNoBannedEntryImports(transitiveLeak)).toThrow(/assets\/xterm\.js/);
  });

  it("also checks Rolldown moduleIds and ignores lookalike package names", () => {
    const withModuleIds: OutputBundleLike = {
      ...acyclicBundle,
      "assets/vendor-react.js": {
        type: "chunk",
        fileName: "assets/vendor-react.js",
        isEntry: false,
        imports: [],
        moduleIds: ["/repo/node_modules/@novnc/novnc/core/rfb.js"],
      },
    };
    expect(() => assertNoBannedEntryImports(withModuleIds)).toThrow(/@novnc\/novnc/);

    const lookalike: OutputBundleLike = {
      ...acyclicBundle,
      "assets/vendor-react.js": {
        type: "chunk",
        fileName: "assets/vendor-react.js",
        isEntry: false,
        imports: [],
        modules: {
          "/repo/node_modules/@xterm/xterm-lookalike/index.js": {},
          "/repo/src/my_node_modules/highlight.js/index.js": {},
        },
      },
    };
    expect(() => assertNoBannedEntryImports(lookalike)).not.toThrow();
  });

  it("wires both checks in the Vite generateBundle hook", () => {
    const plugin = chunkCycleGuardPlugin();
    const hook = plugin.generateBundle;
    expect(typeof hook).toBe("function");
    const run = (bundle: OutputBundleLike) =>
      (hook as (options: unknown, b: OutputBundleLike) => void)({}, bundle);

    expect(() => run(acyclicBundle)).not.toThrow();
    expect(() =>
      run({
        "assets/x.js": { type: "chunk", fileName: "assets/x.js", imports: ["assets/y.js"] },
        "assets/y.js": { type: "chunk", fileName: "assets/y.js", imports: ["assets/x.js"] },
      }),
    ).toThrow(/Circular static chunk import/);
  });
});
