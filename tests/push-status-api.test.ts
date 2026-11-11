import { afterEach, expect, it } from "vitest";
import webpush from "web-push";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { fakeRuntime, signIn } from "./helpers/server.js";

const origin = "https://app.example.invalid";
const endpoint = "https://push.example.invalid/device";
const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function setup() {
  const keys = webpush.generateVAPIDKeys();
  const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: origin, APP_DATABASE: ":memory:",
    GOOGLE_CLIENT_ID: "fixture-client", HOUSEHOLD_EMAILS: "one@example.invalid,two@example.invalid",
    VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: "mailto:one@example.invalid" });
  const runtime = fakeRuntime({ close: async () => {} });
  const result = await createApp(config, runtime, { background: false }); apps.push(result.app);
  return { ...result, one: signIn(result.store, origin, "one"), two: signIn(result.store, origin, "two") };
}

it("checks a subscription only for its signed-in owner without exposing another member's registration", async () => {
  const s = await setup(), status = { method: "POST" as const, url: "/api/push/subscriptions/status", payload: { endpoint } };
  expect((await s.app.inject(status)).statusCode).toBe(401);
  expect((await s.app.inject({ ...status, headers: s.one })).json()).toEqual({ registered: false });
  expect((await s.app.inject({ method: "POST", url: "/api/push/subscriptions", headers: s.one, payload: { endpoint, keys: { p256dh: "key", auth: "key" } } })).statusCode).toBe(200);
  expect((await s.app.inject({ ...status, headers: s.one })).json()).toEqual({ registered: true });
  expect((await s.app.inject({ ...status, headers: s.two })).json()).toEqual({ registered: false });
  expect((await s.app.inject({ method: "DELETE", url: "/api/push/subscriptions", headers: s.two, payload: { endpoint } })).statusCode).toBe(200);
  expect((await s.app.inject({ ...status, headers: s.one })).json()).toEqual({ registered: true });
  expect((await s.app.inject({ method: "DELETE", url: "/api/push/subscriptions", headers: s.one, payload: { endpoint } })).statusCode).toBe(200);
  expect((await s.app.inject({ ...status, headers: s.one })).json()).toEqual({ registered: false });
});

it("requires Origin and CSRF for status reads and rejects identities supplied in the request body", async () => {
  const s = await setup(), request = { method: "POST" as const, url: "/api/push/subscriptions/status", payload: { endpoint } };
  for (const headers of [{ cookie: s.one.cookie, origin }, { ...s.one, origin: "https://other.invalid" }])
    expect((await s.app.inject({ ...request, headers })).statusCode).toBe(403);
  expect((await s.app.inject({ ...request, headers: s.one, payload: { endpoint, userId: "two" } })).statusCode).toBe(400);
});

// A lapsed session cannot remove its subscription, and the browser keeps it. The next member to
// sign in there subscribes with the same endpoint and keys, which moves it to them.
const keys = { p256dh: "member-one-key", auth: "member-one-auth" };
const subscribe = (s: Awaited<ReturnType<typeof setup>>, headers: Record<string, string>, payload: object) =>
  s.app.inject({ method: "POST", url: "/api/push/subscriptions", headers, payload });
const owned = (s: Awaited<ReturnType<typeof setup>>) => ({ one: s.store.subscriptions("one").map(item => item.endpoint), two: s.store.subscriptions("two").map(item => item.endpoint) });

it("moves a browser's subscription to the next member who subscribes with its keys, and never leaves it with both", async () => {
  const s = await setup(), status = { method: "POST" as const, url: "/api/push/subscriptions/status", payload: { endpoint } };
  const laptop = "6c1f0e3a-2b4d-4c5e-8f60-7a8b9c0d1e2f", tablet = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  expect((await subscribe(s, s.one, { endpoint, keys, deviceId: laptop })).statusCode).toBe(200);
  expect(s.store.subscriptionDevices("one")).toEqual(new Map([[endpoint, laptop]]));
  // Member one's session lapses; member two signs in on the same browser and turns notifications on.
  const taken = await subscribe(s, s.two, { endpoint, keys, deviceId: tablet });
  expect([taken.statusCode, taken.json()]).toEqual([200, { ok: true }]);
  expect(owned(s)).toEqual({ one: [], two: [endpoint] });
  expect((await s.app.inject({ ...status, headers: s.two })).json()).toEqual({ registered: true });
  expect((await s.app.inject({ ...status, headers: s.one })).json()).toEqual({ registered: false });
  // The label of the previous holder's device goes with it.
  expect(s.store.subscriptionDevices("one")).toEqual(new Map());
  expect(s.store.subscriptionDevices("two")).toEqual(new Map([[endpoint, tablet]]));
  // Member one signing back in takes it back the same way, and a client with no device ID drops the label.
  expect((await subscribe(s, s.one, { endpoint, keys })).statusCode).toBe(200);
  expect(owned(s)).toEqual({ one: [endpoint], two: [] });
  expect(s.store.subscriptionDevices("two")).toEqual(new Map());
  expect(s.store.subscriptionDevices("one")).toEqual(new Map());
});

it.each([
  ["a different p256dh", { p256dh: "other-key", auth: keys.auth }],
  ["a different auth secret", { p256dh: keys.p256dh, auth: "other-auth" }],
  ["an auth secret of the same length", { p256dh: keys.p256dh, auth: keys.auth.slice(0, -1) + "X" }],
  ["a prefix of the stored auth secret", { p256dh: keys.p256dh, auth: keys.auth.slice(0, -1) }],
  // Same character count, more bytes: comparing character counts alone let this reach timingSafeEqual, which throws.
  ["an auth secret of the same character count with a multibyte character", { p256dh: keys.p256dh, auth: keys.auth.slice(0, -1) + "é" }],
  ["a p256dh of the same character count with a multibyte character", { p256dh: keys.p256dh.slice(0, -1) + "é", auth: keys.auth }],
])("refuses to move another member's subscription for %s, and leaves it with its holder", async (_name, offered) => {
  const s = await setup();
  const laptop = "6c1f0e3a-2b4d-4c5e-8f60-7a8b9c0d1e2f";
  await subscribe(s, s.one, { endpoint, keys, deviceId: laptop });
  const refused = await subscribe(s, s.two, { endpoint, keys: offered, deviceId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" });
  expect([refused.statusCode, refused.json().error]).toEqual([409, "This browser push subscription belongs to another household member."]);
  expect(owned(s)).toEqual({ one: [endpoint], two: [] });
  expect(s.store.subscriptions("one")[0].keys).toEqual(keys);
  expect(s.store.subscriptionDevices("one")).toEqual(new Map([[endpoint, laptop]]));
  expect(s.store.subscriptionDevices("two")).toEqual(new Map());
});

it("accepts a subscription only as a signed-in member's complete https request, for that member and no one the body names", async () => {
  const s = await setup();
  await subscribe(s, s.one, { endpoint, keys });
  const cases: [string, Record<string, string>, object, number][] = [
    ["no session", {}, { endpoint, keys }, 401],
    ["no CSRF token", { cookie: s.two.cookie, origin }, { endpoint, keys }, 403],
    ["an http endpoint", s.two, { endpoint: endpoint.replace("https", "http"), keys }, 400],
    ["no keys", s.two, { endpoint }, 400],
    ["an empty auth secret", s.two, { endpoint, keys: { ...keys, auth: "" } }, 400],
    ["an identity in the body", s.two, { endpoint, keys, userId: "one" }, 200],
  ];
  for (const [reason, headers, payload, code] of cases)
    expect([reason, (await subscribe(s, headers, payload)).statusCode]).toEqual([reason, code]);
  // The only request that got through was member two's complete one, and the body's userId changed nothing.
  expect(owned(s)).toEqual({ one: [], two: [endpoint] });
});

it("keeps the stored keys when a member refreshes their own subscription and when another is refused", async () => {
  const s = await setup();
  await subscribe(s, s.one, { endpoint, keys });
  expect((await subscribe(s, s.one, { endpoint, keys: { p256dh: "rotated", auth: "rotated-auth" } })).statusCode).toBe(200);
  expect(s.store.subscriptions("one")[0].keys).toEqual({ p256dh: "rotated", auth: "rotated-auth" });
  // The rotated keys are now the proof: the old ones no longer move the subscription.
  expect((await subscribe(s, s.two, { endpoint, keys })).statusCode).toBe(409);
  expect(owned(s)).toEqual({ one: [endpoint], two: [] });
});
