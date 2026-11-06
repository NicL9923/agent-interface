import { afterEach, vi } from "vitest";

// Only files that run in jsdom have a document; server tests skip all of this.
if (typeof document !== "undefined") {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom has no canvas. Its getContext already returns null, but logs "Not implemented" each
  // time; this returns the same null quietly. Tests that need a context still stub their own.
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  const { unmountAll } = await import("./ui-harness");
  afterEach(async () => {
    await unmountAll();
    document.body.replaceChildren();
    localStorage.clear();
    sessionStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}
