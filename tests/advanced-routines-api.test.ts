import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import type { Routine, Runtime } from "../src/shared/types.js";

const origin = "http://127.0.0.1:3000";
const base = { botId: "shared", name: "Morning", prompt: "Check the ranch", schedule: "1h", enabled: false, recipientIds: [] };
let app: Awaited<ReturnType<typeof createApp>>["app"];
let rows: Routine[];
let save: ReturnType<typeof vi.fn>;
let models: ReturnType<typeof vi.fn>;
let headers: Record<string, string>;
beforeEach(async () => {
  rows = [{ ...base, id: "abc123", skills: ["saved-skill"], model: "retired-model", provider: "retired-provider", script: "old.py", noAgent: false, contextFrom: ["self", "deleted-source"], enabledToolsets: [] }];
  save = vi.fn(async (input, id) => ({ ...input, id: id ?? "new" }));
  models = vi.fn(async () => ({ providers: [{ id: "configured", name: "Configured", authenticated: true, models: [{ id: "selected", name: "Selected", available: true }] }] }));
  const runtime = {
    status: async () => ({ connected: true }),
    capabilities: async () => ({ routines: { supported: true } }),
    listBots: async () => [{ id: "shared", name: "Shared", shared: true, activity: "idle" }],
    routines: async () => rows, saveRoutine: save, modelOptions: models, close: async () => {},
  } as unknown as Runtime;
  ({ app } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_ORIGIN: origin, APP_DATABASE: ":memory:" }), runtime, { background: false }));
  const response = await app.inject({ method: "POST", url: "/api/auth/local", headers: { origin }, payload: { member: "one" } });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  headers = { cookie, origin, "x-csrf-token": response.json().csrfToken };
});
afterEach(async () => { await app?.close(); });
const write = (payload: object, id?: string) => app.inject({ method: id ? "PUT" : "POST", url: `/api/routines${id ? `/${id}` : ""}`, headers, payload });

it("preserves unseen overrides and empty allowlists when editing or pausing", async () => {
  const original = rows[0];
  const response = await write({ ...original, name: "Renamed", enabled: true }, original.id);
  expect(response.statusCode).toBe(200);
  expect(save.mock.calls[0][0]).toEqual({ ...base, name: "Renamed", enabled: true });
  expect(response.json()).toMatchObject({ contextFrom: ["self", "deleted-source"], model: "retired-model", enabledToolsets: [], script: "old.py" });
  expect(models).not.toHaveBeenCalled();
});
it("accepts skill-only and script-only payloads and rejects a job with nothing to run", async () => {
  expect((await write({ ...base, prompt: "", skills: ["daily-plan"] })).statusCode).toBe(200);
  expect((await write({ ...base, prompt: "", script: "reports/daily.py", noAgent: true })).statusCode).toBe(200);
  expect((await write({ ...base, prompt: "" })).statusCode).toBe(400);
  expect((await write({ ...base, noAgent: true })).statusCode).toBe(400);
  expect(save).toHaveBeenCalledTimes(2);
});
it("allows explicit clears, validates chosen existing models, and never infers a provider", async () => {
  expect((await write({ ...base, model: null, provider: null, script: null, skills: [], enabledToolsets: null, contextFrom: [] }, "abc123")).statusCode).toBe(200);
  expect(save.mock.calls[0][0]).toMatchObject({ model: null, provider: null, script: null, skills: [], enabledToolsets: null, contextFrom: [] });
  expect(models).not.toHaveBeenCalled();
  expect((await write({ ...base, model: "selected", provider: "configured" })).statusCode).toBe(200);
  expect((await write({ ...base, model: "selected" })).statusCode).toBe(400);
  expect((await write({ ...base, model: "invented", provider: "configured" })).statusCode).toBe(400);
});
it("keeps dependencies in this profile and refuses to broaden a new empty tool allowlist", async () => {
  rows.push({ ...base, id: "def456", botId: "private" });
  expect((await write({ ...base, contextFrom: ["self", "abc123"] })).statusCode).toBe(200);
  expect((await write({ ...base, contextFrom: ["def456"] })).statusCode).toBe(400);
  expect((await write({ ...base, contextFrom: ["missing"] })).statusCode).toBe(400);
  expect((await write({ ...base, enabledToolsets: [] })).statusCode).toBe(400);
  expect((await write({ ...base, botId: "private" }, "abc123")).statusCode).toBe(404);
});
