import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

// A test that replaces console.error itself can swallow React's act warnings, and the act guard in
// tests/setup-ui.ts never hears them, for example after an early mockRestore(). quietConsoleErrors()
// in tests/act-guard.ts silences the console while still handing act warnings to the guard.
it("mocks console.error only through quietConsoleErrors()", () => {
  const directory = new URL(".", import.meta.url);
  const own = /spyOn\(\s*console\s*,\s*["'`]error["'`]|console\.error\s*=(?!=)/;
  const offenders = readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter(file => /\.[cm]?[jt]sx?$/.test(file) && !["act-guard.ts", "setup-ui.ts", "console-mocks.test.ts"].includes(file))
    .filter(file => own.test(readFileSync(new URL(file, directory), "utf8")));
  expect(offenders, "use quietConsoleErrors() from tests/act-guard.ts").toEqual([]);
});
