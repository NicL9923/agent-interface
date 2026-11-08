import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import webpush from "web-push";
import { ApnsError } from "../src/server/apns.js";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { loadConfig, type Config } from "../src/server/config.js";
import { BackgroundWorker } from "../src/server/notifications.js";
import { Store } from "../src/server/store.js";
import { deviceBeatTtl, deviceIdleMs } from "../src/shared/device-activity.js";
import type { RuntimeEvent } from "../src/shared/types.js";
import { botFixture, capabilitiesFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime, signIn } from "./helpers/server.js";

// Device activity routes notifications to the installation a person is using. These tests run the
// real app and worker with the in-memory store; only the push senders, the I/O edge, are doubles.
const origin = "https://app.example.invalid";
const laptop = "0d8a5f0e-1b2c-4d3e-8f90-a1b2c3d4e5f6", phone = "7c6b5a49-3827-4615-a4b3-c2d1e0f9a8b7", tablet = "11111111-2222-4333-8444-555555555555";
const T = Date.parse("2026-11-07T18:00:00Z");
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T); });
afterEach(() => { vi.useRealTimers(); });

const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function app() {
  const keys = webpush.generateVAPIDKeys();
  const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: origin, APP_DATABASE: ":memory:",
    GOOGLE_CLIENT_ID: "fixture-client", HOUSEHOLD_EMAILS: "one@example.invalid,two@example.invalid",
    VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: "mailto:one@example.invalid" });
  const result = await createApp(config, fakeRuntime({ close: async () => {} }), { background: false });
  apps.push(result.app);
  return result;
}
/** Bearer headers for a native session written straight to the store, as the iOS app would send. */
function nativeSignIn(store: Store, id: string) {
  store.user({ id, name: id, email: `${id}@example.invalid` });
  const token = randomBytes(32).toString("base64url");
  store.nativeSession(hash(token), id, Date.now() + 600_000);
  return { authorization: `Bearer ${token}` };
}
const beat = (body: object) => ({ method: "PUT" as const, url: "/api/devices/activity", payload: body });

it("rejects malformed activity reports and names the field that failed", async () => {
  const { app: server, store } = await app();
  const one = signIn(store, origin, "one");
  expect((await server.inject(beat({ deviceId: laptop, state: "active" }))).statusCode).toBe(401);
  const cases: [object, string][] = [
    [{ deviceId: "laptop", state: "active" }, "deviceId"],
    [{ state: "active" }, "deviceId"],
    [{ deviceId: laptop, state: "busy" }, "state"],
    [{ deviceId: laptop, state: "active", idleMs: deviceIdleMs }, "idleMs"],
    [{ deviceId: laptop, state: "active", idleMs: -1 }, "idleMs"],
    [{ deviceId: laptop, state: "active", idleMs: 1.5 }, "idleMs"],
    [{ deviceId: laptop, state: "active", userId: "two" }, ""],
  ];
  for (const [body, field] of cases) {
    const response = await server.inject({ ...beat(body), headers: one });
    expect(response.statusCode, JSON.stringify(body)).toBe(400);
    const details = response.json().details as { path: string[] }[];
    // An unknown key is refused as a whole; every other case names its field.
    expect(details.some(detail => (detail.path[0] ?? "") === field), JSON.stringify(details)).toBe(true);
  }
  expect(store.activeDevices("one").size).toBe(0);
  // The last millisecond before idle is still in use.
  expect((await server.inject({ ...beat({ deviceId: laptop, state: "active", idleMs: deviceIdleMs - 1 }), headers: one })).statusCode).toBe(200);
  expect([...store.activeDevices("one")]).toEqual([laptop]);
});

it("keeps a browser in use under its session, folds the ID to lowercase, and ends it at sign-out", async () => {
  const { app: server, store } = await app();
  const one = signIn(store, origin, "one");
  expect((await server.inject({ ...beat({ deviceId: laptop.toUpperCase(), state: "active" }), headers: one })).json()).toEqual({ ok: true });
  expect([...store.activeDevices("one")]).toEqual([laptop]);
  expect(store.activeDevices("two").size).toBe(0);
  // Inactive ends only the device that says so.
  store.deviceActivity("one", "other-session", tablet, "web", "active");
  expect((await server.inject({ ...beat({ deviceId: tablet, state: "inactive" }), headers: one })).statusCode).toBe(200);
  expect([...store.activeDevices("one")]).toEqual([laptop]);
  // Another session's device outlives this sign-out.
  store.deviceActivity("one", "other-session", phone, "web", "active");
  expect((await server.inject({ method: "POST", url: "/api/auth/logout", headers: one })).statusCode).toBe(200);
  expect(store.activeDevices("one").has(laptop)).toBe(false);
  // Signing out removes its row at once rather than leaving it for retention.
  expect(store.db.prepare("SELECT 1 FROM device_activity WHERE device_id=?").get(laptop)).toBeUndefined();
  expect(store.db.prepare("SELECT 1 FROM device_activity WHERE device_id=?").get(phone)).toBeDefined();
});

it("refuses another member's reports for a device until its account signs out there, then hands it over", async () => {
  const { app: server, store } = await app();
  const one = nativeSignIn(store, "one"), two = nativeSignIn(store, "two");
  expect((await server.inject({ ...beat({ deviceId: phone, state: "active" }), headers: one })).statusCode).toBe(200);
  expect(store.db.prepare("SELECT platform FROM device_activity WHERE device_id=?").get(phone)).toEqual({ platform: "ios" });
  // Member two names member one's device while one is still signed in there.
  const taken = await server.inject({ ...beat({ deviceId: phone, state: "active" }), headers: two });
  expect([taken.statusCode, taken.json().error]).toEqual([409, "This device is signed in to another household member. Sign out there first."]);
  expect([...store.activeDevices("one")]).toEqual([phone]);
  expect(store.activeDevices("two").size).toBe(0);
  // An inactive report from two changes nothing either.
  expect((await server.inject({ ...beat({ deviceId: phone, state: "inactive" }), headers: two })).statusCode).toBe(200);
  expect([...store.activeDevices("one")]).toEqual([phone]);
  // Stopping keeps the device one's while one stays signed in.
  expect((await server.inject({ ...beat({ deviceId: phone, state: "inactive" }), headers: one })).statusCode).toBe(200);
  expect(store.activeDevices("one").size).toBe(0);
  expect((await server.inject({ ...beat({ deviceId: phone, state: "active" }), headers: two })).statusCode).toBe(409);
  // Signing out there hands it over, as switching accounts on the device does.
  expect((await server.inject({ method: "POST", url: "/api/auth/logout", headers: one })).statusCode).toBe(200);
  expect((await server.inject({ ...beat({ deviceId: phone, state: "active" }), headers: two })).statusCode).toBe(200);
  expect([...store.activeDevices("two")]).toEqual([phone]);
});

it("refuses a device another member registered for push, and frees one whose session expired", async () => {
  const { app: server, store } = await app();
  const one = signIn(store, origin, "one"), two = nativeSignIn(store, "two");
  // Member one's iPhone, registered for push under one's native session.
  store.nativeSession("one-phone", "one", Date.now() + 600_000);
  store.registerNativeDevice("one", "one-phone", phone, "ab".repeat(32), "sandbox");
  expect((await server.inject({ ...beat({ deviceId: phone, state: "active" }), headers: two })).statusCode).toBe(409);
  // Member one's browser, labelled on its push subscription.
  store.subscribe("one", { endpoint: "https://push.example.invalid/one", keys: { p256dh: "key", auth: "auth" } }, laptop);
  const labelled = await server.inject({ ...beat({ deviceId: laptop, state: "active" }), headers: two });
  expect([labelled.statusCode, labelled.json().error]).toEqual([409, "This device is signed in to another household member. Sign out there first."]);
  // A device whose holder's session expired is free to take.
  expect((await server.inject({ ...beat({ deviceId: tablet, state: "active" }), headers: one })).statusCode).toBe(200);
  store.db.prepare("UPDATE sessions SET expires=0 WHERE user_id='one'").run();
  expect((await server.inject({ ...beat({ deviceId: tablet, state: "active" }), headers: two })).statusCode).toBe(200);
  expect([...store.activeDevices("two")]).toEqual([tablet]);
});

it("counts a device as in use until five minutes after its last input and 45 seconds after its last beat", () => {
  const store = new Store(":memory:");
  try {
    store.user({ id: "one", name: "one", email: "one@example.test" });
    store.session("web-session", "one", "csrf", T + 3600_000);
    // Input at T, then a beat 290 seconds later reporting that idle time.
    store.deviceActivity("one", "web-session", laptop, "web", "active", 290_000, T + 290_000);
    expect(store.activeDevices("one", T + deviceIdleMs - 1).has(laptop)).toBe(true);
    expect(store.activeDevices("one", T + deviceIdleMs).has(laptop)).toBe(false);
    // Fresh input, then the beats stop.
    store.deviceActivity("one", "web-session", laptop, "web", "active", 0, T + 400_000);
    expect(store.activeDevices("one", T + 400_000 + deviceBeatTtl - 1).has(laptop)).toBe(true);
    expect(store.activeDevices("one", T + 400_000 + deviceBeatTtl).has(laptop)).toBe(false);
    // A session that expired or was removed no longer counts, whatever its beats said.
    store.deviceActivity("one", "web-session", laptop, "web", "active", 0, T);
    expect(store.activeDevices("one", T).has(laptop)).toBe(true);
    // Retention keeps a row its session still holds, however old its beat, and drops it once the session is gone.
    store.session("web-session-2", "one", "csrf", T + 3600_000);
    store.deviceActivity("one", "web-session-2", laptop, "web", "active", 0, T);
    store.deviceActivity("one", "web-session-2", laptop, "web", "inactive", 0, T);
    store.pruneRetention(T + 3_000_000);
    expect(store.db.prepare("SELECT count(*) AS n FROM device_activity").get()).toEqual({ n: 1 });
    store.db.prepare("UPDATE sessions SET expires=? WHERE hash='web-session-2'").run(T + 3_000_001);
    store.pruneRetention(T + 3_000_002);
    expect(store.db.prepare("SELECT count(*) AS n FROM device_activity").get()).toEqual({ n: 0 });
  } finally { store.close(); }
});

it("attaches a device only to the caller's own subscription, and forgets it when a client registers without one", async () => {
  const { app: server, store } = await app();
  const one = signIn(store, origin, "one"), two = signIn(store, origin, "two");
  const endpoint = "https://push.example.invalid/one", keys = { p256dh: "key", auth: "auth" };
  expect((await server.inject({ method: "POST", url: "/api/push/subscriptions", headers: one, payload: { endpoint, keys, deviceId: "nope" } })).statusCode).toBe(400);
  expect((await server.inject({ method: "POST", url: "/api/push/subscriptions", headers: one, payload: { endpoint, keys } })).statusCode).toBe(200);
  expect(store.subscriptionDevices("one").size).toBe(0);
  // Checking status names this browser's installation, for subscriptions made before device IDs.
  expect((await server.inject({ method: "POST", url: "/api/push/subscriptions/status", headers: one, payload: { endpoint, deviceId: laptop } })).json()).toEqual({ registered: true });
  expect(store.subscriptionDevices("one").get(endpoint)).toBe(laptop);
  // Another member cannot relabel it.
  expect((await server.inject({ method: "POST", url: "/api/push/subscriptions/status", headers: two, payload: { endpoint, deviceId: tablet } })).json()).toEqual({ registered: false });
  expect(store.subscriptionDevices("one").get(endpoint)).toBe(laptop);
  // An older client re-registering without an ID leaves it unlabelled rather than stale.
  expect((await server.inject({ method: "POST", url: "/api/push/subscriptions", headers: one, payload: { endpoint, keys } })).statusCode).toBe(200);
  expect(store.subscriptionDevices("one").size).toBe(0);
  expect((await server.inject({ method: "POST", url: "/api/push/subscriptions", headers: one, payload: { endpoint, keys, deviceId: laptop } })).statusCode).toBe(200);
  expect(store.subscriptionDevices("one").get(endpoint)).toBe(laptop);
  // The store refuses a label for someone else's endpoint even without the route's check.
  store.attachSubscriptionDevice("two", endpoint, tablet);
  expect(store.subscriptionDevices("one").get(endpoint)).toBe(laptop);
  expect((await server.inject({ method: "DELETE", url: "/api/push/subscriptions", headers: one, payload: { endpoint } })).statusCode).toBe(200);
  expect(store.db.prepare("SELECT count(*) AS n FROM push_subscription_devices").get()).toEqual({ n: 0 });
});

// Delivery routing. Person "one" has a browser on the laptop and an iPhone.
const apns = (): NonNullable<Config["apns"]> => ({ teamId: "TEAM123456", keyId: "KEY1234567", topic: "test.agentinterface", privateKeyFile: "unused", environment: "sandbox" });
const web = "https://push.test/laptop";
const reply = (id: string, extra: Partial<RuntimeEvent> = {}): RuntimeEvent =>
  ({ id, botId: "shared", runId: "run", kind: "completed", title: "Done", occurredAt: new Date(Date.now() - 1000).toISOString(), ...extra });
function household(options: { webDevice?: string | null } = {}) {
  const store = new Store(":memory:");
  const config = loadConfig({ HOUSEHOLD_EMAILS: "one@example.test,two@example.test" });
  config.apns = apns();
  for (const id of ["one", "two"]) store.user({ id, name: id, email: `${id}@example.test` });
  store.participate("run", "one");
  store.session("web-session", "one", "csrf", Date.now() + 3600_000);
  store.nativeSession("phone-session", "one", Date.now() + 3600_000);
  store.subscribe("one", { endpoint: web, keys: { p256dh: "key", auth: "auth" } }, options.webDevice === null ? undefined : options.webDevice ?? laptop);
  store.registerNativeDevice("one", "phone-session", phone, "ab".repeat(32), "sandbox");
  // Read once before, so a new reply counts on the badge.
  store.chatPresence("one", "shared", "earlier", "left", Date.now() - 60_000);
  const sent = { web: [] as string[], native: [] as string[], badges: [] as { device: string; badge: number }[], clears: [] as { device: string; tags: string[] }[] };
  const fail = { web: undefined as unknown, native: undefined as unknown, badge: undefined as unknown };
  const runtime = fakeRuntime({
    capabilities: async () => capabilitiesFixture({ idempotency: { supported: false }, durableEvents: { supported: false } }),
    listBots: async () => [botFixture({ lastMessage: { text: "Done", at: new Date().toISOString() } })],
  });
  const worker = new BackgroundWorker(store, runtime, config,
    async subscription => { if (fail.web) throw fail.web; sent.web.push(subscription.endpoint); },
    async (device, payload) => { if (fail.native) throw fail.native; sent.native.push(`${device.deviceId}:${JSON.parse(payload).tag}`); },
    undefined, undefined,
    async (device, tags) => { sent.clears.push({ device: device.deviceId, tags }); },
    undefined,
    async (device, badge) => { if (fail.badge) throw fail.badge; sent.badges.push({ device: device.deviceId, badge }); });
  const use = (deviceId: string, session = deviceId === phone ? "phone-session" : "web-session") =>
    store.deviceActivity("one", session, deviceId, deviceId === phone ? "ios" : "web", "active");
  return { store, worker, sent, fail, use };
}
const endpoints = (store: Store, id: string) => (store.db.prepare("SELECT endpoint FROM delivered WHERE outbox_id=(SELECT id FROM outbox WHERE event_id=?) ORDER BY endpoint").all(id) as { endpoint: string }[]).map(row => row.endpoint);

it("alerts only the device in use and sets the badge on the others", async () => {
  const { store, worker, sent, use } = household();
  try {
    use(laptop);
    store.recordEvents([reply("routed")], "cursor");
    await worker.tick();
    expect(sent.web).toEqual([web]);
    expect(sent.native).toEqual([]);
    expect(sent.badges).toEqual([{ device: phone, badge: 1 }]);
    expect(endpoints(store, "routed")).toEqual([web, `skipped:apns:sandbox:${"ab".repeat(32)}`]);
    expect(store.outbox()).toHaveLength(0);
    // Reading it on the laptop lowers the quiet phone's badge, with nothing there to clear.
    store.chatPresence("one", "shared", "laptop-tab", "left");
    await worker.tick();
    expect(sent.clears).toEqual([]);
    expect(sent.badges).toEqual([{ device: phone, badge: 1 }, { device: phone, badge: 0 }]);
    await worker.tick();
    expect(sent.badges).toHaveLength(2);
  } finally { await worker.stop(); store.close(); }
});

it("alerts every device in use when there are two, and every device when none is in use", async () => {
  const { store, worker, sent, use } = household();
  try {
    use(laptop); use(phone);
    store.recordEvents([reply("both")], "cursor");
    await worker.tick();
    expect([sent.web, sent.native, sent.badges]).toEqual([[web], [`${phone}:both`], []]);
    // Five minutes without input on both: back to every device.
    store.deviceActivity("one", "web-session", laptop, "web", "active", deviceIdleMs - 1, Date.now() - 1);
    store.deviceActivity("one", "phone-session", phone, "ios", "inactive");
    store.recordEvents([reply("nobody")], "cursor");
    await worker.tick();
    expect([sent.web, sent.native, sent.badges]).toEqual([[web, web], [`${phone}:both`, `${phone}:nobody`], []]);
  } finally { await worker.stop(); store.close(); }
});

it("falls back to every device when the device in use has a dead subscription", async () => {
  const { store, worker, sent, fail, use } = household();
  try {
    use(laptop);
    fail.web = Object.assign(new Error("Gone"), { statusCode: 410 });
    store.recordEvents([reply("dead")], "cursor");
    await worker.tick();
    expect(sent.native).toEqual([`${phone}:dead`]);
    expect(sent.badges).toEqual([]);
    expect(store.subscriptions("one")).toEqual([]);
    // The dead endpoint is recorded apart, never as shown.
    expect(endpoints(store, "dead")).toEqual([`apns:sandbox:${"ab".repeat(32)}`, `dead:${web}`]);
    expect(store.outbox()).toHaveLength(0);
  } finally { await worker.stop(); store.close(); }
});

it("falls back on a passing failure on the device in use, then retries only that device", async () => {
  const { store, worker, sent, fail, use } = household();
  try {
    use(laptop);
    fail.web = Object.assign(new Error("Busy"), { statusCode: 503 });
    store.recordEvents([reply("flaky")], "cursor");
    await worker.tick();
    expect([sent.web, sent.native]).toEqual([[], [`${phone}:flaky`]]);
    expect(store.db.prepare("SELECT state FROM outbox").get()).toEqual({ state: "pending" });
    fail.web = undefined;
    store.db.prepare("UPDATE outbox SET next_attempt=0").run();
    await worker.tick();
    expect([sent.web, sent.native, sent.badges]).toEqual([[web], [`${phone}:flaky`], []]);
    expect(store.outbox()).toHaveLength(0);
  } finally { await worker.stop(); store.close(); }
});

it("treats a subscription from a client without a device ID as never in use", async () => {
  const { store, worker, sent, use } = household({ webDevice: null });
  try {
    // The browser beats, but its subscription never named the installation: nothing is routed.
    use(laptop);
    store.recordEvents([reply("old-client")], "cursor");
    await worker.tick();
    expect([sent.web, sent.native, sent.badges]).toEqual([[web], [`${phone}:old-client`], []]);
  } finally { await worker.stop(); store.close(); }
});

it("sends security alerts to every device even while one is in use", async () => {
  const { store, worker, sent, use } = household();
  try {
    use(laptop);
    store.queueNotification("security-event", "one", { title: "New sign-in", body: "Check it", url: "/", tag: "security-event", kind: "security" });
    await worker.tick();
    expect([sent.web, sent.native, sent.badges]).toEqual([[web], [`${phone}:security-event`], []]);
  } finally { await worker.stop(); store.close(); }
});

it("returns to every device when the device in use signs out", async () => {
  const { store, worker, sent, use } = household();
  try {
    use(phone);
    store.deleteNativeSession("phone-session");
    store.recordEvents([reply("signed-out")], "cursor");
    await worker.tick();
    // The phone's registration went with its session; the browser gets the alert.
    expect([sent.web, sent.native, sent.badges]).toEqual([[web], [], []]);
  } finally { await worker.stop(); store.close(); }
});

it("never retries a quiet device's badge, but drops a token Apple says is dead", async () => {
  const { store, worker, sent, fail, use } = household();
  try {
    use(laptop);
    fail.badge = new Error("Network down");
    store.recordEvents([reply("badge-fails")], "cursor");
    await worker.tick();
    expect(sent.web).toEqual([web]);
    expect(store.outbox()).toHaveLength(0);
    expect(store.nativeDevices("one", "sandbox")).toHaveLength(1);
    fail.badge = new ApnsError("APNs rejected badge update (410)", 410, "Unregistered");
    store.recordEvents([reply("badge-dead")], "cursor");
    await worker.tick();
    expect(store.nativeDevices("one", "sandbox")).toEqual([]);
    expect(sent.badges).toEqual([]);
  } finally { await worker.stop(); store.close(); }
});

it("sends a quiet device's badge as a priority-5 alert push holding only the badge", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApnsSender } = await import("../src/server/apns.js");
  const directory = mkdtempSync(join(tmpdir(), "apns-badge-")), keyFile = join(directory, "key.p8");
  writeFileSync(keyFile, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const requests: { headers: Record<string, string>; body: string }[] = [];
  let status = 200;
  const sender = createApnsSender({ ...apns(), privateKeyFile: keyFile }, async (_origin, headers, body) => { requests.push({ headers, body }); return { statusCode: status, reason: status === 200 ? undefined : "Unregistered" }; })!;
  const device = { deviceId: phone, token: "ab".repeat(32), environment: "sandbox" as const };
  try {
    await sender.badge(device, 3);
    expect(requests[0].headers).toMatchObject({ "apns-push-type": "alert", "apns-priority": "5", ":path": `/3/device/${"ab".repeat(32)}` });
    expect(JSON.parse(requests[0].body)).toEqual({ aps: { badge: 3 } });
    // A count that is not a whole number never reaches Apple.
    await expect(sender.badge(device, -1)).rejects.toThrow("whole number");
    await expect(sender.badge({ ...device, environment: "production" }, 1)).rejects.toThrow("environment");
    expect(requests).toHaveLength(1);
    status = 410;
    await expect(sender.badge(device, 1)).rejects.toMatchObject({ apnsStatus: 410, reason: "Unregistered" });
  } finally { sender.close(); rmSync(directory, { recursive: true }); }
});

it("drops a Safari subscription Apple calls a bad token, but keeps one after any other 400", async () => {
  const { store, worker, sent, fail, use } = household();
  try {
    use(laptop);
    // The body Apple's Web Push service sent for an unknown token, measured 2026-11-07.
    fail.web = Object.assign(new Error("Received unexpected response code"), { statusCode: 400, body: '{"reason":"BadDeviceToken"}' });
    store.recordEvents([reply("apple-dead")], "cursor");
    await worker.tick();
    expect(store.subscriptions("one")).toEqual([]);
    expect(sent.native).toEqual([`${phone}:apple-dead`]);
    store.subscribe("one", { endpoint: web, keys: { p256dh: "key", auth: "auth" } }, laptop);
    fail.web = Object.assign(new Error("Received unexpected response code"), { statusCode: 400, body: '{"reason":"BadPayload"}' });
    store.recordEvents([reply("apple-other")], "cursor");
    await worker.tick();
    expect(store.subscriptions("one")).toHaveLength(1);
  } finally { await worker.stop(); store.close(); }
});
