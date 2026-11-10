import { afterEach, beforeEach, vi } from "vitest";
import { recordActWarning, takeActWarnings } from "./act-guard";

// Only files that run in jsdom have a document; server tests skip all of this.
if (typeof document !== "undefined") {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom has no canvas. Its getContext already returns null, but logs "Not implemented" each
  // time; this returns the same null quietly. Tests that need a context still stub their own.
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  // A test's own console mock would otherwise swallow React's act warnings; see tests/act-guard.ts.
  const logError = console.error;
  console.error = (...args: unknown[]) => { if (!recordActWarning(args)) logError.apply(console, args); };
  beforeEach(() => { takeActWarnings(); });
  const { unmountAll } = await import("./ui-harness");
  const { flushLocalSaves } = await import("../src/app/storage");
  afterEach(async () => {
    await unmountAll();
    document.body.replaceChildren();
    // A deferred draft save must not land in the next test's storage, nor wait on a fake timer that is gone.
    flushLocalSaves();
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
