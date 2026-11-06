import { vi } from "vitest";

// React reports an update outside act, an unawaited act and overlapping acts only by logging, and the
// suite stays green while a test races its own rendering. tests/setup-ui.ts fails the test instead.
const actWarning = /not wrapped in act\(|overlapping act\(\)|without await/;
const found: string[] = [];

/** Records `console.error` arguments that are a React act warning; says whether they were one. */
export function recordActWarning(args: unknown[]) {
  const [format] = args;
  if (typeof format !== "string" || !actWarning.test(format)) return false;
  found.push(args.slice(1).reduce<string>((text, value) => text.replace("%s", String(value)), format).split("\n")[0]);
  return true;
}

/** Returns the act warnings recorded since the last call, once each, and forgets them. */
export function takeActWarnings() {
  const unique = [...new Set(found)];
  found.length = 0;
  return unique;
}

/**
 * Silences `console.error` for a test that expects errors, such as an error boundary's. Unlike a bare
 * `vi.spyOn(console, "error").mockImplementation(() => {})`, act warnings still reach the guard.
 */
export function quietConsoleErrors() {
  return vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { recordActWarning(args); });
}
