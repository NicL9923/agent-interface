import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";
import { HermesUpgrades, launchWorker, transientRunner } from "../src/server/upgrades.js";
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

it("dates the running Hermes revision in bootstrap, and a bad date never invalidates the record", async () => {
  const installation = await setup(), headers = await login(installation.app);
  installation.runtime.status = async () => ({ connected: true, version: revision });
  installation.runtime.capabilities = async () => ({ chat: { supported: true }, avatarMetadata: { supported: false } }) as Awaited<ReturnType<Runtime["capabilities"]>>;
  const committedAt = "2026-10-15T22:07:17+00:00";
  installation.save({ phase: "idle", current: { revision, committedAt }, checks: [], message: "Idle" });
  expect((await installation.app.inject({ url: "/api/bootstrap", headers })).json().connection).toEqual({ connected: true, version: revision, revisionDate: committedAt });
  expect((await installation.app.inject({ url: "/api/hermes/upgrade", headers })).json().current).toEqual({ revision, committedAt });
  installation.save({ phase: "idle", current: { revision, committedAt: "yesterday-ish" }, checks: [], message: "Idle" });
  const status = (await installation.app.inject({ url: "/api/hermes/upgrade", headers })).json();
  expect(status).toMatchObject({ phase: "idle", current: { revision } });
  expect(status.current.committedAt).toBeUndefined();
  expect((await installation.app.inject({ url: "/api/bootstrap", headers })).json().connection.revisionDate).toBeUndefined();
});

it("labels a check as a check", async () => {
  const installation = await setup(), headers = await login(installation.app);
  const checked = await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/check", headers, payload: {} });
  expect(checked.json()).toMatchObject({ phase: "checking", operation: "check" });
  installation.save({ ...installation.state(), phase: "blocked", error: "repair_requires_review", message: "Needs review" });
  expect((await installation.app.inject({ url: "/api/hermes/upgrade", headers })).json().operation).toBe("check");
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
  expect(first.json()).toMatchObject({ phase: "installing", canInstall: false, operation: "install" });
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
  // A stopped install stays an install, so the panel keeps its recovery wording.
  expect((await restarted.status({ id: "local-one", email: "one@localhost.invalid", name: "One" })).operation).toBe("install");
  const conflict = await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/install", headers, payload: { ...payload, candidateRevision: "b".repeat(40) } });
  expect(conflict.statusCode).toBe(409);
});

it("blocks new work during maintenance while retaining personal drafts and read access", async () => {
  const installation = await setup(), headers = await login(installation.app); installation.ready();
  await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/install", headers, payload: { candidateRevision: revision, requestId: randomUUID() } });
  const message = await installation.app.inject({ method: "POST", url: "/api/bots/shared/messages", headers, payload: { requestId: randomUUID(), text: "Wait" } });
  expect(message.statusCode).toBe(409); expect(message.json().code).toBe("hermes_maintenance");
  const encoded = await installation.app.inject({ method: "POST", url: "/%61pi/bots/shared/messages", headers, payload: { requestId: randomUUID(), text: "Wait" } });
  expect(encoded.statusCode).toBe(409);
  expect(installation.runtime.submit).not.toHaveBeenCalled();
  expect((await installation.app.inject({ method: "PUT", url: "/api/bots/shared/draft", headers, payload: { text: "Saved for later", attachments: [] } })).statusCode).toBe(200);
  expect((await installation.app.inject({ method: "PUT", url: "/api/bots/shared/read-position", headers, payload: { messageId: "m1" } })).statusCode).toBe(200);
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

const administrator = { id: "local-one", email: "one@localhost.invalid", name: "One" };
it("persists cancellation intent, fences stale operations, and resumes an unstarted recovery once", async () => {
  const installation = await setup();
  const operationId = randomUUID(), requestId = randomUUID();
  installation.save({ phase: "qualifying", operationId, message: "Checking", checks: [], updatedAt: "2020-01-01T00:00:00Z" });
  expect(await installation.upgrades.status(administrator)).toMatchObject({ phase: "blocked", canRetry: true, canCancel: true });
  await expect(installation.upgrades.control(administrator, { action: "cancel", operationId: randomUUID(), requestId })).rejects.toThrow("Refresh");
  const input = { action: "cancel" as const, operationId, requestId };
  const status = await installation.upgrades.control(administrator, input);
  expect(status).toMatchObject({ controlRequestId: requestId, controlAction: "cancel", canRetry: false, canCancel: false });
  expect(installation.launch).toHaveBeenLastCalledWith({ action: "cancel", operationId });
  await installation.upgrades.control(administrator, input);
  expect(installation.launch).toHaveBeenCalledOnce();
  const intentPath = join(installation.directory, "controls", `${operationId}.json`);
  expect(JSON.parse(readFileSync(intentPath, "utf8"))).toMatchObject({ status: "pending", ...input });
  const restartedLaunch = vi.fn(), restarted = new HermesUpgrades(installation.config, installation.runtime, restartedLaunch);
  // Simulate a lost launch after the durable intent was persisted.
  writeFileSync(intentPath, JSON.stringify({ ...input, status: "pending", startedAt: "2020-01-01T00:00:00Z" }));
  expect(await restarted.status(administrator)).toMatchObject({ canRetry: true, canCancel: true });
  await restarted.control(administrator, input);
  expect(restartedLaunch).toHaveBeenCalledOnce();
  await expect(restarted.control(administrator, { ...input, action: "retry" })).rejects.toThrow("already belongs");
});

it("offers only receipt-backed recovery and never rolls back an ambiguous release", async () => {
  const installation = await setup();
  const operationId = randomUUID(), stage = join(installation.directory, "stages", "qualification-fixture");
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  const original = "a".repeat(40), deployed = join(installation.directory, "deployed.json");
  writeFileSync(installation.workerConfig, JSON.stringify({ stageRoot: join(installation.directory, "stages"), qualificationReceipt: deployed,
    hooks: { recover: ["/bin/true"], restart_service: ["/bin/true"] } }));
  const qualification = { stage, currentRevision: original, currentPatchSha256: null, candidateRevision: revision, candidatePatchSha256: null, integrationDigest: "b".repeat(64) };
  installation.save({ phase: "failed", operationId, requestId: randomUUID(), maintenance: true, qualification, checks: [], message: "Interrupted", updatedAt: "2020-01-01T00:00:00Z" });
  writeFileSync(join(stage, "platform.json"), JSON.stringify({ operationId, phase: "installed" }));
  writeFileSync(deployed, JSON.stringify({ schemaVersion: 1, revision, trackedPatchSha256: null, qualifiedAt: "2026-10-01", checks: { realIntegration: true, hostRegressions: true }, integrationDigest: qualification.integrationDigest }));
  expect(await installation.upgrades.status(administrator)).toMatchObject({ canRetry: false, canCancel: false, canRestartService: true });
  const previousReceipt = Buffer.from(JSON.stringify({ schemaVersion: 1, revision: original, trackedPatchSha256: null, qualifiedAt: "2026-10-01", checks: { realIntegration: true, hostRegressions: true }, integrationDigest: qualification.integrationDigest })).toString("base64");
  writeFileSync(join(stage, "recovery.json"), JSON.stringify({ operationId, previousReceipt, hostHookStarted: true, releaseStarted: false }));
  expect(await installation.upgrades.status(administrator)).toMatchObject({ canRetry: true, canCancel: true, canRestartService: true });
  writeFileSync(join(stage, "recovery.json"), JSON.stringify({ operationId, previousReceipt, hostHookStarted: true, releaseStarted: true }));
  expect(await installation.upgrades.status(administrator)).toMatchObject({ canRetry: false, canCancel: false, canRestartService: false });
  await expect(installation.upgrades.control(administrator, { action: "cancel", operationId, requestId: randomUUID() })).rejects.toThrow("unavailable");
  expect(installation.upgrades.maintenance()).toBe(true);
  expect(installation.launch).not.toHaveBeenCalled();
});

it("keeps recovery administrator-only and browser CSRF protected", async () => {
  const installation = await setup(), admin = await login(installation.app), member = await login(installation.app, "two");
  const operationId = randomUUID();
  installation.save({ phase: "failed", operationId, message: "Failed check", checks: [] });
  const payload = { action: "retry", operationId, requestId: randomUUID() };
  expect((await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/control", headers: member, payload })).statusCode).toBe(403);
  expect((await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/control", headers: { cookie: admin.cookie, origin }, payload })).statusCode).toBe(403);
  expect((await installation.app.inject({ method: "POST", url: "/api/hermes/upgrade/control", headers: admin, payload: { ...payload, command: "reboot" } })).statusCode).toBe(400);
});

it("reconciles verified outcomes but keeps unrelated stale receipts behind maintenance", async () => {
  const installation = await setup(); installation.ready();
  await installation.upgrades.install(administrator, { candidateRevision: revision, requestId: randomUUID() });
  const pending = installation.state();
  installation.save({ ...pending, phase: "succeeded", maintenance: false, message: "Verified", updatedAt: "2020-01-01T00:00:00Z" });
  expect(installation.upgrades.maintenance()).toBe(false);
  expect(JSON.parse(readFileSync(join(installation.directory, "requests", `${pending.requestId}.json`), "utf8"))).toMatchObject({ status: "complete" });
  writeFileSync(join(installation.directory, "requests", `${randomUUID()}.json`), JSON.stringify({ status: "pending", operationId: randomUUID(), candidateRevision: revision }));
  expect(installation.upgrades.maintenance()).toBe(true);
  expect(await installation.upgrades.status(administrator)).toMatchObject({ canCheck: false, canInstall: false, canRetry: false, canCancel: false, canRestartService: false });
});

it.each(["cancel", "restart_service"] as const)("reads the actual Python %s recovery result and existing null error records without reentering maintenance", async action => {
  const installation = await setup(), operationId = randomUUID(), requestId = randomUUID();
  installation.save({ phase: "failed", operationId, requestId, maintenance: false, error: "qualification_failed", message: "Failed", checks: [] });
  const receiptPath = join(installation.directory, "requests", `${requestId}.json`);
  writeFileSync(receiptPath, JSON.stringify({ operationId, candidateRevision: revision, status: "pending" }), { mode: 0o600 });
  // Run the worker's actual persistence and request completion code. No host
  // hook runs because this operation failed before taking native maintenance.
  const python = spawnSync("/usr/bin/python3", ["-c", `import importlib.util,sys
spec=importlib.util.spec_from_file_location("worker",sys.argv[1])
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
worker.Worker(sys.argv[2],sys.argv[3],sys.argv[4],sys.argv[5]).recovery(sys.argv[4])`,
    resolve("scripts/hermes-upgrade-worker.py"), installation.workerConfig, installation.directory, action, operationId], { encoding: "utf8" });
  expect(python.status, python.stderr).toBe(0);
  const persisted = installation.state();
  expect(persisted).not.toHaveProperty("error");
  expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({ status: "complete" });
  const phase = action === "cancel" ? "cancelled" : "succeeded";
  expect(await installation.upgrades.status(administrator)).toMatchObject({ phase, operationId, canCheck: true });
  expect(installation.upgrades.maintenance()).toBe(false);
  // Previously shipped recovery records explicitly wrote JSON null. Accept
  // those records too, so an app restart can read an already verified outcome.
  installation.save({ ...persisted, error: null });
  const status = await installation.upgrades.status(administrator);
  expect(status).toMatchObject({ phase, operationId, canCheck: true });
  expect(status.error).toBeUndefined();
  expect(installation.upgrades.maintenance()).toBe(false);
});

it("starts the worker as its own systemd user unit when the app runs under systemd", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-interface-launch-"));
  try {
    expect(transientRunner({}, "/bin/sh")).toBeUndefined();
    expect(transientRunner({ INVOCATION_ID: "x", XDG_RUNTIME_DIR: "/run/user/1" }, "/bin/sh")).toBe("/bin/sh");
    expect(transientRunner({ INVOCATION_ID: "x", XDG_RUNTIME_DIR: "/run/user/1" }, join(directory, "missing"))).toBeUndefined();
    const runner = join(directory, "systemd-run"), seen = join(directory, "argv");
    writeFileSync(runner, `#!/bin/sh\nprintf '%s\\n' "$@" > ${seen}\n`, { mode: 0o700 });
    const child = launchWorker({ python: "/py", workerConfig: "/config.json", stateDirectory: directory }, { action: "check", operationId: "op" }, "/worker.py", runner);
    await new Promise(done => child.on("exit", done));
    const argv = readFileSync(seen, "utf8").trim().split("\n");
    const log = readdirSync(directory).find(name => name.startsWith("worker-launch-"))!;
    expect(argv.slice(0, 3)).toEqual(["--user", "--collect", "--quiet"]);
    expect(argv).toContain("--property=UMask=0077");
    expect(argv).toContain(`--property=StandardOutput=append:${join(directory, log)}`);
    expect(argv).toContain("--setenv=LANG=C.UTF-8");
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["/py", "/worker.py", "--config", "/config.json", "--state-dir", directory, "--action", "check", "--operation-id", "op"]);
    // A refused unit is a worker that never started.
    const refusing = join(directory, "refusing-systemd-run");
    writeFileSync(refusing, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const refused = launchWorker({ python: "/py", workerConfig: "/config.json", stateDirectory: directory }, { action: "check", operationId: "op" }, "/worker.py", refusing);
    const error = await new Promise<Error>(done => refused.on("error", done));
    expect(error.message).toBe("systemd-run exited with 1");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("keeps each worker launch's startup output privately instead of discarding it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-interface-launch-"));
  try {
    const python = join(directory, "python");
    writeFileSync(python, "#!/bin/sh\necho \"Traceback: worker could not start $7\" >&2\nexit 3\n", { mode: 0o700 });
    const launch = async (action: string) => {
      const child = launchWorker({ python, workerConfig: "/config.json", stateDirectory: directory }, { action, operationId: "op" }, "/worker.py", undefined);
      return new Promise(done => child.on("exit", done));
    };
    expect(await launch("check")).toBe(3);
    expect(await launch("install")).toBe(3);
    const logs = readdirSync(directory).filter(name => name.startsWith("worker-launch-")).map(name => join(directory, name));
    // A retry keeps the earlier failure; each log is private.
    expect(logs).toHaveLength(2);
    expect(logs.map(path => readFileSync(path, "utf8")).sort()).toEqual(["Traceback: worker could not start check\n", "Traceback: worker could not start install\n"]);
    for (const path of logs) expect(statSync(path).mode & 0o777).toBe(0o600);
    for (let index = 0; index < 12; index++) await launch("check");
    expect(readdirSync(directory).filter(name => name.startsWith("worker-launch-"))).toHaveLength(10);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
