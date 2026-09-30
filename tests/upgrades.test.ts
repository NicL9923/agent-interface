import { afterEach, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";
import { HermesUpgrades } from "../src/server/upgrades.js";
import type { ActivityState, Runtime } from "../src/shared/types.js";

const origin = "http://127.0.0.1:3000", revision = "d23cc6b06455b8551fb6f61d3cad040a0e82f5b6";
const temporary: string[] = [], apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function setup(enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), "hermes-upgrade-contract-")); temporary.push(directory);
  const workerConfig = join(directory, "worker.json"); writeFileSync(workerConfig, "{}", { mode: 0o600 });
  const config = loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:", ...(enabled ? {
    HERMES_UPGRADE_ENABLED: "true", HERMES_UPGRADE_ADMINS: "one@localhost.invalid", HERMES_UPGRADE_CONFIG: workerConfig,
    HERMES_UPGRADE_STATE_DIR: directory, HERMES_UPGRADE_PYTHON: "/usr/bin/python3",
  } : {}) });
  let activity: ActivityState = "idle", connected = true;
  const runtime = { status: async () => ({ connected }), listBots: async () => [{ id: "shared", name: "Shared", model: "test", shared: true, activity }],
    close: async () => {}, capabilities: async () => ({ chat: { supported: true } }), submit: vi.fn() } as unknown as Runtime;
  const launch = vi.fn(), upgrades = new HermesUpgrades(config, runtime, launch);
  const result = await createApp(config, runtime, { background: false, upgrades }); apps.push(result.app);
  const stateFile = join(directory, "status.json");
  const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
  const save = (value: Record<string, unknown>) => writeFileSync(stateFile, JSON.stringify(value), { mode: 0o600 });
  const ready = () => save({ phase: "ready", candidate: { revision }, checks: [{ id: "integration", label: "Real integration", status: "passed" }],
    message: "Ready", qualification: { stage: "/private/stage" } });
  return { ...result, config, directory, workerConfig, upgrades, launch, runtime, state, save, ready,
    activity: (value: ActivityState) => { activity = value; }, connected: (value: boolean) => { connected = value; } };
}
async function login(app: Awaited<ReturnType<typeof createApp>>["app"], member = "one") {
  const result = await app.inject({ method: "POST", url: "/api/auth/local", headers: { origin }, payload: { member } });
  return { origin, cookie: `session=${result.cookies[0].value}`, "x-csrf-token": result.json().csrfToken };
}

it("keeps upgrades opt-in, restricts administrators, and rejects client commands or refs", async () => {
  const disabled = await setup(false), disabledHeaders = await login(disabled.app);
  expect((await disabled.app.inject({ url: "/api/hermes/upgrade", headers: disabledHeaders })).json()).toMatchObject({ available: false, canCheck: false, canInstall: false });
  expect((await disabled.app.inject({ method: "POST", url: "/api/hermes/upgrade/check", headers: disabledHeaders, payload: {} })).statusCode).toBe(409);
  const installation = await setup(), member = await login(installation.app, "two"), admin = await login(installation.app);
  expect((await installation.app.inject({ url: "/api/hermes/upgrade", headers: member })).json()).toMatchObject({ available: true, canCheck: false, canInstall: false });
  expect((await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/check", headers: member, payload: {} })).statusCode).toBe(403);
  expect((await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/check", headers: admin, payload: { command: "hermes update" } })).statusCode).toBe(400);
  expect((await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/install", headers: admin, payload: { candidateRevision: "origin/main", requestId: randomUUID() } })).statusCode).toBe(400);
  expect(installation.launch).not.toHaveBeenCalled();
});

it("retains browser CSRF protections and accepts administrator native sessions without browser origin", async () => {
  const installation = await setup(), headers = await login(installation.app);
  for (const guarded of [{ cookie: headers.cookie, origin }, { ...headers, origin: "https://other.test" }, { cookie: headers.cookie, "x-csrf-token": headers["x-csrf-token"] }])
    expect((await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/check", headers: guarded, payload: {} })).statusCode).toBe(403);
  expect((await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/check", payload: {} })).statusCode).toBe(401);
  const token = randomBytes(32).toString("base64url"); installation.store.nativeSession(hash(token), "local-one", Date.now() + 60000);
  const native = { authorization: `Bearer ${token}` };
  expect((await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/check", headers: { ...native, origin }, payload: {} })).statusCode).toBe(403);
  expect((await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/check", headers: native, payload: {} })).json()).toMatchObject({ phase: "checking", canInstall: false });
  expect(installation.launch).toHaveBeenCalledTimes(1);
});

it("requires exact qualification and idle verified Hermes before admitting an install", async () => {
  const installation = await setup(), headers = await login(installation.app);
  const install = (candidateRevision = revision) => installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/install", headers, payload: { candidateRevision, requestId: randomUUID() } });
  expect((await install()).statusCode).toBe(409);
  installation.ready(); expect((await install("a".repeat(40))).statusCode).toBe(409);
  installation.activity("working"); expect((await install()).statusCode).toBe(409);
  expect((await installation.app.inject({ url: "/api/hermes/upgrade", headers })).json().busyBots).toEqual(["Shared"]);
  installation.activity("idle"); installation.connected(false); expect((await install()).statusCode).toBe(409);
  expect(installation.launch).not.toHaveBeenCalled();
});

it("persists install idempotency and maintenance before launch, and never replays after app restart", async () => {
  const installation = await setup(), headers = await login(installation.app); installation.ready();
  const requestId = randomUUID(), payload = { candidateRevision: revision, requestId };
  const first = await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/install", headers, payload });
  expect(first.json()).toMatchObject({ phase: "installing", canInstall: false });
  expect(first.json()).not.toHaveProperty("qualification");
  expect(installation.upgrades.maintenance()).toBe(true);
  expect(installation.state()).toMatchObject({ maintenance: true, requestId });
  expect(JSON.parse(readFileSync(join(installation.directory, "requests", `${requestId}.json`), "utf8"))).toMatchObject({ status: "pending", candidateRevision: revision });
  expect((await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/install", headers, payload })).json().operationId).toBe(first.json().operationId);
  expect(installation.launch).toHaveBeenCalledTimes(1);
  const restartedLaunch = vi.fn(), restarted = new HermesUpgrades(installation.config, installation.runtime, restartedLaunch);
  installation.save({ ...installation.state(), workerPid: 99999999, updatedAt: "2020-01-01T00:00:00Z" });
  expect((await restarted.status({ id: "local-one", email: "one@localhost.invalid", name: "One" }))).toMatchObject({ phase: "blocked", canCheck: false, canInstall: false });
  expect(restarted.maintenance()).toBe(true);
  expect(restartedLaunch).not.toHaveBeenCalled();
  const conflict = await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/install", headers, payload: { ...payload, candidateRevision: "b".repeat(40) } });
  expect(conflict.statusCode).toBe(409);
});

it("blocks new work during maintenance while retaining personal drafts and read access", async () => {
  const installation = await setup(), headers = await login(installation.app); installation.ready();
  await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/install", headers, payload: { candidateRevision: revision, requestId: randomUUID() } });
  const message = await installation.app.inject({ method: "POST", url: "/api/bots/shared/messages", headers, payload: { requestId: randomUUID(), text: "Wait" } });
  expect(message.statusCode).toBe(409); expect(message.json().code).toBe("hermes_maintenance");
  expect(installation.runtime.submit).not.toHaveBeenCalled();
  expect((await installation.app.inject({ method: "PUT", url: "/api/bots/shared/draft", headers, payload: { text: "Saved for later", attachments: [] } })).statusCode).toBe(200);
  expect((await installation.app.inject({ url: "/api/bots/shared/draft", headers })).json().text).toBe("Saved for later");
  expect((await installation.app.inject({ url: "/api/hermes/upgrade", headers })).statusCode).toBe(200);
});

it("fails closed on damaged durable records and rejects shared installer configuration", async () => {
  const installation = await setup(); installation.save({ invalid: true });
  expect(installation.upgrades.maintenance()).toBe(true);
  expect(await installation.upgrades.status({ id: "local-one", email: "one@localhost.invalid", name: "One" })).toMatchObject({ phase: "blocked", canCheck: false, canInstall: false, error: "invalid_upgrade_record" });
  chmodSync(installation.workerConfig, 0o644);
  expect(() => new HermesUpgrades(installation.config, installation.runtime, vi.fn())).toThrow("inaccessible to other users");
  expect(() => loadConfig({ HERMES_UPGRADE_ENABLED: "true" })).toThrow("explicit administrators");
});
