import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import webpush from "web-push";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";
import type { Runtime } from "../src/shared/types.js";

const origin = "https://app.example.invalid";
const endpoint = "https://push.example.invalid/device";
const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function setup() {
  const keys = webpush.generateVAPIDKeys();
  const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: origin, APP_DATABASE: ":memory:",
    GOOGLE_CLIENT_ID: "fixture-client", HOUSEHOLD_EMAILS: "one@example.invalid,two@example.invalid",
    VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: "mailto:one@example.invalid" });
  const runtime = { close: async () => {} } as unknown as Runtime;
  const result = await createApp(config, runtime, { background: false }); apps.push(result.app);
  const login = (id: string) => {
    result.store.user({ id, name: id, email: `${id}@example.invalid` });
    const token = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
    result.store.session(hash(token), id, csrf, Date.now() + 60000);
    return { origin, cookie: `session=${token}`, "x-csrf-token": csrf };
  };
  return { ...result, one: login("one"), two: login("two") };
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
