import { afterEach, beforeEach, vi } from "vitest";

// Only files that run in jsdom have a document; server tests skip all of this.
if (typeof document !== "undefined") {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom has no canvas. Its getContext already returns null, but logs "Not implemented" each
  // time; this returns the same null quietly. Tests that need a context still stub their own.
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  // React reports an update outside act, an unawaited act and overlapping acts only by logging, and the
  // suite stays green while a test races its own rendering. Failing the test makes them impossible to miss.
  const actWarning = /not wrapped in act\(|overlapping act\(\)|without await/;
  const actWarnings: string[] = [];
  const logError = console.error;
  console.error = (...args: unknown[]) => {
    const [format] = args;
    if (typeof format === "string" && actWarning.test(format)) actWarnings.push(args.slice(1).reduce<string>((text, value) => text.replace("%s", String(value)), format).split("\n")[0]);
    else logError.apply(console, args);
  };
  beforeEach(() => { actWarnings.length = 0; });
  const { unmountAll } = await import("./ui-harness");
  afterEach(async () => {
    await unmountAll();
    document.body.replaceChildren();
    localStorage.clear();
    sessionStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // Last, so that updates from unmounting count too.
    if (actWarnings.length) {
      const found = [...new Set(actWarnings)];
      actWarnings.length = 0;
      throw new Error(`React reported ${found.length} act() problem(s). Await every act(), wrap async work in it, and never nest acts:\n${found.join("\n")}`);
    }
  });
}
