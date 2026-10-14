import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";
import { createHermesRuntime } from "../src/server/hermes.js";
import { installVaultRoutes } from "../src/server/vault.js";
import type { Runtime } from "../src/shared/types.js";

// Clients treat a 401 as the end of their own sign-in, and iOS deletes its Keychain token.
// Only a missing or expired app session may produce one, and it always says so by code.
const origin = "https://app.example.invalid";
const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); vi.unstubAllGlobals(); });
async function setup(runtime: Runtime) {
  const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: origin, APP_DATABASE: ":memory:",
    GOOGLE_CLIENT_ID: "fixture-client", HOUSEHOLD_EMAILS: "member@example.invalid" });
  const result = await createApp(config, runtime, { background: false }); apps.push(result.app);
  result.store.user({ id: "member", name: "Member", email: "member@example.invalid" });
  const token = randomBytes(32).toString("base64url");
  result.store.nativeSession(hash(token), "member", Date.now() + 60000);
  return { ...result, native: { authorization: `Bearer ${token}` } };
}

it("turns Hermes rejecting the server's token into an explained 502 for the native client", async () => {
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("No socket in this contract"); } });
  const runtime = createHermesRuntime({ url: "http://127.0.0.1:19119", token: "server-token" });
  const s = await setup(runtime);
  for (const status of [401, 403]) {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Service authentication required" }, { status })));
    const response = await s.app.inject({ url: "/api/integrations?profile=ranch", headers: s.native });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: "hermes_unauthorized", error: expect.stringContaining("You are still signed in.") });
    // Every Hermes HTTP path shares the mapping, including credentials and memory.
    await expect(runtime.vaultRequest!({ operation: "overview", profile: "ranch" })).rejects.toMatchObject({ statusCode: 502, code: "hermes_unauthorized" });
    await expect(runtime.experienceRequest!({ operation: "memory", profile: "ranch" })).rejects.toMatchObject({ statusCode: 502, code: "hermes_unauthorized" });
  }
});

it("never forwards an upstream 401 or 403 from the credential bridge", async () => {
  const app = Fastify(); apps.push(app);
  app.decorateRequest("user", null);
  app.addHook("onRequest", async req => { req.user = { id: "member", name: "Member", email: "member@example.invalid" }; });
  app.setErrorHandler((error, _req, reply) => reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: (error as Error).message, code: (error as { code?: string }).code }));
  let failure: Error = new Error();
  await installVaultRoutes(app, { listBots: async () => [{ id: "ranch" }], vaultRequest: async () => { throw failure; } } as unknown as Runtime);
  for (const status of [401, 403]) {
    failure = Object.assign(new Error("native detail"), { statusCode: status });
    expect((await app.inject("/api/bots/ranch/vault")).statusCode).toBe(502);
  }
  failure = Object.assign(new Error("Hermes rejected this server's credential."), { statusCode: 502, code: "hermes_unauthorized" });
  expect((await app.inject("/api/bots/ranch/vault")).json()).toEqual({ error: "Hermes rejected this server's credential.", code: "hermes_unauthorized" });
});

it("marks every missing, invalid or expired session 401 as session_expired", async () => {
  const s = await setup({ close: async () => {} } as unknown as Runtime);
  const expired = randomBytes(32).toString("base64url");
  s.store.nativeSession(hash(expired), "member", Date.now() - 1);
  for (const headers of [{}, { authorization: "Bearer not-a-token" }, { authorization: `Bearer ${expired}` }, { cookie: "session=unknown" }]) {
    const response = await s.app.inject({ url: "/api/bootstrap", headers });
    expect([response.statusCode, response.json().code]).toEqual([401, "session_expired"]);
  }
});
