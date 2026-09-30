import { createHash, randomBytes, randomUUID, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { loadConfig, type Config } from "../src/server/config.js";
import { createApnsSender, apnsPayload } from "../src/server/apns.js";
import { BackgroundWorker } from "../src/server/notifications.js";
import { Store } from "../src/server/store.js";
import type { Runtime, RuntimeEvent } from "../src/shared/types.js";

const origin = "http://127.0.0.1:3000";
const runtime = { status: async () => ({ connected: false }), listBots: async () => [{ id: "bot", name: "Bot", shared: true, model: "test", activity: "idle" }], capabilities: async () => ({ avatarMetadata: { supported: false }, generatedFiles: { supported: true }, idempotency: { supported: false }, durableEvents: { supported: false } }), download: async () => ({ data: Buffer.from("file body"), name: "answer.txt", mime: "text/plain" }), close: async () => {} } as unknown as Runtime;
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
  expect((await complete()).statusCode).toBe(401);
  const callback = new URL(completed.json().callback);
  const payload = { code: callback.searchParams.get("code"), state: started.state, codeVerifier: started.codeVerifier };
  const exchange = (body: Record<string, unknown>, headers = {}) => app.inject({ method: "POST", url: "/api/auth/native/exchange", payload: body, headers });
  expect((await exchange({ ...payload, codeVerifier: randomBytes(32).toString("base64url") })).statusCode).toBe(401);
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

it("reports absent APNs settings explicitly and rejects incomplete signing configuration", async () => {
  const { app } = await setup(); const { token } = await connectNative(app);
  const headers = { authorization: `Bearer ${token}` };
  expect((await app.inject({ url: "/api/native/push/config", headers })).json()).toEqual({ available: false });
  expect((await app.inject({ method: "PUT", url: "/api/native/push/device", headers, payload: { deviceId: randomUUID(), token: "ab".repeat(32) } })).statusCode).toBe(409);
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
    const long = apnsPayload(JSON.stringify({ title: "😀".repeat(1000), body: "😀".repeat(1000), url: "😀".repeat(1000), tag: "😀".repeat(1000) }));
    expect(Buffer.byteLength(long)).toBeLessThan(4096);
    const escaped = apnsPayload(JSON.stringify({ title: "\u0000".repeat(1000), body: "\n\\\"".repeat(1000), url: "/?bot=" + "a".repeat(2300), tag: "\t".repeat(1000) }));
    expect(Buffer.byteLength(escaped)).toBeLessThan(4096);
    expect(JSON.parse(escaped).url).toBe("/?bot=" + "a".repeat(2300));
    expect(JSON.parse(long).url).toBeUndefined();
    await expect(sender({ ...device, environment: "production" }, payload)).rejects.toThrow("environment");
  } finally { sender.close(); rmSync(dir, { recursive: true }); }
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
    if (device.deviceId === "two") throw Object.assign(new Error("Invalid device"), { statusCode: 410 });
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
