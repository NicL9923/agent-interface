import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";
import { defaultPreferences, type Runtime } from "../src/shared/types.js";

const origin = "https://app.example.invalid";
const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function setup() {
  const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: origin, APP_DATABASE: ":memory:",
    GOOGLE_CLIENT_ID: "fixture-client", HOUSEHOLD_EMAILS: "one@example.invalid,two@example.invalid" });
  const modelOptions = vi.fn(async () => ({ providers: [], provider: "saved-provider", model: "saved-model" }));
  const runtime = { modelOptions, close: async () => {} } as unknown as Runtime;
  const result = await createApp(config, runtime, { background: false }); apps.push(result.app);
  const login = (id: string) => {
    result.store.user({ id, name: id, email: `${id}@example.invalid` });
    const token = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
    result.store.session(hash(token), id, csrf, Date.now() + 60000);
    return { origin, cookie: `session=${token}`, "x-csrf-token": csrf };
  };
  return { ...result, runtime, modelOptions, one: login("one"), two: login("two") };
}

it("requires sign-in for the scoped model catalog and explains unsupported Hermes installations", async () => {
  const s = await setup();
  expect((await s.app.inject("/api/models?botId=house")).statusCode).toBe(401);
  expect(s.modelOptions).not.toHaveBeenCalled();
  expect((await s.app.inject({ url: "/api/models?botId=house", headers: s.one })).json()).toEqual({ providers: [], provider: "saved-provider", model: "saved-model" });
  expect(s.modelOptions).toHaveBeenCalledExactlyOnceWith("house");
  delete s.runtime.modelOptions;
  expect((await s.app.inject({ url: "/api/models", headers: s.one })).statusCode).toBe(409);
});

it("keeps model favorites per user and preserves unrelated preferences including older-client updates", async () => {
  const s = await setup();
  s.store.savePreferences("one", { ...defaultPreferences, theme: "dark", favorites: ["assistant"] });
  const modelFavorites = [{ provider: "subscription", model: "actual-model" }];
  expect((await s.app.inject({ method: "PUT", url: "/api/preferences/models", headers: s.one, payload: { modelFavorites } })).json()).toEqual({ modelFavorites });
  expect(s.store.preferences("one")).toMatchObject({ theme: "dark", favorites: ["assistant"], modelFavorites });
  expect(s.store.preferences("two").modelFavorites).toBeUndefined();
  expect((await s.app.inject({ method: "PATCH", url: "/api/preferences", headers: s.one, payload: { ...defaultPreferences, theme: "light" } })).statusCode).toBe(200);
  expect(s.store.preferences("one")).toMatchObject({ theme: "light", modelFavorites });
});

it("rejects favorite writes without Origin/CSRF and validates bounded provider/model pairs", async () => {
  const s = await setup(), request = { method: "PUT" as const, url: "/api/preferences/models", payload: { modelFavorites: [] } };
  expect((await s.app.inject(request)).statusCode).toBe(401);
  for (const headers of [{ cookie: s.one.cookie, origin }, { ...s.one, origin: "https://other.invalid" }])
    expect((await s.app.inject({ ...request, headers })).statusCode).toBe(403);
  expect((await s.app.inject({ ...request, headers: s.one, payload: { modelFavorites: [{ provider: "", model: "model" }] } })).statusCode).toBe(400);
  expect((await s.app.inject({ ...request, headers: s.one, payload: { modelFavorites: [], userId: "two" } })).statusCode).toBe(400);
  expect(s.store.preferences("one").modelFavorites).toBeUndefined();
});
