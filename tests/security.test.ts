import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";
import type { Runtime } from "../src/shared/types.js";

const origin = "http://127.0.0.1:3000";
const runtime = { close: async () => {} } as unknown as Runtime;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function start(env: Record<string, string>, verifyGoogle?: () => Promise<Record<string, unknown>>) {
  const result = await createApp(loadConfig({ APP_DATABASE: ":memory:", ...env }), runtime, { background: false, verifyGoogle });
  cleanups.push(() => result.app.close());
  return result;
}
const session = (response: { cookies: { name: string; value: string }[]; json: () => { csrfToken: string } }) => ({
  cookie: `session=${response.cookies[0].value}`, "x-csrf-token": response.json().csrfToken, origin,
  token: response.cookies[0].value,
});

it("records the Google token time at sign-in and confirms only a fresh token for the same account", async () => {
  const seconds = () => Math.floor(Date.now() / 1000);
  let identity = { sub: "family-sub", email: "family@example.test", email_verified: true, name: "Family", iat: seconds() - 1800 };
  const { app, store } = await start({ GOOGLE_CLIENT_ID: "test", HOUSEHOLD_EMAILS: "family@example.test" }, async () => identity);
  const { token, ...headers } = session(await app.inject({ method: "POST", url: "/api/auth/google", headers: { origin }, payload: { credential: "token" } }));
  expect(store.sessionConfirmedAt(hash(token))).toBe(identity.iat * 1000);
  const confirm = (extra: Record<string, string> = headers) =>
    app.inject({ method: "POST", url: "/api/auth/confirm", headers: extra, payload: { credential: "fresh" } });
  identity = { ...identity, iat: seconds() };
  expect((await confirm({ cookie: headers.cookie, origin })).statusCode).toBe(403);
  expect((await confirm({ origin })).statusCode).toBe(401);
  identity = { ...identity, sub: "someone-else" };
  expect((await confirm()).statusCode).toBe(403);
  identity = { ...identity, sub: "family-sub", iat: seconds() - 11 * 60 };
  expect((await confirm()).statusCode).toBe(401);
  expect(store.sessionConfirmedAt(hash(token))).toBe((seconds() - 1800) * 1000);
  identity = { ...identity, iat: seconds() - 60 };
  const confirmed = await confirm();
  expect(confirmed.statusCode).toBe(200);
  expect(store.sessionConfirmedAt(hash(token))).toBe(identity.iat * 1000);
  expect(confirmed.json().confirmedAt).toBe(new Date(identity.iat * 1000).toISOString());
});

it("confirms a local development session only for the same member on loopback", async () => {
  const { app, store } = await start({ LOCAL_DEV_AUTH: "true" });
  const before = Date.now();
  const { token, ...headers } = session(await app.inject({ method: "POST", url: "/api/auth/local", headers: { origin }, payload: { member: "one" } }));
  expect(store.sessionConfirmedAt(hash(token))).toBeGreaterThanOrEqual(before);
  store.db.prepare("DELETE FROM session_confirmations").run();
  const confirm = (member: string, remoteAddress = "127.0.0.1") =>
    app.inject({ method: "POST", url: "/api/auth/confirm", headers, remoteAddress, payload: { member } });
  expect((await confirm("two")).statusCode).toBe(403);
  expect((await confirm("one", "192.0.2.10")).statusCode).toBe(403);
  expect(store.sessionConfirmedAt(hash(token))).toBeUndefined();
  expect((await confirm("one")).statusCode).toBe(200);
  expect(store.sessionConfirmedAt(hash(token))).toBeGreaterThanOrEqual(before);
});
