import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { satisfiesEngine } from "../scripts/node-engine.mjs";

describe("Node engine check", () => {
  const range = "^24.22.2 || ^26.13.0";
  it("accepts versions at or above each alternative's floor within its major", () => {
    for (const version of ["v24.22.2", "24.22.3", "v24.23.0", "v26.13.0", "v26.20.1"]) expect([version, satisfiesEngine(version, range)]).toEqual([version, true]);
  });
  it("refuses older releases in the same major and other majors", () => {
    for (const version of ["v24.18.0", "v24.22.1", "v26.12.9", "v25.0.0", "v22.30.0", "v28.0.0"]) expect([version, satisfiesEngine(version, range)]).toEqual([version, false]);
  });
  it("refuses a range form it cannot check instead of passing everything", () => {
    expect(() => satisfiesEngine("v24.22.2", ">=24")).toThrow(/only understands/);
  });
  it("understands the range package.json declares", () => {
    const declared = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).engines.node;
    expect(() => satisfiesEngine(process.version, declared)).not.toThrow();
  });
});
