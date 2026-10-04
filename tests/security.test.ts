import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";
import { apiPolicy, contentSecurityPolicy, installSecurityHeaders } from "../src/server/security-headers.js";
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
  const signedInAt = identity.iat * 1000;
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
  expect(store.sessionConfirmedAt(hash(token))).toBe(signedInAt);
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

it("sends the document policy on pages, the API policy on JSON, and leaves files and existing policies alone", async () => {
  const app = Fastify();
  installSecurityHeaders(app, "https://app.example.invalid");
  app.get("/", async (_req, reply) => reply.type("text/html").send("<!doctype html>"));
  app.get("/api/thing", async () => ({ ok: true }));
  app.get("/api/files/:id", async (_req, reply) => reply.type("application/pdf").send(Buffer.from("%PDF")));
  app.get("/own", async (_req, reply) => reply.header("Content-Security-Policy", "default-src 'none'").type("text/html").send("own"));
  cleanups.push(() => app.close());
  const page = await app.inject("/");
  expect(page.headers["content-security-policy"]).toBe(contentSecurityPolicy("https://app.example.invalid"));
  expect(page.headers["content-security-policy"]).toContain("connect-src 'self' wss://app.example.invalid https://accounts.google.com/gsi/;");
  expect(page.headers["content-security-policy"]).toContain("script-src 'self' https://accounts.google.com/gsi/client;");
  expect(page.headers["strict-transport-security"]).toBe("max-age=31536000");
  expect(page.headers["permissions-policy"]).toContain("microphone=(self)");
  expect((await app.inject("/api/thing")).headers["content-security-policy"]).toBe(apiPolicy);
  expect((await app.inject("/api/files/report")).headers["content-security-policy"]).toBeUndefined();
  expect((await app.inject("/own")).headers["content-security-policy"]).toBe("default-src 'none'");
  const local = Fastify();
  installSecurityHeaders(local, origin);
  local.get("/", async () => "page");
  cleanups.push(() => local.close());
  const response = await local.inject("/");
  expect(response.headers["strict-transport-security"]).toBeUndefined();
  expect(response.headers["content-security-policy"]).toContain("ws://127.0.0.1:3000");
});

it("keeps the native sign-in nonce policy and protects JSON API responses", async () => {
  const { app } = await start({ GOOGLE_CLIENT_ID: "test", HOUSEHOLD_EMAILS: "family@example.test" });
  const native = await app.inject({ url: `/native/sign-in?state=${"s".repeat(32)}&code_challenge=${"c".repeat(43)}&code_challenge_method=S256` });
  expect(native.statusCode).toBe(200);
  expect(native.headers["content-security-policy"]).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/);
  expect((await app.inject("/api/health")).headers["content-security-policy"]).toBe(apiPolicy);
  expect((await app.inject("/api/bootstrap")).headers["content-security-policy"]).toBe(apiPolicy);
});

it("accepts violation reports without an Origin, logs each distinct one once without queries, and limits the rate", async () => {
  const { app } = await start({ LOCAL_DEV_AUTH: "true" });
  const report = (payload: unknown, type = "application/csp-report") =>
    app.inject({ method: "POST", url: "/api/csp-report", headers: { "content-type": type }, payload: JSON.stringify(payload) });
  const violation = { "csp-report": { "document-uri": "http://127.0.0.1:3000/?bot=ranch", "effective-directive": "connect-src",
    "blocked-uri": "ws://127.0.0.1:3000/api/computer/terminal/ws?ticket=secret" } };
  expect((await report(violation)).statusCode).toBe(204);
  expect((await report([{ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "https://example.test/a.png" } }],
    "application/reports+json")).statusCode).toBe(204);
  expect((await report("x".repeat(20000))).statusCode).toBe(413);

  const logs: { csp?: Record<string, unknown> }[] = [];
  const logged = Fastify({ logger: { level: "warn", stream: { write: (line: string) => { logs.push(JSON.parse(line)); } } } });
  installSecurityHeaders(logged, origin);
  cleanups.push(() => logged.close());
  const send = () => logged.inject({ method: "POST", url: "/api/csp-report", headers: { "content-type": "application/csp-report" }, payload: JSON.stringify(violation) });
  for (let i = 0; i < 30; i++) expect((await send()).statusCode).toBe(204);
  expect((await send()).statusCode).toBe(429);
  expect(logs.filter(line => line.csp)).toEqual([expect.objectContaining({ csp: {
    directive: "connect-src", blocked: "ws://127.0.0.1:3000/api/computer/terminal/ws", document: "http://127.0.0.1:3000/" } })]);
});
