import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ports.ts reads the environment when it loads, as Playwright's config and the e2e server do.
async function load(value: string | undefined) {
  if (value === undefined) delete process.env.E2E_PORT;
  else process.env.E2E_PORT = value;
  vi.resetModules();
  return import("../e2e/ports");
}

describe("browser suite ports", () => {
  const saved = process.env.E2E_PORT;
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    if (saved === undefined) delete process.env.E2E_PORT;
    else process.env.E2E_PORT = saved;
  });

  it("uses 4173 and the next port when the suite runs without check-all", async () => {
    const { port, controlPort } = await load(undefined);
    expect([port, controlPort]).toEqual([4173, 4174]);
  });

  it("treats an empty E2E_PORT as unset", async () => {
    expect((await load("")).port).toBe(4173);
  });

  it("moves both ports to the one check-all chose", async () => {
    const { port, controlPort } = await load("43120");
    expect([port, controlPort]).toEqual([43120, 43121]);
  });

  it.each([
    ["a word", "abc"],
    ["a privileged port", "80"],
    ["a port whose control port would not exist", "65535"],
  ])("refuses %s, so a typo never lands on another worktree's port 4173", async (_name, value) => {
    await expect(load(value)).rejects.toThrow(/E2E_PORT must be a whole number from 1024 to 65534/);
  });

  it("accepts the highest port that leaves room for the control port", async () => {
    expect((await load("65534")).controlPort).toBe(65535);
  });
});
