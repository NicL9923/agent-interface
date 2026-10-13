#!/usr/bin/env node
// Run on the Linux app host with the live release as the working directory, its private env file and --import tsx.
// Drives the app's own Hermes updater as the designated administrator, so every admission,
// busy-assistant and recovery rule still applies. Each call uses a two-minute, pre-confirmed
// app session that is deleted afterwards. Prints the updater status as JSON.
import {randomBytes, randomUUID} from "node:crypto";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
// Resolved from the working directory, so the helper can be uploaded and run beside any release.
const load = path => import(pathToFileURL(resolve(path)).href);
const [{loadConfig}, {Store}, {hash}] = await Promise.all(["src/server/config.ts", "src/server/store.ts", "src/server/auth.ts"].map(load));

const [action, value] = process.argv.slice(2);
const controls = ["retry", "cancel", "restart_service"];
if (!["status", "check", "install", "control"].includes(action) || (action === "install") !== /^[a-f0-9]{40}$/.test(value ?? "")
    || (action === "control") !== controls.includes(value))
  throw new Error("Usage: hermes-update.mjs status | check | install CANDIDATE_REVISION | control retry|cancel|restart_service");
const config = loadConfig(), store = new Store(config.database);
const admins = config.hermesUpgrade?.adminEmails ?? [];
const user = store.db.prepare("SELECT id,email FROM users").all().find(row => admins.includes(row.email.toLowerCase()));
if (!user) throw new Error("A Hermes update administrator must sign into the app once first");
const token = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
store.session(hash(token), user.id, csrf, Date.now() + 120000);
store.confirmSession(hash(token), Date.now());
const headers = {cookie: `session=${token}`, origin: config.origin, "x-csrf-token": csrf, "content-type": "application/json"};
try {
  const base = `http://127.0.0.1:${config.port}/api/hermes/upgrade`;
  // A recovery control names the operation it applies to, read from the updater itself.
  const current = action === "control" ? await (await fetch(base, {headers})).json() : undefined;
  const path = action === "status" ? "" : "/" + action;
  const body = action === "install" ? {candidateRevision: value, requestId: randomUUID()} : action === "check" ? {}
    : action === "control" ? {action: value, operationId: current.operationId, requestId: randomUUID()} : undefined;
  const response = await fetch(base + path,
    {method: body ? "POST" : "GET", headers, body: body && JSON.stringify(body)});
  const result = await response.json();
  console.log(JSON.stringify({status: response.status, phase: result.phase, message: result.message ?? result.error,
    current: result.current, candidate: result.candidate, busyBots: result.busyBots, canInstall: result.canInstall,
    canRetry: result.canRetry, canCancel: result.canCancel, canRestartService: result.canRestartService,
    checks: result.checks?.map(check => `${check.id}: ${check.status}${check.detail ? ` (${check.detail})` : ""}`)}, null, 2));
  if (!response.ok) process.exitCode = 1;
} finally {
  store.deleteSession(hash(token));
  store.close();
}
