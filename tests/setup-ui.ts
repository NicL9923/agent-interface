import { createHash } from "node:crypto";
import { afterEach, beforeEach, vi } from "vitest";
import { recordActWarning, takeActWarnings } from "./act-guard";

// Only files that run in jsdom have a document; server tests skip all of this.
if (typeof document !== "undefined") {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom has no canvas. Its getContext already returns null, but logs "Not implemented" each
  // time; this returns the same null quietly. Tests that need a context still stub their own.
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  // crypto.subtle.digest runs on Node's thread pool and settles in real time, outside the pinned clock and outside what act() and advance()
  // flush, so under load a digest lands after the test's next step: a form's Send was still disabled for its receipt lookup, and a
  // retry's request had not been sent. The same SHA-2 digest from node:crypto settles at once, in a microtask act() already flushes.
  // Anything else goes to the real implementation.
  const digestNames: Record<string, string> = { "SHA-1": "sha1", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512" };
  const realDigest = crypto.subtle.digest.bind(crypto.subtle);
  Object.defineProperty(crypto.subtle, "digest", { configurable: true, writable: true, value: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
    const name = digestNames[(typeof algorithm === "string" ? algorithm : algorithm.name).toUpperCase()];
    // Web Crypto rejects data that is neither a view nor an ArrayBuffer; the real call keeps that refusal.
    const buffer = Object.prototype.toString.call(data) === "[object ArrayBuffer]";
    if (!name || !(ArrayBuffer.isView(data) || buffer)) return realDigest(algorithm, data);
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data as ArrayBuffer);
    const digest = createHash(name).update(bytes).digest();
    return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
  } });
  // jsdom has no SVG path geometry or media queries, which the real Avatar reads on every render. These stand in for the browser, so no
  // test replaces the Avatar itself: a path is 100 units long and a point at a distance lies at x = distance. Nothing asserts a pose's
  // geometry here; tests/avatar-motion.test.ts covers the rig. Only reduced motion matches: an animating Avatar draws a frame every 16 ms
  // of virtual time, which costs a test most of a second and is what no UI test looks at, so avatars stay still unless a test asks for motion.
  Object.assign(SVGElement.prototype, {
    getTotalLength: () => 100,
    getPointAtLength: (distance: number) => ({ x: distance, y: 0 }),
  });
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)", media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
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
