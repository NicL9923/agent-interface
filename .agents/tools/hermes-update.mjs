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

const [action, revision] = process.argv.slice(2);
if (!["status", "check", "install"].includes(action) || (action === "install") !== /^[a-f0-9]{40}$/.test(revision ?? ""))
  throw new Error("Usage: hermes-update.mjs status | check | install CANDIDATE_REVISION");
const config = loadConfig(), store = new Store(config.database);
const admins = config.hermesUpgrade?.adminEmails ?? [];
const user = store.db.prepare("SELECT id,email FROM users").all().find(row => admins.includes(row.email.toLowerCase()));
if (!user) throw new Error("A Hermes update administrator must sign into the app once first");
const token = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
store.session(hash(token), user.id, csrf, Date.now() + 120000);
store.confirmSession(hash(token), Date.now());
const headers = {cookie: `session=${token}`, origin: config.origin, "x-csrf-token": csrf, "content-type": "application/json"};
try {
  const path = action === "status" ? "" : "/" + action;
  const body = action === "install" ? {candidateRevision: revision, requestId: randomUUID()} : action === "check" ? {} : undefined;
  const response = await fetch(`http://127.0.0.1:${config.port}/api/hermes/upgrade${path}`,
    {method: body ? "POST" : "GET", headers, body: body && JSON.stringify(body)});
  const result = await response.json();
  console.log(JSON.stringify({status: response.status, phase: result.phase, message: result.message ?? result.error,
    current: result.current, candidate: result.candidate, busyBots: result.busyBots, canInstall: result.canInstall,
    checks: result.checks?.map(check => `${check.id}: ${check.status}${check.detail ? ` (${check.detail})` : ""}`)}, null, 2));
  if (!response.ok) process.exitCode = 1;
} finally {
  store.deleteSession(hash(token));
  store.close();
}
