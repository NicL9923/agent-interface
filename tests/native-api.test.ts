import { createHash, randomBytes, randomUUID, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { loadConfig, type Config } from "../src/server/config.js";
import { accountMarker, ApnsError, apnsCollapseId, createApnsSender, apnsClearPayload, apnsPayload } from "../src/server/apns.js";
import { BackgroundWorker } from "../src/server/notifications.js";
import { Store } from "../src/server/store.js";
import { defaultPreferences, type RuntimeEvent } from "../src/shared/types.js";
import { fakeRuntime } from "./helpers/server.js";
import Fastify from "fastify";
import { errorHandler } from "../src/server/http-error.js";

const origin = "http://127.0.0.1:3000";
const runtime = fakeRuntime({ status: async () => ({ connected: false }), listBots: async () => [{ id: "bot", name: "Bot", shared: true, model: "test", activity: "idle" }], capabilities: async () => ({ avatarMetadata: { supported: false }, generatedFiles: { supported: true }, idempotency: { supported: false }, durableEvents: { supported: false } }), download: async () => ({ body: new Blob(["file body"]).stream(), name: "answer.txt", mime: "text/plain" }), close: async () => {} });
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { for (const { app } of apps.splice(0)) await app.close(); });
async function setup(config = loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), verifyGoogle?: NonNullable<Parameters<typeof createApp>[2]>["verifyGoogle"]) {
  const result = await createApp(config, runtime, { background: false, verifyGoogle, sendApns: config.apns ? async () => {} : undefined });
  apps.push(result); return result;
}
async function flow(app: Awaited<ReturnType<typeof createApp>>["app"]) {
  const state = randomBytes(32).toString("base64url"), codeVerifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({ state, code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"), code_challenge_method: "S256" });
  const response = await app.inject(`/native/sign-in?${query}`);
  expect(response.statusCode).toBe(200);
  return { state, codeVerifier, cookie: `native_flow=${response.cookies[0].value}`, cookieValue: response.cookies[0].value, response };
}
async function connectNative(app: Awaited<ReturnType<typeof createApp>>["app"], member: "one" | "two" = "one") {
  const started = await flow(app);
  const completed = await app.inject({ method: "POST", url: "/api/auth/native/complete", headers: { origin, cookie: started.cookie }, payload: { member } });
  expect(completed.statusCode).toBe(200);
  const callback = new URL(completed.json().callback);
  expect(callback.origin + callback.pathname).toBe("null/callback");
  expect(callback.protocol).toBe("agentinterface:");
  const payload = { code: callback.searchParams.get("code")!, state: started.state, codeVerifier: started.codeVerifier };
  const exchanged = await app.inject({ method: "POST", url: "/api/auth/native/exchange", payload });
  expect(exchanged.statusCode).toBe(200);
  return { token: exchanged.json().token as string, payload, started };
}
const apnsConfig = (): NonNullable<Config["apns"]> => ({ teamId: "TEAM123456", keyId: "KEY1234567", topic: "test.agentinterface", privateKeyFile: "not-read-with-test-double", environment: "sandbox" });

it("uses single-use state and PKCE-bound native codes, hashed sessions, and retains browser write guards", async () => {
  const { app, store } = await setup();
  const started = await flow(app);
  expect(started.response.headers["cache-control"]).toBe("no-store");
  expect(started.response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  const complete = () => app.inject({ method: "POST", url: "/api/auth/native/complete", headers: { origin, cookie: started.cookie }, payload: { member: "one" } });
  const completed = await complete();
  const replayed = await complete();
  expect([replayed.statusCode, replayed.json().code]).toEqual([401, "session_expired"]);
  const callback = new URL(completed.json().callback);
  const payload = { code: callback.searchParams.get("code"), state: started.state, codeVerifier: started.codeVerifier };
  const exchange = (body: Record<string, unknown>, headers = {}) => app.inject({ method: "POST", url: "/api/auth/native/exchange", payload: body, headers });
  const wrongVerifier = await exchange({ ...payload, codeVerifier: randomBytes(32).toString("base64url") });
  expect([wrongVerifier.statusCode, wrongVerifier.json().code]).toEqual([401, "session_expired"]);
  expect((await exchange({ ...payload, state: randomBytes(32).toString("base64url") })).statusCode).toBe(401);
  expect((await exchange(payload, { origin })).statusCode).toBe(403);
  const result = await exchange(payload);
  expect(result.statusCode).toBe(200);
  expect((await exchange(payload)).statusCode).toBe(401);
  const token = result.json().token;
  expect(store.getNativeSession(hash(token))?.userId).toBe("local-one");
  expect(store.getNativeSession(token)).toBeUndefined();
  const headers = { authorization: `Bearer ${token}` };
  const preferences = (await app.inject({ url: "/api/bootstrap", headers })).json().preferences;
  expect((await app.inject({ method: "PATCH", url: "/api/preferences", headers, payload: preferences })).statusCode).toBe(200);
  expect((await app.inject({ method: "PATCH", url: "/api/preferences", headers: { ...headers, origin }, payload: preferences })).statusCode).toBe(403);
  expect((await app.inject({ method: "PATCH", url: "/api/preferences", headers: { origin }, payload: preferences })).statusCode).toBe(401);
  expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers })).statusCode).toBe(200);
  expect((await app.inject({ url: "/api/bootstrap", headers })).statusCode).toBe(401);
});

it("requires bridge cookie and same-origin action, rejects arbitrary callbacks, and expires handoffs", async () => {
  const { app, store } = await setup();
  const started = await flow(app);
  const options = { method: "POST" as const, url: "/api/auth/native/complete", payload: { member: "one" } };
  expect((await app.inject({ ...options, headers: { origin } })).statusCode).toBe(401);
  expect((await app.inject({ ...options, headers: { origin: "https://evil.test", cookie: started.cookie } })).statusCode).toBe(403);
  expect((await app.inject(`/native/sign-in?state=${started.state}&code_challenge=${randomBytes(32).toString("base64url")}&code_challenge_method=S256&redirect_uri=https://evil.test`)).statusCode).toBe(400);
  store.db.prepare("UPDATE native_flows SET expires=0").run();
  expect((await app.inject({ ...options, headers: { origin, cookie: started.cookie } })).statusCode).toBe(401);
  const second = await flow(app);
  const completed = await app.inject({ ...options, headers: { origin, cookie: second.cookie } });
  store.db.prepare("UPDATE native_codes SET expires=0").run();
  expect((await app.inject({ method: "POST", url: "/api/auth/native/exchange", payload: { code: new URL(completed.json().callback).searchParams.get("code"), state: second.state, codeVerifier: second.codeVerifier } })).statusCode).toBe(401);
});

it("verifies the Google flow nonce and rechecks the household on each native request", async () => {
  const config = loadConfig({ GOOGLE_CLIENT_ID: "google", HOUSEHOLD_EMAILS: "one@example.test", APP_DATABASE: ":memory:" });
  let nonce = "bad";
  const { app, store } = await setup(config, async () => ({ sub: "google-one", email: "one@example.test", email_verified: true, nonce }));
  const started = await flow(app);
  const complete = () => app.inject({ method: "POST", url: "/api/auth/native/complete", headers: { origin, cookie: started.cookie }, payload: { credential: "verified-test-token" } });
  expect((await complete()).statusCode).toBe(401);
  nonce = store.getNativeFlow(hash(started.cookieValue))!.nonce;
  const completed = await complete(); expect(completed.statusCode).toBe(200);
  const result = await app.inject({ method: "POST", url: "/api/auth/native/exchange", payload: { code: new URL(completed.json().callback).searchParams.get("code"), state: started.state, codeVerifier: started.codeVerifier } });
  const headers = { authorization: `Bearer ${result.json().token}` };
  expect((await app.inject({ url: "/api/bootstrap", headers })).statusCode).toBe(200);
  config.householdEmails = [];
  expect((await app.inject({ url: "/api/bootstrap", headers })).statusCode).toBe(401);
  expect(store.getNativeSession(hash(result.json().token))).toBeUndefined();
});

it("keeps device ownership explicit, controls APNs environment on the host, and unregisters on native logout", async () => {
  const config = loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }); config.apns = apnsConfig();
  const { app, store } = await setup(config);
  const one = await connectNative(app), two = await connectNative(app, "two");
  const deviceId = randomUUID(), token = "ab".repeat(32);
  const register = (bearer: string, extra = {}) => app.inject({ method: "PUT", url: "/api/native/push/device", headers: { authorization: `Bearer ${bearer}` }, payload: { deviceId, token, ...extra } });
  expect((await register(one.token, { environment: "production" })).statusCode).toBe(400);
  expect((await register(one.token)).statusCode).toBe(200);
  expect((await register(two.token)).statusCode).toBe(409);
  expect(store.nativeDevices("local-one", "sandbox")).toHaveLength(1);
  expect(store.nativeDevices("local-one", "production")).toHaveLength(0);
  await app.inject({ method: "DELETE", url: "/api/native/push/device", headers: { authorization: `Bearer ${two.token}` }, payload: { deviceId } });
  expect(store.nativeDevices("local-one", "sandbox")).toHaveLength(1);
  expect((await app.inject({ method: "POST", url: "/api/native/push/test", headers: { authorization: `Bearer ${one.token}` }, payload: { botId: "bot" } })).statusCode).toBe(200);
  expect(store.outbox().map(item => item.user_id)).toEqual(["local-one"]);
  await app.inject({ method: "POST", url: "/api/auth/logout", headers: { authorization: `Bearer ${one.token}` } });
  expect(store.nativeDevices("local-one", "sandbox")).toHaveLength(0);
  expect((await register(two.token)).statusCode).toBe(200);
});

it("registers one Live Activity token per device and owner, seeds just-sent assistants, and forgets it on logout", async () => {
  const config = loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:", IOS_APP_LATEST_BUILD: "7", IOS_APP_UPDATE_URL: "https://testflight.apple.com/join/TEST" });
  config.apns = apnsConfig();
  const { app, store, worker } = await setup(config);
  const one = await connectNative(app), two = await connectNative(app, "two");
  const deviceId = randomUUID(), token = "ab".repeat(32);
  const headers = (bearer: string) => ({ authorization: `Bearer ${bearer}` });
  const register = (bearer: string, extra = {}) => app.inject({ method: "PUT", url: "/api/native/live-activity", headers: headers(bearer), payload: { deviceId, token, ...extra } });
  expect((await app.inject({ url: "/api/bootstrap", headers: headers(one.token) })).json().nativeApp).toEqual({ latestBuild: 7, updateUrl: "https://testflight.apple.com/join/TEST" });
  expect((await register(one.token, { environment: "production" })).statusCode).toBe(400);
  expect((await register(one.token, { botIds: Array.from({ length: 11 }, (_, index) => `bot${index}`) })).statusCode).toBe(400);
  const registered = await register(one.token, { botIds: ["bot", "bot", "missing"] });
  expect(registered.statusCode).toBe(200);
  expect(registered.json()).toEqual({ ok: true });
  expect(await worker.live.state("local-one", store.liveActivities("sandbox")[0]))
    .toMatchObject({ title: "Bot is starting", activeCount: 1, rows: [{ botId: "bot", phase: "starting", status: "Starting" }] });
  expect(store.liveActivities("sandbox")).toMatchObject([{ userId: "local-one", armed: ["bot", "missing"] }]);
  expect((await register(two.token)).statusCode).toBe(409);
  const read = await app.inject({ url: "/api/native/live-activity", headers: headers(one.token) });
  expect(read.json()).toMatchObject({ available: true, state: { activeCount: 0, rows: [] } });
  const deviceRead = `/api/native/live-activity?deviceId=${deviceId}`;
  expect((await app.inject({ url: deviceRead, headers: headers(one.token) })).json())
    .toMatchObject({ state: { activeCount: 1, rows: [{ botId: "bot", phase: "starting" }] } });
  // A device ID does not let another account or another native session inherit its grace.
  expect((await app.inject({ url: deviceRead, headers: headers(two.token) })).json().state.rows).toEqual([]);
  const otherSession = await connectNative(app);
  expect((await app.inject({ url: deviceRead, headers: headers(otherSession.token) })).json().state.rows).toEqual([]);
  // A browser session has no device to show a Live Activity on.
  expect((await app.inject({ url: "/api/native/live-activity", headers: { cookie: "session=none" } })).statusCode).toBe(401);
  await app.inject({ method: "DELETE", url: "/api/native/live-activity", headers: headers(two.token), payload: { deviceId, token } });
  expect(store.liveActivities("sandbox")).toHaveLength(1);
  await app.inject({ method: "POST", url: "/api/auth/logout", headers: headers(one.token) });
  expect(store.liveActivities("sandbox")).toHaveLength(0);
  expect((await register(two.token)).statusCode).toBe(200);
  const replacement = "cd".repeat(32);
  expect((await register(two.token, { token: replacement })).statusCode).toBe(200);
  expect((await app.inject({ method: "DELETE", url: "/api/native/live-activity", headers: headers(two.token), payload: { deviceId } })).statusCode).toBe(400);
  await app.inject({ method: "DELETE", url: "/api/native/live-activity", headers: headers(two.token), payload: { deviceId, token } });
  expect(store.liveActivities("sandbox")).toMatchObject([{ token: replacement }]);
  expect((await app.inject({ method: "DELETE", url: "/api/native/live-activity", headers: headers(two.token), payload: { deviceId, token: replacement.toUpperCase() } })).statusCode).toBe(200);
  expect(store.liveActivities("sandbox")).toHaveLength(0);
});

it("reports absent APNs settings explicitly and rejects incomplete signing configuration", async () => {
  const { app } = await setup(); const { token } = await connectNative(app);
  const headers = { authorization: `Bearer ${token}` };
  expect((await app.inject({ url: "/api/native/push/config", headers })).json()).toEqual({ available: false });
  expect((await app.inject({ method: "PUT", url: "/api/native/push/device", headers, payload: { deviceId: randomUUID(), token: "ab".repeat(32) } })).statusCode).toBe(409);
  expect((await app.inject({ url: "/api/native/live-activity", headers })).json()).toMatchObject({ available: false, state: { rows: [] } });
  expect((await app.inject({ method: "PUT", url: "/api/native/live-activity", headers, payload: { deviceId: randomUUID(), token: "ab".repeat(32) } })).statusCode).toBe(409);
  expect(() => loadConfig({ APNS_KEY_ID: "KEY1234567" })).toThrow("All APNs");
  expect(() => loadConfig({ APNS_ENVIRONMENT: "sandbox" })).toThrow("signing settings");
});

it("authorizes native reads and downloads, rejects malformed bearer fallback, and expires sessions and registrations together", async () => {
  const config = loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }); config.apns = apnsConfig();
  const { app, store } = await setup(config);
  const { token } = await connectNative(app);
  const headers = { authorization: `Bearer ${token}` };
  expect((await app.inject({ url: "/api/bots", headers })).statusCode).toBe(200);
  expect((await app.inject({ url: "/api/files/answer.signature", headers })).body).toBe("file body");
  expect((await app.inject("/api/files/answer.signature")).statusCode).toBe(401);
  const web = await app.inject({ method: "POST", url: "/api/auth/local", headers: { origin }, payload: { member: "one" } });
  const cookie = `session=${web.cookies[0].value}`;
  expect((await app.inject({ url: "/api/bots", headers: { cookie, authorization: "Bearer malformed" } })).statusCode).toBe(401);
  expect((await app.inject({ method: "PUT", url: "/api/native/push/device", headers: { cookie, origin, "x-csrf-token": web.json().csrfToken }, payload: { deviceId: randomUUID(), token: "ab".repeat(32) } })).statusCode).toBe(403);
  store.registerNativeDevice("local-one", hash(token), randomUUID(), "ab".repeat(32), "sandbox");
  store.db.prepare("UPDATE native_sessions SET expires=0 WHERE hash=?").run(hash(token));
  expect((await app.inject({ url: "/api/bots", headers })).statusCode).toBe(401);
  expect(store.nativeDevices("local-one", "sandbox")).toHaveLength(0);
  expect((await app.inject({ url: "/api/bots", headers: { cookie } })).statusCode).toBe(200);
});

it("signs cached ES256 APNs provider requests and bounds multibyte payloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "apns-test-"));
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const config = { ...apnsConfig(), privateKeyFile: join(dir, "key.p8") };
  writeFileSync(config.privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const seen: { origin: string; headers: Record<string, string>; body: string }[] = [];
  const sender = createApnsSender(config, async (origin, headers, body) => { seen.push({ origin, headers, body }); return { statusCode: 200 }; })!;
  try {
    const device = { deviceId: randomUUID(), token: "ab".repeat(32), environment: "sandbox" as const };
    const payload = JSON.stringify({ title: "Done", body: "Hello", url: "/?bot=bot", tag: "event" });
    await sender(device, payload); await sender(device, payload);
    expect(seen[0].origin).toBe("https://api.sandbox.push.apple.com");
    expect(seen[0].headers["apns-topic"]).toBe("test.agentinterface");
    expect(seen[0].headers["apns-push-type"]).toBe("alert");
    expect(seen[0].headers.authorization).toBe(seen[1].headers.authorization);
    const jwt = seen[0].headers.authorization.slice(7).split(".");
    expect(JSON.parse(Buffer.from(jwt[0], "base64url").toString()).alg).toBe("ES256");
    expect(verify("sha256", Buffer.from(jwt.slice(0, 2).join(".")), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(jwt[2], "base64url"))).toBe(true);
    expect(JSON.parse(seen[0].body)).toMatchObject({ aps: { alert: { title: "Done" } }, url: "/?bot=bot" });
    await sender.clear(device, ["event"]);
    expect(seen[2].headers).toMatchObject({ "apns-topic": "test.agentinterface", "apns-push-type": "background", "apns-priority": "5" });
    expect(JSON.parse(seen[2].body)).toEqual({ aps: { "content-available": 1 }, clear: { tags: ["event"] } });
    const many = apnsClearPayload(Array.from({ length: 100 }, (_, index) => `${index}`.padEnd(150, "x")));
    expect(Buffer.byteLength(many)).toBeLessThanOrEqual(4000);
    expect(JSON.parse(many).clear.tags[0]).toBe("0".padEnd(150, "x"));
    const long = apnsPayload(JSON.stringify({ title: "😀".repeat(1000), body: "😀".repeat(1000), url: "😀".repeat(1000), tag: "😀".repeat(1000) }));
    expect(Buffer.byteLength(long)).toBeLessThan(4096);
    const escaped = apnsPayload(JSON.stringify({ title: "\u0000".repeat(1000), body: "\n\\\"".repeat(1000), url: "/?bot=" + "a".repeat(2300), tag: "\t".repeat(1000) }));
    expect(Buffer.byteLength(escaped)).toBeLessThan(4096);
    expect(JSON.parse(escaped).url).toBe("/?bot=" + "a".repeat(2300));
    expect(JSON.parse(long).url).toBeUndefined();
    await expect(sender({ ...device, environment: "production" }, payload)).rejects.toThrow("environment");
  } finally { sender.close(); rmSync(dir, { recursive: true }); }
});

it("reports Apple's refusal with its status and reason, which a route never forwards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "apns-test-"));
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const config = { ...apnsConfig(), privateKeyFile: join(dir, "key.p8") };
  writeFileSync(config.privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const sender = createApnsSender(config, async () => ({ statusCode: 400, reason: "BadDeviceToken" }))!;
  const device = { deviceId: randomUUID(), token: "ab".repeat(32), environment: "sandbox" as const };
  const app = Fastify();
  try {
    const refusal = await sender(device, JSON.stringify({ title: "Done", body: "Hello", url: "/?bot=bot", tag: "event" })).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ApnsError);
    expect(refusal).toMatchObject({ apnsStatus: 400, reason: "BadDeviceToken" });
    await expect(sender.clear(device, ["event"])).rejects.toMatchObject({ apnsStatus: 400, reason: "BadDeviceToken" });
    // Apple's 400 is not this app's: a route that let it escape answers as an unexplained failure.
    app.setErrorHandler(errorHandler({ production: true }));
    app.get("/escaped", async () => { throw refusal; });
    const response = await app.inject({ url: "/escaped" });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "The Hermes operation could not be completed" });
  } finally { await app.close(); sender.close(); rmSync(dir, { recursive: true }); }
});

it("shares durable participant/routine notifications across web/APNs without retry duplicates and removes invalid devices", async () => {
  const store = new Store(":memory:");
  const config = loadConfig({ HOUSEHOLD_EMAILS: "one@example.test,two@example.test" }); config.apns = apnsConfig();
  for (const userId of ["one", "two"]) {
    store.user({ id: userId, name: userId, email: `${userId}@example.test` });
    store.nativeSession(userId, userId, Date.now() + 100000);
    store.registerNativeDevice(userId, userId, userId, userId.repeat(32), "sandbox");
  }
  store.participate("run", "one");
  store.routineRecipients("routine", ["two"]);
  const event: RuntimeEvent = { id: "complete", botId: "bot", runId: "run", kind: "completed", title: "Done", occurredAt: "now" };
  store.recordEvents([event, { ...event, id: "routine", routineId: "routine" }], "cursor");
  store.subscribe("one", { endpoint: "https://push.test/one", keys: { p256dh: "key", auth: "auth" } });
  const web: string[] = [], native: string[] = [];
  const worker = new BackgroundWorker(store, runtime, config, async device => { web.push(device.endpoint); }, async device => {
    native.push(device.deviceId);
    if (device.deviceId === "one" && native.filter(value => value === "one").length === 1) throw new Error("Temporary outage");
    if (device.deviceId === "two") throw new ApnsError("Invalid device", 410);
  });
  try {
    await worker.tick(); expect(web).toHaveLength(1); expect(native).toEqual(["one", "two"]);
    expect(store.nativeDevices("two", "sandbox")).toHaveLength(0);
    store.db.prepare("UPDATE outbox SET next_attempt=0").run(); await worker.tick();
    expect(web).toHaveLength(1); expect(native).toEqual(["one", "two", "one"]); expect(store.outbox()).toHaveLength(0);
    store.recordEvents([{ ...event, id: "revoked" }], "cursor2"); config.householdEmails = [];
    await worker.tick(); expect(native).toHaveLength(3);
  } finally { await worker.stop(); store.close(); }
});

it("groups iOS notifications per assistant and adds actions only where they make sense", () => {
  const base = { title: "Kitchen", body: "Done", url: "/?bot=kitchen", tag: "event-1", botId: "kitchen", account: "0123456789abcdef" };
  const reply = JSON.parse(apnsPayload(JSON.stringify({ ...base, kind: "completed" })));
  expect(reply).toEqual({ aps: { alert: { title: "Kitchen", body: "Done" }, sound: "default", "thread-id": "kitchen", category: "REPLY" },
    url: "/?bot=kitchen", tag: "event-1", botId: "kitchen", account: "0123456789abcdef" });
  const approval = JSON.parse(apnsPayload(JSON.stringify({ ...base, kind: "approval", approvalId: "request-7" })));
  expect(approval.aps).toMatchObject({ "thread-id": "kitchen", category: "APPROVAL", "interruption-level": "time-sensitive" });
  expect(approval).toMatchObject({ botId: "kitchen", approvalId: "request-7", account: "0123456789abcdef" });
  // An add-on without approval IDs still sends a time-sensitive approval, which only opens the chat.
  const unnamed = JSON.parse(apnsPayload(JSON.stringify({ ...base, kind: "approval" })));
  expect([unnamed.aps.category, unnamed.aps["interruption-level"], unnamed.approvalId]).toEqual([undefined, "time-sensitive", undefined]);
  for (const kind of ["failed", "interrupted", "security", undefined]) {
    const value = JSON.parse(apnsPayload(JSON.stringify({ ...base, kind })));
    expect([value.aps.category, value.aps["interruption-level"], value.aps["thread-id"]]).toEqual([undefined, undefined, "kitchen"]);
  }
  // Routine results open their results sheet, not a chat to reply in; digests and host alerts have no assistant.
  expect(JSON.parse(apnsPayload(JSON.stringify({ ...base, kind: "completed", url: "/?bot=kitchen&routine=daily" }))).aps.category).toBeUndefined();
  const digest = JSON.parse(apnsPayload(JSON.stringify({ title: "2 assistant updates", body: "A · B", url: "/?view=today", tag: "batch", account: "0123456789abcdef" })));
  expect(digest.aps).toEqual({ alert: { title: "2 assistant updates", body: "A · B" }, sound: "default" });
  // Without the account marker an action could be taken by whoever is signed in, so there is none.
  expect(JSON.parse(apnsPayload(JSON.stringify({ ...base, account: undefined, kind: "completed" }))).aps.category).toBeUndefined();
  // An oversized ID is never truncated into a different assistant or approval; that notification just has no actions.
  const longId = JSON.parse(apnsPayload(JSON.stringify({ ...base, kind: "approval", approvalId: "a".repeat(300) })));
  expect([longId.aps.category, longId.approvalId]).toEqual([undefined, undefined]);
  // Full-size alerts keep their text and link; the extras go first, never the alert itself.
  const huge = { title: "\u0000".repeat(1000), body: "\n\\\"".repeat(1000), url: "/?bot=" + "a".repeat(2300), tag: "\t".repeat(1000), kind: "approval", botId: "b".repeat(200), approvalId: "c".repeat(200), account: "0123456789abcdef" };
  const fitted = apnsPayload(JSON.stringify(huge));
  expect(Buffer.byteLength(fitted)).toBeLessThanOrEqual(4000);
  expect(JSON.parse(fitted)).toMatchObject({ url: huge.url, aps: { "interruption-level": "time-sensitive" } });
  expect(JSON.parse(fitted).aps.category).toBeUndefined();
  const roomy = JSON.parse(apnsPayload(JSON.stringify({ ...huge, url: "/?bot=" + "b".repeat(200) })));
  expect([roomy.aps.category, roomy.approvalId]).toEqual(["APPROVAL", "c".repeat(200)]);
});

it("derives an APNs collapse ID from the tag within Apple's 64 bytes", async () => {
  expect(apnsCollapseId("6f1c2b1e-9d4a-4c3e-8f1a-2b3c4d5e6f70")).toBe("6f1c2b1e-9d4a-4c3e-8f1a-2b3c4d5e6f70");
  expect(apnsCollapseId("x".repeat(64))).toBe("x".repeat(64));
  for (const tag of ["x".repeat(65), "😀".repeat(20), "with space", "line\nbreak"]) {
    const id = apnsCollapseId(tag);
    expect(Buffer.byteLength(id)).toBeLessThanOrEqual(64);
    expect(id).toMatch(/^[\x21-\x7e]+$/);
    expect(apnsCollapseId(tag)).toBe(id);
  }
  expect(apnsCollapseId("x".repeat(65))).not.toBe(apnsCollapseId("x".repeat(66)));
  const dir = mkdtempSync(join(tmpdir(), "apns-collapse-"));
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const config = { ...apnsConfig(), privateKeyFile: join(dir, "key.p8") };
  writeFileSync(config.privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const seen: Record<string, string>[] = [];
  const sender = createApnsSender(config, async (_origin, headers) => { seen.push(headers); return { statusCode: 200 }; })!;
  try {
    const device = { deviceId: randomUUID(), token: "ab".repeat(32), environment: "sandbox" as const };
    await sender(device, JSON.stringify({ title: "Done", body: "Hello", url: "/?bot=bot", tag: "event" }));
    await sender(device, JSON.stringify({ title: "Done", body: "Hello", url: "/?bot=bot", tag: "t".repeat(200) }));
    await sender.clear(device, ["event"]);
    expect(seen.map(headers => headers["apns-collapse-id"])).toEqual(["event", apnsCollapseId("t".repeat(200)), undefined]);
  } finally { sender.close(); rmSync(dir, { recursive: true }); }
});

it("names the recipient account and the approval on iOS only, keeping Web Push as before", async () => {
  const store = new Store(":memory:");
  const config = loadConfig({ HOUSEHOLD_EMAILS: "one@example.test" }); config.apns = apnsConfig();
  store.user({ id: "one", name: "one", email: "one@example.test" });
  store.nativeSession("one", "one", Date.now() + 100000);
  store.registerNativeDevice("one", "one", "one", "ab".repeat(32), "sandbox");
  store.subscribe("one", { endpoint: "https://push.test/one", keys: { p256dh: "key", auth: "auth" } });
  store.savePreferences("one", { ...defaultPreferences, followBots: ["kitchen"] });
  store.recordEvents([{ id: "ask", botId: "kitchen", runId: "run", kind: "approval", approvalId: "request-7", title: "Approval requested", occurredAt: "now" },
    { id: "done", botId: "kitchen", runId: "run", kind: "completed", title: "Done", occurredAt: "now" }], "cursor");
  const web: Record<string, unknown>[] = [], native: Record<string, unknown>[] = [];
  const worker = new BackgroundWorker(store, runtime, config, async (_subscription, payload) => { web.push(JSON.parse(payload)); },
    async (_device, payload) => { native.push(JSON.parse(apnsPayload(payload))); });
  await worker.tick();
  expect(web.map(row => [row.tag, row.approvalId, row.account])).toEqual([["ask", "request-7", undefined], ["done", undefined, undefined]]);
  expect(native.map(row => [row.tag, (row.aps as { category?: string }).category, row.approvalId, row.account])).toEqual([
    ["ask", "APPROVAL", "request-7", accountMarker("one")], ["done", "REPLY", undefined, accountMarker("one")]]);
  expect(accountMarker("one")).toMatch(/^[0-9a-f]{16}$/);
  expect(accountMarker("one")).not.toBe(accountMarker("two"));
  store.close();
});

it("sends a private assistant's news only to its owner on web and APNs, even after quiet hours", async () => {
  const store = new Store(":memory:");
  const config = loadConfig({ HOUSEHOLD_EMAILS: "one@example.test,two@example.test" }); config.apns = apnsConfig();
  for (const userId of ["one", "two"]) {
    store.user({ id: userId, name: userId, email: `${userId}@example.test` });
    store.nativeSession(userId, userId, Date.now() + 100000);
    store.registerNativeDevice(userId, userId, userId, userId.repeat(32), "sandbox");
    store.subscribe(userId, { endpoint: `https://push.test/${userId}`, keys: { p256dh: "key", auth: "auth" } });
    store.savePreferences(userId, { ...defaultPreferences, followBots: ["mine"] });
  }
  // Two joined the run, receives the routine and follows the assistant; none of that reaches past its privacy.
  store.participate("run", "two");
  store.routineRecipients("routine", ["two"]);
  store.savePresentation("mine", { shared: false, ownerId: "one" });
  const event: RuntimeEvent = { id: "run-done", botId: "mine", runId: "run", kind: "completed", title: "Done", occurredAt: "now" };
  store.recordEvents([event, { ...event, id: "routine-done", routineId: "routine" }], "cursor");
  expect(store.outbox().map(row => row.user_id)).toEqual(["one", "one"]);
  // Queued for two while shared and held by quiet hours, then made private before it could go out.
  const hour = new Date().getUTCHours(), at = (offset: number) => `${String((hour + offset + 24) % 24).padStart(2, "0")}:00`;
  store.savePreferences("two", { ...defaultPreferences, notifications: { timezone: "UTC", quietStart: at(-1), quietEnd: at(1), batchMinutes: 0 } });
  store.savePresentation("family", { shared: true });
  store.recordEvents([{ ...event, id: "family-done", botId: "family" }], "cursor-2");
  const sent: string[] = [];
  const worker = new BackgroundWorker(store, runtime, config, async (subscription, payload) => { sent.push(`${subscription.endpoint} ${JSON.parse(payload).tag}`); },
    async (device, payload) => { sent.push(`apns:${device.deviceId} ${JSON.parse(payload).tag}`); });
  await worker.tick();
  expect(sent.filter(row => row.includes("two"))).toEqual([]);
  store.savePresentation("family", { shared: false, ownerId: "one" });
  store.savePreferences("two", defaultPreferences);
  await worker.tick();
  expect(sent.sort()).toEqual(["apns:one routine-done", "apns:one run-done", "https://push.test/one routine-done", "https://push.test/one run-done"]);
  expect(store.outbox()).toHaveLength(0);
  store.close();
});

it("stops a delivery mid-way when its assistant turns private, before any other endpoint gets it", async () => {
  const store = new Store(":memory:");
  const config = loadConfig({ HOUSEHOLD_EMAILS: "one@example.test,two@example.test" }); config.apns = apnsConfig();
  for (const userId of ["one", "two"]) store.user({ id: userId, name: userId, email: `${userId}@example.test` });
  store.nativeSession("two", "two", Date.now() + 100000);
  store.registerNativeDevice("two", "two", "two", "two".repeat(32), "sandbox");
  for (const device of ["phone", "laptop"]) store.subscribe("two", { endpoint: `https://push.test/${device}`, keys: { p256dh: "key", auth: "auth" } });
  store.savePresentation("family", { shared: true });
  store.participate("run", "two");
  store.recordEvents([{ id: "done", botId: "family", runId: "run", kind: "completed", title: "Private details", occurredAt: "now" }], "cursor");
  const sent: string[] = [];
  const worker = new BackgroundWorker(store, runtime, config, async subscription => {
    sent.push(subscription.endpoint);
    // The owner makes it private while this first send is in flight.
    store.savePresentation("family", { shared: false, ownerId: "one" });
  }, async device => { sent.push(device.deviceId); });
  await worker.tick();
  await worker.tick();
  expect(sent).toEqual(["https://push.test/phone"]);
  expect(store.outbox()).toHaveLength(0);
  store.close();
});
