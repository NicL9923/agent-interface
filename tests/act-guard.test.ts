import { expect, it } from "vitest";
import { quietConsoleErrors, takeActWarnings } from "./act-guard";

it("keeps act warnings from a quieted console for the guard, and nothing else", () => {
  const error = quietConsoleErrors();
  console.error("An update to %s inside a test was not wrapped in act(...).", "Home");
  console.error("The boundary caught: %s", "boom");
  expect(error).toHaveBeenCalledTimes(2);
  expect(takeActWarnings()).toEqual(["An update to Home inside a test was not wrapped in act(...)."]);
  expect(takeActWarnings()).toEqual([]);
});
