import { describe, expect, it } from "vitest";
// Operator tooling uses Node's built-in modules and has no TypeScript build step.
// @ts-expect-error Plain JavaScript operator module.
import { follow, START_LIMIT_MS } from "../.agents/tools/hermes-update.mjs";

// A fake clock: each sleep advances time, and each poll returns the next scripted status.
function harness(statuses: object[], start = Date.parse("2026-11-04T15:00:00Z")) {
  let time = start;
  const logged: string[] = [];
  const queue = [...statuses];
  return {
    requested: start - 1000, logged,
    options: {
      now: () => time, log: (line: string) => logged.push(line),
      sleep: async (ms: number) => { time += ms; },
      poll: async () => queue.length > 1 ? queue.shift() : queue[0],
    },
  };
}
const at = (offsetMs: number) => new Date(Date.parse("2026-11-04T15:00:00Z") + offsetMs).toISOString();

describe("hermes-update --wait", () => {
  it("does not settle on the previous operation's failure after a retry", async () => {
    const stale = { phase: "failed", error: "qualification_failed", updatedAt: at(-3600_000) };
    const h = harness([stale, { phase: "checking", updatedAt: at(30_000) }, { phase: "ready", updatedAt: at(900_000) }]);
    const { code, result } = await follow(stale, { action: "control", requested: h.requested, ...h.options });
    expect(code).toBe(0);
    expect(result.phase).toBe("ready");
    expect(h.logged.some(line => line.includes("failed"))).toBe(false);
  });

  it("keeps waiting while a saved control request waits for the worker", async () => {
    const saved = { phase: "failed", controlRequestId: "r", updatedAt: at(-60_000) };
    const h = harness([{ ...saved }, ...Array(20).fill(saved), { phase: "succeeded", updatedAt: at(START_LIMIT_MS * 3) }]);
    expect((await follow(saved, { action: "control", requested: h.requested, ...h.options })).code).toBe(0);
  });

  it("follows a retry past its recovery's success into the new check", async () => {
    const old = { operationId: "old", phase: "failed", updatedAt: at(-3600_000) };
    const h = harness([{ operationId: "old", phase: "succeeded", updatedAt: at(20_000) },
      { operationId: "new", phase: "checking", updatedAt: at(40_000) },
      { operationId: "new", phase: "failed", error: "qualification_failed", updatedAt: at(600_000) }]);
    const { code, result } = await follow(old, { action: "control", control: "retry", original: "old", requested: h.requested, ...h.options });
    expect(code).toBe(1);
    expect(result.operationId).toBe("new");
  });

  it("reports an interrupted retry whose new state has no timestamp", async () => {
    const old = { operationId: "old", phase: "failed", updatedAt: at(-3600_000) };
    const h = harness([{ operationId: "new", phase: "blocked", error: "worker_interrupted" }]);
    expect((await follow(old, { action: "control", control: "retry", original: "old", requested: h.requested, ...h.options })).code).toBe(2);
  });

  it("gives up when the requested operation never starts", async () => {
    const stale = { phase: "idle", updatedAt: at(-60_000) };
    const h = harness([stale]);
    expect((await follow(stale, { action: "check", requested: h.requested, ...h.options })).code).toBe(1);
    expect(h.logged).toContain("The updater did not start the requested operation.");
  });

  it("reports a fresh failure and an interrupted worker", async () => {
    const failed = { phase: "blocked", error: "install_precondition_failed", updatedAt: at(200_000) };
    let h = harness([failed]);
    expect((await follow({ phase: "installing", updatedAt: at(1_000) }, { action: "install", requested: h.requested, ...h.options })).code).toBe(1);
    h = harness([]);
    expect((await follow({ phase: "installing", error: "worker_interrupted", updatedAt: at(5_000) }, { action: "install", requested: h.requested, ...h.options })).code).toBe(2);
  });

  it("returns a plain status at once", async () => {
    const h = harness([]);
    expect((await follow({ phase: "failed", updatedAt: at(-86_400_000) }, { action: "status", requested: h.requested, ...h.options })).code).toBe(1);
  });
});
