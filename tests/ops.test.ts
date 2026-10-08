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

describe("health", () => {
  it("keeps the liveness response unchanged", async () => {
    const { app } = await setup({}, { runtime: runtime({ status: async () => ({ connected: false }) }).value });
    const response = await app.inject("/api/health");
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"ok":true}');
  });

  it("reports detail only to direct loopback callers", async () => {
    const { app } = await setup();
    const direct = await app.inject("/api/health/ready");
    expect(direct.statusCode).toBe(200);
    expect(direct.json()).toEqual({ ok: true, checks: {
      database: { status: "ok", detail: "Responding" },
      hermes: { status: "ok", detail: "Connected" },
      worker: { status: "ok", detail: "Starting" },
      push: { status: "unconfigured", detail: expect.any(String) },
      backup: { status: "unconfigured", detail: "APP_BACKUP_DIR is not set" },
    } });
    for (const headers of [{ "x-forwarded-for": "203.0.113.9" }, { forwarded: "for=203.0.113.9" }, { "x-real-ip": "203.0.113.9" }])
      expect((await app.inject({ url: "/api/health/ready", headers })).body).toBe('{"ok":true}');
    expect((await app.inject({ url: "/api/health/ready", remoteAddress: "203.0.113.9" })).body).toBe('{"ok":true}');
  });

  it("fails readiness when the worker stalls or the database stops responding", async () => {
    const { app, worker, store } = await setup();
    worker.loop.success(Date.now() - 3 * minute);
    worker.loop.failure(new Error("database is locked"));
    let response = await app.inject("/api/health/ready");
    expect(response.statusCode).toBe(503);
    expect(response.json().checks.worker).toEqual({ status: "fail", detail: "No successful pass for 3 min: database is locked" });
    expect((await app.inject({ url: "/api/health/ready", headers: { "x-forwarded-for": "203.0.113.9" } })).body).toBe('{"ok":false}');
    worker.loop.success();
    vi.spyOn(store.db, "prepare").mockImplementationOnce(() => { throw new Error("disk I/O error"); });
    response = await app.inject("/api/health/ready");
    expect(response.statusCode).toBe(503);
    expect(response.json().checks.database).toEqual({ status: "fail", detail: "disk I/O error" });
  });

  it("tolerates a short Hermes disconnect and any maintenance window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const hermes = runtime();
    hermes.status = { connected: false, detail: "Hermes gateway is restarting." };
    const { app, worker } = await setup({}, { runtime: hermes.value });
    let response = await app.inject("/api/health/ready");
    expect(response.statusCode).toBe(200);
    expect(response.json().checks.hermes).toEqual({ status: "warn", detail: "Disconnected for 0 s: Hermes gateway is restarting." });
    vi.setSystemTime(Date.now() + 4 * minute);
    worker.loop.success();
    expect((await app.inject("/api/health/ready")).statusCode).toBe(200);
    vi.setSystemTime(Date.now() + 2 * minute);
    worker.loop.success();
    response = await app.inject("/api/health/ready");
    expect(response.statusCode).toBe(503);
    expect(response.json().checks.hermes.detail).toMatch(/^Disconnected for 6 min/);
    hermes.status = { connected: true };
    expect((await app.inject("/api/health/ready")).statusCode).toBe(200);

    const draining = runtime();
    draining.status = { connected: false };
    const { app: maintained } = await setup({}, { runtime: draining.value, maintenance: true });
    response = await maintained.inject("/api/health/ready");
    expect(response.statusCode).toBe(200);
    expect(response.json().checks.hermes).toEqual({ status: "ok", detail: "A Hermes update is in progress" });
  });

  it("warns about push failures without failing readiness", async () => {
    const keys = webpush.generateVAPIDKeys();
    const { app, worker } = await setup({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: "mailto:one@example.test" });
    expect((await app.inject("/api/health/ready")).json().checks.push).toEqual({ status: "ok", detail: "No deliveries since start" });
    worker.push.success(Date.now() - 2 * minute);
    worker.push.failure("Web Push 503: unavailable");
    const response = await app.inject("/api/health/ready");
    expect(response.statusCode).toBe(200);
    expect(response.json().checks.push).toEqual({ status: "warn", detail: "Last delivery failed 0 s ago: Web Push 503: unavailable" });
    worker.push.success();
    expect((await app.inject("/api/health/ready")).json().checks.push.status).toBe("ok");
  });

  it("checks only completed backups written by the backup tool", async () => {
    const directory = temporary(), backups = join(directory, "backups");
    const source = join(directory, "app.sqlite");
    const db = new DatabaseSync(source);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(a); INSERT INTO t VALUES(1);");
    db.close();
    const { app } = await setup({ APP_BACKUP_DIR: backups });
    const backup = async () => (await app.inject("/api/health/ready")).json().checks.backup;
    expect((await backup()).status).toBe("warn");
    const leftover = "agent-interface-2026-01-01T00-00-00.000Z-12345678-1234-1234-1234-123456789abc.sqlite.partial";
    execFileSync(process.execPath, [".agents/tools/backup-app.mjs", source, backups]);
    expect(await backup()).toEqual({ status: "ok", detail: "Newest backup is 0 s old" });
    const [completed] = readdirSync(backups);
    expect(readdirSync(backups)).toEqual([completed]);
    // A stale partial from an older run never counts and is cleaned up by the next run.
    const stale = new Date(Date.now() - 2 * hour);
    for (const suffix of ["", "-shm", "-wal"]) {
      writeFileSync(join(backups, leftover + suffix), "");
      utimesSync(join(backups, leftover + suffix), stale, stale);
    }
    const old = new Date(Date.now() - 37 * hour);
    utimesSync(join(backups, completed), old, old);
    expect(await backup()).toEqual({ status: "warn", detail: "Newest backup is 37 h old" });
    expect((await app.inject("/api/health/ready")).statusCode).toBe(200);
    execFileSync(process.execPath, [".agents/tools/backup-app.mjs", source, backups]);
    expect(readdirSync(backups).filter(file => file.includes(".partial"))).toEqual([]);
    expect((await backup()).status).toBe("ok");
  });

  it("alerts administrators once after ten minutes and again on recovery", async () => {
    const hermes = runtime();
    hermes.status = { connected: false, detail: "Hermes is unreachable." };
    const lines: string[] = [];
    const { store, worker, health } = await setup({ HOUSEHOLD_EMAILS: "one@example.test,two@example.test", HERMES_INTEGRATION_ADMINS: "one@example.test", LOG_LEVEL: "info" }, { runtime: hermes.value, lines });
    for (const id of ["one", "two"]) store.user({ id, name: id, email: `${id}@example.test` });
    const alerts = () => store.db.prepare("SELECT event_id,user_id,payload FROM outbox WHERE event_id LIKE 'health:%' ORDER BY rowid").all() as { event_id: string; user_id: string; payload: string }[];
    const start = Date.now();
    const at = async (offset: number) => { worker.loop.success(start + offset); await health.evaluate(start + offset); };
    await at(0);
    await at(9 * minute);
    expect(alerts()).toEqual([]);
    await at(10 * minute);
    await at(11 * minute);
    expect(alerts().map(row => [row.event_id, row.user_id])).toEqual([[`health:hermes:${start}`, "one"]]);
    expect(JSON.parse(alerts()[0].payload)).toMatchObject({
      title: "WildBots needs attention", url: "/", kind: "failed",
      body: expect.stringMatching(/^The Hermes connection needs attention\. Disconnected for 10 min: Hermes is unreachable\./),
    });
    hermes.status = { connected: true };
    await at(12 * minute);
    await at(13 * minute);
    expect(alerts().map(row => row.event_id)).toEqual([`health:hermes:${start}`, `health:hermes:${start}:recovered`]);
    expect(JSON.parse(alerts()[1].payload)).toMatchObject({ title: "WildBots recovered", body: "The Hermes connection is working again.", kind: "failed" });
    const messages = lines.map(line => JSON.parse(line).msg);
    expect(messages.filter(message => message.startsWith("Readiness check"))).toEqual([
      "Readiness check degraded", "Readiness check degraded for 10 minutes; alerting administrators", "Readiness check recovered",
    ]);
    // A later outage is a new incident with its own alert.
    hermes.status = { connected: false };
    await at(20 * minute);
    await at(30 * minute);
    expect(alerts().map(row => row.event_id).at(-1)).toBe(`health:hermes:${start + 20 * minute}`);
  });
});

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
      expect.objectContaining({ level: 50, msg: "Request failed", route: "GET /api/bots", status: 502, error: expect.objectContaining({ type: "Error", message: "Hermes offline" }) }),
    ]);
    vi.setSystemTime(Date.now() + 10 * minute);
    await app.inject({ url: "/api/bots", headers });
    expect(JSON.parse(lines[1])).toMatchObject({ msg: "Request failure repeated", route: "GET /api/bots", repeats: 3 });
    expect(lines).toHaveLength(2);
    const output = lines.join("");
    for (const secret of ["secret-ticket", headers.cookie.split("=")[1], headers["x-csrf-token"]]) expect(output).not.toContain(secret);
  });

  it("never logs extra properties or causes from upstream errors", async () => {
    const lines: string[] = [];
    const leaky = Object.assign(new Error("Hermes rejected the request", { cause: new Error("private cause text") }),
      { rpcCode: -32000, rpcMessage: "private request text" });
    const failing = runtime({ listBots: async () => { throw leaky; } });
    const { app } = await setup({ LOG_LEVEL: "info" }, { runtime: failing.value, lines });
    const headers = await login(app);
    expect((await app.inject({ url: "/api/bots", headers })).statusCode).toBe(502);
    expect(JSON.parse(lines[0]).error).toMatchObject({ type: "Error", message: "Hermes rejected the request" });
    for (const secret of ["private request text", "private cause text", "-32000"]) expect(lines.join("")).not.toContain(secret);
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

describe("ETags", () => {
  it("revalidates JSON reads with 304 and keeps them out of HTTP caches", async () => {
    const { app } = await setup();
    const headers = await login(app);
    const first = await app.inject({ url: "/api/bots/shared/draft", headers });
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]{22}"$/);
    const unchanged = await app.inject({ url: "/api/bots/shared/draft", headers: { ...headers, "if-none-match": etag } });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe("");
    expect(unchanged.headers).toMatchObject({ etag, "cache-control": "no-store" });
    const saved = await app.inject({ method: "PUT", url: "/api/bots/shared/draft", headers, payload: { text: "New draft", attachments: [] } });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers.etag).toBeUndefined();
    const changed = await app.inject({ url: "/api/bots/shared/draft", headers: { ...headers, "if-none-match": etag } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().text).toBe("New draft");
    expect(changed.headers.etag).not.toBe(etag);
  });

  it("skips files, errors and unauthenticated responses", async () => {
    const { app } = await setup();
    const headers = await login(app);
    const file = await app.inject({ url: "/api/files/note.txt", headers });
    expect(file.statusCode).toBe(200);
    expect(file.headers.etag).toBeUndefined();
    expect((await app.inject("/api/bootstrap")).headers.etag).toBeUndefined();
  });
});
