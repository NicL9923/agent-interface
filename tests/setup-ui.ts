import { afterEach, beforeEach, vi } from "vitest";
import { recordActWarning, takeActWarnings } from "./act-guard";

// Only files that run in jsdom have a document; server tests skip all of this.
if (typeof document !== "undefined") {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom has no canvas. Its getContext already returns null, but logs "Not implemented" each
  // time; this returns the same null quietly. Tests that need a context still stub their own.
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  // jsdom has no SVG path geometry or media queries, which the real Avatar reads on every render. These stand in for the browser, so no
  // test replaces the Avatar itself: a path is 100 units long and a point at a distance lies at x = distance, and no query matches.
  // Nothing asserts a pose's geometry here; tests/avatar-motion.test.ts covers the rig.
  Object.assign(SVGElement.prototype, {
    getTotalLength: () => 100,
    getPointAtLength: (distance: number) => ({ x: distance, y: 0 }),
  });
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  }
  // A test's own console mock would otherwise swallow React's act warnings; see tests/act-guard.ts.
  const logError = console.error;
  console.error = (...args: unknown[]) => { if (!recordActWarning(args)) logError.apply(console, args); };
  beforeEach(() => { takeActWarnings(); });
  const { unmountAll } = await import("./ui-harness");
  afterEach(async () => {
    await unmountAll();
    document.body.replaceChildren();
    localStorage.clear();
    sessionStorage.clear();
    vi.useRealTimers();
    // A bare console.error mock that is still in place swallowed what it was given; read it before restoring.
    const errorLog = console.error;
    if (vi.isMockFunction(errorLog)) for (const args of errorLog.mock.calls) recordActWarning(args);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // Last, so that updates from unmounting count too.
    const found = takeActWarnings();
    if (found.length)
      throw new Error(`React reported ${found.length} act() problem(s). Await every act(), wrap async work in it, and never nest acts:\n${found.join("\n")}`);
  });
}
