#!/usr/bin/env node
// Run on the Linux app host with the live release as the working directory, its private env file and --import tsx.
// Drives the app's own Hermes updater as the designated administrator, so every admission,
// busy-assistant and recovery rule still applies. Each call uses a two-minute, pre-confirmed
// app session that is deleted afterwards. Prints the updater status as JSON.
import {randomBytes, randomUUID} from "node:crypto";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

export const WAIT_LIMIT_MS = 4 * 60 * 60 * 1000, START_LIMIT_MS = 5 * 60 * 1000;
const RUNNING = new Set(["checking", "qualifying", "installing", "verifying", "recovering"]);

/** Follow an operation through the app's status, which alone notices a worker that died.
 * Until the worker writes, the status still holds the previous operation's settled phase: on
 * Nov 4, 2026 a retry --wait read the old "failed" and exited while the retry went on to pass.
 * So after a request, a status counts only once it is newer than the request: a different
 * operation, or an updatedAt no older than the request. A retry first finishes its recovery
 * as "succeeded" and then starts a new check under a new operation, so only that new
 * operation settles it, unless the recovery itself fails first. Returns the exit code: 0 ready, succeeded or idle; 1 another settled
 * phase or an operation that never started; 2 an interrupted worker; 3 still running at the
 * deadline. */
export async function follow(result, {action, control, original, requested, poll, log = console.log, now = Date.now,
  sleep = ms => new Promise(done => setTimeout(done, ms))}) {
  const deadline = now() + WAIT_LIMIT_MS;
  const replaced = value => Boolean(value.operationId) && value.operationId !== original;
  const pending = value => action !== "status" && !replaced(value) && !(Date.parse(value.updatedAt ?? "") >= requested);
  // A retry's recovery that fails ends on the original operation, so only its interim success waits.
  const settles = value => !(action === "control" && control === "retry") || replaced(value) || value.phase !== "succeeded";
  let seen = "";
  while (now() < deadline) {
    const step = result.checks?.findLast(check => check.status === "running")?.id ?? "";
    const line = `${result.phase}${step ? " / " + step : ""}${result.error ? " (" + result.error + ")" : ""}`;
    if (pending(result)) {
      if (!result.controlRequestId && now() - requested > START_LIMIT_MS) {
        log("The updater did not start the requested operation."); return {code: 1, result};
      }
    } else {
      if (line !== seen) { log(`${new Date(now()).toISOString()} ${line}`); seen = line; }
      // The app reports a worker that stopped mid-operation; act on it at once.
      if (result.error === "worker_interrupted") return {code: 2, result};
      if (!RUNNING.has(result.phase) && !result.controlRequestId && settles(result))
        return {code: ["ready", "succeeded", "idle"].includes(result.phase) ? 0 : 1, result};
    }
    await sleep(20000);
    result = await poll();
  }
  return {code: 3, result};
}

async function main() {
  // Resolved from the working directory, so the helper can be uploaded and run beside any release.
  const load = path => import(pathToFileURL(resolve(path)).href);
  const [{loadConfig}, {Store}, {hash}] = await Promise.all(["src/server/config.ts", "src/server/store.ts", "src/server/auth.ts"].map(load));
  const wait = process.argv.includes("--wait");
  const [action, value] = process.argv.slice(2).filter(arg => arg !== "--wait");
  const controls = ["retry", "cancel", "restart_service"];
  if (!["status", "check", "install", "control"].includes(action) || (action === "install") !== /^[a-f0-9]{40}$/.test(value ?? "")
      || (action === "control") !== controls.includes(value))
    throw new Error("Usage: hermes-update.mjs status | check | install CANDIDATE_REVISION | control retry|cancel|restart_service [--wait]");
  const config = loadConfig(), store = new Store(config.database);
  const admins = config.hermesUpgrade?.adminEmails ?? [];
  const user = store.db.prepare("SELECT id,email FROM users").all().find(row => admins.includes(row.email.toLowerCase()));
  if (!user) throw new Error("A Hermes update administrator must sign into the app once first");
  const token = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
  store.session(hash(token), user.id, csrf, Date.now() + (wait ? WAIT_LIMIT_MS : 120000));
  store.confirmSession(hash(token), Date.now());
  const headers = {cookie: `session=${token}`, origin: config.origin, "x-csrf-token": csrf, "content-type": "application/json"};
  try {
    const base = `http://127.0.0.1:${config.port}/api/hermes/upgrade`;
    // A recovery control names the operation it applies to, read from the updater itself. The
    // operation before the request also tells --wait which status is still the old one.
    const current = action === "status" ? undefined : await (await fetch(base, {headers})).json();
    const path = action === "status" ? "" : "/" + action;
    const body = action === "install" ? {candidateRevision: value, requestId: randomUUID()} : action === "check" ? {}
      : action === "control" ? {action: value, operationId: current.operationId, requestId: randomUUID()} : undefined;
    // The worker stamps updatedAt with this host's clock; a second of slack absorbs rounding.
    const requested = Date.now() - 1000;
    const response = await fetch(base + path, {method: body ? "POST" : "GET", headers, body: body && JSON.stringify(body)});
    let result = await response.json();
    if (!response.ok) process.exitCode = 1;
    else if (wait) {
      const followed = await follow(result, {action, control: value, original: current?.operationId, requested,
        poll: async () => (await fetch(base, {headers})).json()});
      process.exitCode = followed.code; result = followed.result;
    }
    console.log(JSON.stringify({status: response.status, phase: result.phase, message: result.message ?? result.error,
      current: result.current, candidate: result.candidate, busyBots: result.busyBots, canInstall: result.canInstall,
      canRetry: result.canRetry, canCancel: result.canCancel, canRestartService: result.canRestartService,
      checks: result.checks?.map(check => `${check.id}: ${check.status}${check.detail ? ` (${check.detail})` : ""}`)}, null, 2));
  } finally {
    store.deleteSession(hash(token));
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
