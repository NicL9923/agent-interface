#!/usr/bin/env node
// Linux app host only: node --env-file=PRIVATE_APP_ENV --import tsx THIS_FILE PRIVATE_RECEIPT
// Synthetic speech uses configured providers. No conversation, memory, routine or Today mutations.
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const activePhases = new Set(["checking", "qualifying", "draining", "installing", "verifying", "rolling_back", "recovering"]);
const check = (condition) => { if (!condition) throw new Error("Acceptance condition failed"); };
const jsonFile = path => JSON.parse(readFileSync(path, "utf8"));
const fingerprint = conversation => createHash("sha256").update(JSON.stringify({ sessionId: conversation.sessionId, messages: conversation.messages })).digest("hex");
const providerName = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : "unspecified";
let step = "host_preflight";

async function accept() {
  const receiptPath = process.argv[2];
  check(process.platform === "linux" && process.argv.length === 3 && isAbsolute(receiptPath ?? "") && !existsSync(receiptPath));
  const parent = lstatSync(dirname(receiptPath));
  check(parent.isDirectory() && (parent.mode & 0o077) === 0 && parent.uid === process.getuid());
  // The helper may live in a private operation directory. Imports come from the
  // current deployed release, selected by the caller's working directory.
  const appRoot = resolve(process.cwd());
  check(existsSync(join(appRoot, "dist/client/sw.js")));
  const { allowedIdentity, loadConfig } = await import(pathToFileURL(join(appRoot, "src/server/config.ts")).href);
  const { hash } = await import(pathToFileURL(join(appRoot, "src/server/auth.ts")).href);
  const { MAX_VOICE_BYTES, VOICE_MIMES } = await import(pathToFileURL(join(appRoot, "src/shared/voice.ts")).href);
  const config = loadConfig();
  check(config.host === "127.0.0.1" && isAbsolute(config.database) && existsSync(config.database));
  check(config.hermesAuthMode === "service" && config.hermesToken && config.hermesUpgrade);
  const native = new URL(config.hermesUrl);
  check(native.protocol === "http:" && native.hostname === "127.0.0.1" && native.port && native.pathname === "/" && !native.search && !native.hash && !native.username && !native.password);
  const worker = jsonFile(config.hermesUpgrade.workerConfig), finish = worker.hooks?.finish;
  check(Array.isArray(finish) && finish.includes("--config"));
  const platform = jsonFile(finish[finish.indexOf("--config") + 1]);
  check(isAbsolute(platform.maintenanceFile) && isAbsolute(worker.managedHome) && platform.hermesHome === worker.managedHome);
  function maintenanceClear() {
    const state = jsonFile(join(config.hermesUpgrade.stateDirectory, "status.json"));
    check(state.maintenance === false && !activePhases.has(state.phase));
    check(!existsSync(platform.maintenanceFile) && !existsSync(join(worker.managedHome, ".drain_request.json")) && !existsSync(join(worker.managedHome, ".hermes-update-in-progress")));
    const pending = readdirSync(join(config.hermesUpgrade.stateDirectory, "requests")).filter(name => name.endsWith(".json"));
    check(pending.every(name => jsonFile(join(config.hermesUpgrade.stateDirectory, "requests", name)).status === "complete"));
  }
  maintenanceClear();
  const db = new DatabaseSync(config.database, { timeout: 2000 });
  const token = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex"), tokenHash = hash(token);
  const timer = AbortSignal.timeout(240_000);
  const base = `http://127.0.0.1:${config.port}`;
  const headers = { cookie: `session=${token}`, origin: config.origin, "x-csrf-token": csrf };
  let sessionCreated = false;
  let receipt;
  async function request(url, init = {}, limit = 12 * 1024 * 1024, timeout = 60_000) {
    const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.any([timer, AbortSignal.timeout(timeout)]) });
    check(response.ok);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > limit) { await response.body.cancel().catch(() => {}); check(false); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const app = async (path, init = {}) => JSON.parse(await request(base + path, { ...init, headers: { ...headers, ...init.headers } }));
  const nativeSpeech = async (profile, text) => JSON.parse(await request(new URL(`/api/agent-interface/service/audio/speak?profile=${encodeURIComponent(profile)}`, native), {
    method: "POST", headers: { authorization: `Bearer ${config.hermesToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ text }),
  }));
  try {
    step = "temporary_session";
    const user = db.prepare("SELECT id,email FROM users ORDER BY id").all().find(user => allowedIdentity(config, user));
    check(user);
    db.prepare("INSERT INTO sessions(hash,user_id,csrf,expires) VALUES(?,?,?,?)").run(tokenHash, user.id, csrf, Date.now() + 300_000); sessionCreated = true;
    step = "authenticated_bootstrap";
    const bootstrap = await app("/api/bootstrap");
    check(bootstrap.user?.id === user.id && bootstrap.csrfToken === csrf && bootstrap.connection?.connected && Array.isArray(bootstrap.bots));
    const profiles = ["default", "kimberly"];
    check(profiles.every(profile => bootstrap.bots.some(bot => bot.id === profile)));
    step = "deployed_build";
    const workerSource = await request(base + "/sw.js", {}, 1024 * 1024, 20_000);
    const webBuild = workerSource.match(/const CACHE = 'agent-interface-([0-9a-f]{16})'/)?.[1]; check(webBuild);
    check(readFileSync(join(appRoot, "dist/client/sw.js"), "utf8") === workerSource);
    step = "today_snapshot";
    const today = await app("/api/today");
    check(/^\d{1,16}$/.test(today.frontier) && Number.isSafeInteger(Number(today.frontier)) && typeof today.hasMore === "boolean" && Array.isArray(today.items) && Array.isArray(today.events));
    check(Number.isFinite(Date.parse(today.generatedAt)) && Number.isFinite(Date.parse(today.since)) && today.unavailableBots?.length === 0);
    step = "routine_listing";
    const routines = await app("/api/routines"); check(Array.isArray(routines));
    const results = [];
    for (const [index, profile] of profiles.entries()) {
      const started = Date.now(), path = `/api/bots/${encodeURIComponent(profile)}`;
      step = `profile_${index + 1}_memory`;
      const memory = await app(path + "/memory");
      check(memory.botId === profile && memory.profile === profile && memory.scope === "profile" && memory.owner === "Hermes");
      check(memory.documents?.length === 2 && memory.documents.every(document => ["memory", "user"].includes(document.target) && /^[a-f0-9]{64}$/.test(document.revision) && Array.isArray(document.entries)));
      step = `profile_${index + 1}_vault_metadata`;
      const vault = await app(path + "/vault");
      check(vault.botId === profile && vault.profile === profile && vault.scope === "profile" && vault.owner === "Hermes");
      check(Array.isArray(vault.items) && Array.isArray(vault.sources) && vault.sources.some(source => source.name === "local"));
      check(vault.items.every(item => item.kind === "login" && typeof item.label === "string" && typeof item.identifier === "string" && typeof item.canRemove === "boolean" && !["password", "secret", "otpSecret", "key"].some(key => key in item)));
      step = `profile_${index + 1}_schedule_preview`;
      maintenanceClear();
      const schedule = routines.find(routine => routine.botId === profile && routine.enabled && typeof routine.schedule === "string" && routine.schedule.trim().split(/\s+/).length === 5)?.schedule ?? "0 9 * * *";
      const preview = await app("/api/routines/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ botId: profile, schedule }) });
      check(preview.botId === profile && typeof preview.timezone === "string" && preview.timezone.length && preview.nextRuns?.length === 3 && preview.nextRuns.every(value => Number.isFinite(Date.parse(value))));
      step = `profile_${index + 1}_conversation_before`;
      const before = await app(path + "/conversation");
      check(Array.isArray(before.messages) && ["idle", "done", "failed", "interrupted"].includes(before.activity?.state));
      const beforeHash = fingerprint(before);
      step = `profile_${index + 1}_synthetic_speech`;
      maintenanceClear();
      const speech = await nativeSpeech(profile, "The blue tractor is parked beside the barn.");
      const match = typeof speech.data_url === "string" && speech.data_url.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
      check(speech.ok === true && match && match[1] === speech.mime_type && VOICE_MIMES.has(match[1]));
      const audio = Buffer.from(match[2], "base64");
      check(audio.length > 0 && audio.length <= MAX_VOICE_BYTES && audio.toString("base64") === match[2]);
      step = `profile_${index + 1}_app_transcription`;
      maintenanceClear();
      const form = new FormData(); form.append("audio", new Blob([audio], { type: speech.mime_type }), "synthetic.audio");
      const transcript = await app(path + "/voice/transcribe", { method: "POST", body: form });
      check(typeof transcript.text === "string" && /\btractor\b/i.test(transcript.text) && /\bbarn\b/i.test(transcript.text));
      step = `profile_${index + 1}_conversation_unchanged`;
      const after = await app(path + "/conversation");
      check(Array.isArray(after.messages) && fingerprint(after) === beforeHash);
      results.push({ profileNumber: index + 1, memoryRead: true, vaultMetadataRead: true, schedulePreview: true, syntheticVoiceRecognized: true, conversationUnchanged: true, speechProvider: providerName(speech.provider), transcriptionProvider: providerName(transcript.provider), elapsedMs: Date.now() - started });
    }
    step = "final_maintenance_check"; maintenanceClear();
    receipt = { accepted: true, checkedAt: new Date().toISOString(), webBuild, checks: { authenticatedBootstrap: true, durableTodayFrontier: true, nativeProfiles: results } };
  } finally {
    const previousStep = step;
    step = "temporary_session_cleanup";
    try { if (sessionCreated) db.prepare("DELETE FROM sessions WHERE hash=?").run(tokenHash); }
    finally { db.close(); }
    step = previousStep;
  }
  step = "receipt";
  receipt.checks.temporarySessionRemoved = true;
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(receipt));
}
try { await accept(); }
catch { console.error(JSON.stringify({ accepted: false, failedCheck: step })); process.exitCode = 1; }
