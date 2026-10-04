import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { FailureTracker } from "../src/server/logging.js";
import type { HermesUpgrades } from "../src/server/upgrades.js";
import type { Runtime, RuntimeStatus } from "../src/shared/types.js";

const minute = 60_000, hour = 60 * minute;
const origin = "http://127.0.0.1:3000";
const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-ops-"));
  directories.push(directory);
  return directory;
};
function runtime(overrides: Partial<Runtime> = {}) {
  let status: RuntimeStatus = { connected: true };
  const value = {
    status: async () => status,
    capabilities: async () => ({ durableEvents: { supported: false }, idempotency: { supported: false }, generatedFiles: { supported: true } }),
    listBots: async () => [{ id: "shared", name: "Shared", model: "test", shared: true, activity: "idle" }],
    download: async () => ({ data: Buffer.from("hello"), name: "note.txt", mime: "text/plain" }),
    close: async () => {},
    ...overrides,
  } as unknown as Runtime;
  return { value, set status(next: RuntimeStatus) { status = next; } };
}
async function setup(env: Record<string, string> = {}, options: { runtime?: Runtime; maintenance?: boolean; lines?: string[] } = {}) {
  const config = loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:", ...env });
  const upgrades = { maintenance: () => options.maintenance ?? false } as unknown as HermesUpgrades;
  const result = await createApp(config, options.runtime ?? runtime().value, {
    background: false, upgrades, logStream: options.lines ? { write: line => { options.lines!.push(line); } } : undefined,
  });
  apps.push(result.app);
  return result;
}
async function login(app: Awaited<ReturnType<typeof createApp>>["app"]) {
  const result = await app.inject({ method: "POST", url: "/api/auth/local", headers: { origin }, payload: { member: "one" } });
  return { cookie: `session=${result.cookies[0].value}`, "x-csrf-token": result.json().csrfToken, origin };
}

describe("logging", () => {
  it("logs a repeated server error once, then a count every ten minutes, without secrets or 4xx noise", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const lines: string[] = [];
    const failing = runtime({ listBots: async () => { throw new Error("Hermes offline"); } });
    const { app } = await setup({ LOG_LEVEL: "info" }, { runtime: failing.value, lines });
    const headers = await login(app);
    for (let request = 0; request < 3; request++)
      expect((await app.inject({ url: "/api/bots?ticket=secret-ticket", headers })).statusCode).toBe(502);
    expect((await app.inject({ url: "/api/bootstrap" })).statusCode).toBe(401);
    expect(lines.map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ level: 50, msg: "Request failed", route: "GET /api/bots", status: 502, err: expect.objectContaining({ message: "Hermes offline" }) }),
    ]);
    vi.setSystemTime(Date.now() + 10 * minute);
    await app.inject({ url: "/api/bots", headers });
    expect(JSON.parse(lines[1])).toMatchObject({ msg: "Request failure repeated", route: "GET /api/bots", repeats: 3 });
    expect(lines).toHaveLength(2);
    const output = lines.join("");
    for (const secret of ["secret-ticket", headers.cookie.split("=")[1], headers["x-csrf-token"]]) expect(output).not.toContain(secret);
  });

  it("logs a failing operation when it starts, every ten minutes while it lasts, and when it recovers", () => {
    const messages: string[] = [];
    const record = (...args: unknown[]) => { messages.push(String(args[1])); };
    const tracker = new FailureTracker({ info: record, warn: record, error: record }, "Hermes event discovery");
    tracker.failure(new Error("offline"), 0);
    tracker.failure(new Error("offline"), 9 * minute);
    tracker.failure(new Error("offline"), 10 * minute);
    tracker.failure(new Error("offline"), 15 * minute);
    tracker.success(16 * minute);
    tracker.success(17 * minute);
    expect(messages).toEqual(["Hermes event discovery failed", "Hermes event discovery is still failing", "Hermes event discovery recovered"]);
    expect(tracker).toMatchObject({ consecutiveFailures: 0, failingSince: undefined, lastError: "offline", lastSuccessAt: 17 * minute });
  });

  it("stays silent unless a log level is configured", async () => {
    expect(loadConfig({}).logLevel).toBeUndefined();
    expect(() => loadConfig({ LOG_LEVEL: "verbose" })).toThrow("LOG_LEVEL");
  });
});
