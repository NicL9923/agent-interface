import { afterEach, vi } from "vitest";

// Only files that run in jsdom have a document; server tests skip all of this.
if (typeof document !== "undefined") {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
