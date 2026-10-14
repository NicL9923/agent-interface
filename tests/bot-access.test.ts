import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { assistantRoutes, installBotAccess } from "../src/server/bot-access.js";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import { HermesUpgrades } from "../src/server/upgrades.js";
import { defaultPreferences, type Runtime } from "../src/shared/types.js";
const origin = "http://127.0.0.1:3000";
const apps: { close(): unknown }[] = [], directories: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// The private assistant has a distinctive ID and name, so any response that leaks either is caught.
const secret = "zq-ledger", secretName = "Moonlit Saddle Ledger";
const names: Record<string, string> = { [secret]: secretName, family: "Family Helper", legacy: "Old Timer" };
const member = (profile: string) => ({ member_id: profile, profile, handle: profile, display_name: names[profile] });
const rooms = [
  { room_id: "ledger-room", name: "Ledger room", members: [member(secret), member("family")] },
  { room_id: "family-room", name: "Family room", members: [member("family"), member("legacy")] },
];
// A signed file ID's readable body names its assistant.
const fileId = (botId: string) => `${Buffer.from(JSON.stringify({ botId, path: "/f", name: "f", mime: "text/plain", kind: "artifact", version: 1 })).toString("base64url")}.signature`;

// Every source of assistants names the private one, and every other runtime method records its use,
// so a refused request provably reached no handler.
function runtimeDouble(calls: string[]) {
  const fixed: Record<string, unknown> = {
    status: async () => ({ connected: true }),
    capabilities: async () => new Proxy({}, { get: () => ({ supported: true }) }),
    listBots: async () => Object.entries(names).map(([id, name]) => ({ id, name, model: "test", shared: id === "family", activity: id === secret ? "working" : "idle", lastMessage: { text: `Latest from ${name}` } })),
    routines: async () => [
      { id: "r-secret", botId: secret, name: "Private books", prompt: "Reconcile", schedule: "0 8 * * *", enabled: true, nextRunAt: "2030-01-01T08:00:00.000Z" },
      { id: "r-family", botId: "family", name: "Family", prompt: "Dinner", schedule: "0 17 * * *", enabled: true, nextRunAt: "2030-01-01T17:00:00.000Z" },
    ],
    conversation: async (botId: string) => ({ botId, messages: [{ id: "m1", role: "assistant", text: `Reply from ${names[botId]}` }], activity: { state: "idle" }, approvals: [], attention: [] }),
    experienceRequest: async (input: { operation: string; profile: string }) =>
      input.operation === "search" ? [{ botId: input.profile, sessionId: "session", title: "Ledger hit", snippet: "ledger" }]
      : input.operation === "usage" ? { botId: input.profile, days: 30, sessions: 1 } : { botId: input.profile },
    routineResults: async () => [{ id: "result", title: "Ledger result", previewOnly: false }],
    groupRequest: async (input: { operation: string; roomId?: string }) =>
      input.operation === "list" ? { supported: true, canSend: true, rooms }
      : input.operation === "state" ? { room: rooms.find(room => room.room_id === input.roomId) ?? rooms[1] }
      : { events: [], cursor: 0, latest_seq: 0, has_more: false },
    computerRequest: async () => ({ available: true, running: true, browserReady: true, label: "Household computer", control: { kind: "bot", name: secret }, terminal: { available: false, target: "" } }),
    integrationRequest: async (input: { profile: string }) => ({ profile: input.profile, connections: [{ id: "workspace", name: "Google Workspace", profile: input.profile, botIds: [input.profile] }] }),
    modelOptions: async () => ({ provider: "", model: "", providers: [] }),
    saveBot: async (input: { name: string; shared: boolean }, id: string) => { calls.push("saveBot"); return { id, name: input.name, model: "test", shared: input.shared, activity: "idle" }; },
    close: async () => {},
  };
  return new Proxy(fixed, {
    get: (target, name) => typeof name !== "string" || name === "then" ? undefined
      : target[name] ?? (async () => { calls.push(name); return {}; }),
  }) as unknown as Runtime;
}
async function setup() {
  const calls: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), "bot-access-")); directories.push(directory);
  writeFileSync(join(directory, "worker.json"), "{}", { mode: 0o600 });
  const config = loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:", HERMES_UPGRADE_ENABLED: "true",
    HERMES_UPGRADE_ADMINS: "one@localhost.invalid,two@localhost.invalid", HERMES_UPGRADE_CONFIG: join(directory, "worker.json"),
    HERMES_UPGRADE_STATE_DIR: directory, HERMES_UPGRADE_PYTHON: "/usr/bin/python3" });
  const runtime = runtimeDouble(calls);
  const created = await createApp(config, runtime, { background: false, upgrades: new HermesUpgrades(config, runtime, () => {}) });
  apps.push(created.app);
  const login = async (member: "one" | "two") => {
    const result = await created.app.inject({ method: "POST", url: "/api/auth/local", headers: { origin }, payload: { member } });
    return { cookie: `session=${result.cookies[0].value}`, "x-csrf-token": result.json().csrfToken as string, origin };
  };
  const owner = await login("one"), other = await login("two");
  created.store.savePresentation(secret, { shared: false, ownerId: "local-one" });
  created.store.savePresentation("family", { shared: true });
  created.store.savePresentation("legacy", { shared: false });
  return { ...created, calls, owner, member: other };
}
// Kim saved, pinned and followed the assistant while it was shared, before Nicolas made it his.
function seedMemberHistory(store: Store) {
  store.savePreferences("local-two", { ...defaultPreferences, favorites: [secret, "family"], followBots: [secret],
    sections: [{ id: "work", name: "Work", botIds: [secret, "family"] }], defaultBotId: secret });
  store.saveItem("local-two", { kind: "session", botId: secret, sessionId: "session", title: "Ledger notes" });
  store.saveItem("local-two", { kind: "session", botId: "family", sessionId: "session", title: "Family notes" });
  store.savePersonal("drafts", "local-two", secret, { text: "Half a thought", attachments: [] });
  store.recordEvents([{ id: "e-secret", botId: secret, runId: "run", kind: "completed", title: `${secretName} finished`, occurredAt: new Date().toISOString() }], "1");
}
const values: Record<string, string> = { approvalId: "approval", messageId: "m1", cardId: "card", target: "memory", itemId: "item", source: "onepassword", requestId: randomUUID(), sessionId: "session", routineId: "r-family", resultId: "result", roomId: "ledger-room", flowId: "f".repeat(24), audioId: "audio" };
const ids: Record<string, (botId: string) => string> = { "/api/routines/:id": () => "r-secret", "/api/files/:id": fileId, "/api/submissions/:id": () => randomUUID(), "/api/integrations/:id": () => "workspace" };
const queries: Record<string, (botId: string) => string> = { "/api/search": () => "q=ledger", "/api/models": botId => `botId=${botId}`, "/api/integrations": botId => `profile=${botId}`, "/api/integrations/flows/:flowId": botId => `profile=${botId}` };
const request = (method: string, url: string, botId: string) => {
  const path = url.replace(/:(\w+)/g, (_, name: string) => name === "botId" || name === "id" && url.startsWith("/api/bots/") ? botId
    : name === "id" ? Object.entries(ids).find(([prefix]) => url.startsWith(prefix))?.[1](botId) ?? "x" : values[name]!);
  const query = queries[url]?.(botId);
  return { method: method as "GET", url: query ? `${path}?${query}` : path,
    payload: method === "GET" ? undefined : { botId, profile: botId, botIds: [botId, "family"], requestId: randomUUID(), name: "Moved", prompt: "Run", schedule: "0 9 * * *", enabled: true, recipientIds: [] } };
};
const scoped = (url: string) => /^\/api\/bots\/:(id|botId)(\/|$)/.test(url);

describe("private assistants", () => {
  it("classifies every API route and refuses to start with an unclassified one", async () => {
    const s = await setup();
    const api = new Set(s.routes.filter(route => route.url.startsWith("/api/") && route.method !== "HEAD").map(route => `${route.method} ${route.url}`));
    for (const route of api) if (!scoped(route.split(" ")[1])) expect(assistantRoutes[route], route).toBeDefined();
    for (const route of Object.keys(assistantRoutes)) expect(api.has(route), `${route} is listed but not registered`).toBe(true);
    const app = Fastify(), store = new Store(":memory:"); apps.push(app, store);
    installBotAccess(app, store, { routines: async () => [] });
    expect(() => app.get("/api/new-list", async () => ({}))).toThrow("Classify GET /api/new-list");
    // A route naming an assistant in its path needs no decision: it is always gated.
    expect(() => app.get("/api/bots/:id/new-feature", async () => ({}))).not.toThrow();
  });

  it("answers 404 for another member's private assistant on every route that names it, before any Hermes call", async () => {
    const s = await setup();
    let checked = 0;
    for (const { method, url } of s.routes) {
      const scope = assistantRoutes[`${method} ${url}`];
      if (method === "HEAD" || !(scoped(url) || ["body", "query", "file", "routine", "routine and body"].includes(scope))) continue;
      // The owner's pass below may have deleted or reshaped it.
      s.store.savePresentation(secret, { shared: false, ownerId: "local-one" });
      s.calls.length = 0;
      const refused = await s.app.inject({ ...request(method, url, secret), headers: s.member });
      const routine = scope === "routine" || scope === "routine and body";
      expect([method, url, refused.statusCode, refused.json().code ?? refused.json().error])
        .toEqual([method, url, 404, routine ? "Routine not found" : "assistant_not_found"]);
      expect(s.calls, `${method} ${url}`).toEqual([]);
      checked++;
      for (const [botId, headers] of [[secret, s.owner], ["family", s.member], ["legacy", s.member]] as const) {
        if (routine && botId !== secret) continue;
        const allowed = await s.app.inject({ ...request(method, url, botId), headers });
        expect([method, url, botId, allowed.json()?.code], "the owner and anyone for shared or ownerless assistants pass")
          .not.toEqual([method, url, botId, "assistant_not_found"]);
      }
    }
    expect(checked).toBeGreaterThan(50);
    // A member's own routine cannot be moved onto someone else's private assistant.
    const moved = await s.app.inject({ ...request("PUT", "/api/routines/r-family", secret), headers: s.member });
    expect([moved.statusCode, moved.json().code]).toEqual([404, "assistant_not_found"]);
    // The percent-encoded path reaches the same route pattern and is refused the same way.
    expect((await s.app.inject({ method: "DELETE", url: `/%61pi/bots/${secret}`, headers: s.member })).statusCode).toBe(404);
    // Without a session the sign-in hook refuses it first.
    const anonymous = await s.app.inject({ method: "DELETE", url: "/%61pi/bots/family" });
    expect([anonymous.statusCode, anonymous.json().code]).toEqual([401, "session_expired"]);
    expect(s.calls).not.toContain("deleteBot");
  });

  it("leaves another member's private assistant out of every GET response", async () => {
    const s = await setup();
    seedMemberHistory(s.store);
    const gets = [...new Set(s.routes.filter(route => route.method === "GET" && route.url.startsWith("/api/")).map(route => route.url))];
    const leaks: string[] = [], seen: string[] = [];
    for (const url of gets) {
      const memberBody = (await s.app.inject({ ...request("GET", url, "family"), headers: s.member })).body;
      if (memberBody.includes(secret) || memberBody.includes(secretName)) leaks.push(`${url}: ${memberBody.slice(0, 300)}`);
      const ownerBody = (await s.app.inject({ ...request("GET", url, "family"), headers: s.owner })).body;
      if (ownerBody.includes(secret) || ownerBody.includes(secretName)) seen.push(url);
    }
    expect(leaks).toEqual([]);
    // Proves the fixture reaches each list, so the sweep above can fail.
    expect(seen).toEqual(expect.arrayContaining(["/api/bootstrap", "/api/bots", "/api/today", "/api/search", "/api/automations",
      "/api/routines", "/api/groups", "/api/groups/:roomId", "/api/computer", "/api/hermes/upgrade"]));
    const busy = (await s.app.inject({ url: "/api/hermes/upgrade", headers: s.member })).json().busyBots;
    expect(busy, "a private assistant still blocks an update, without its name").toEqual(["Another member's assistant"]);
    const preferences = (await s.app.inject({ url: "/api/bootstrap", headers: s.member })).json().preferences;
    expect(preferences).toMatchObject({ favorites: ["family"], followBots: [], sections: [{ botIds: ["family"] }] });
    expect(preferences.defaultBotId).toBeUndefined();
    expect((await s.app.inject({ url: "/api/saved", headers: s.member })).json().map((item: { title: string }) => item.title)).toEqual(["Family notes"]);
  });

  it("lets only the owner share a private assistant and confirms before anyone makes one personal", async () => {
    const s = await setup();
    const input = { name: "Mine", instructions: "", model: "test" };
    for (const shared of [true, false])
      expect((await s.app.inject({ method: "PATCH", url: `/api/bots/${secret}`, headers: s.member, payload: { ...input, shared, confirmPrivate: true } })).statusCode).toBe(404);
    expect(s.store.presentation(secret)).toMatchObject({ shared: false, ownerId: "local-one" });
    // The owner edits their own private assistant without a prompt.
    expect((await s.app.inject({ method: "PATCH", url: `/api/bots/${secret}`, headers: s.owner, payload: { ...input, shared: false } })).statusCode).toBe(200);
    for (const botId of ["family", "legacy"]) {
      s.calls.length = 0;
      const unconfirmed = await s.app.inject({ method: "PATCH", url: `/api/bots/${botId}`, headers: s.member, payload: { ...input, shared: false } });
      expect([botId, unconfirmed.statusCode, unconfirmed.json().code]).toEqual([botId, 409, "private_confirmation_required"]);
      expect(s.calls).toEqual([]);
    }
    expect((await s.app.inject({ method: "PATCH", url: "/api/bots/family", headers: s.member, payload: { ...input, shared: false, confirmPrivate: true } })).statusCode).toBe(200);
    expect(s.store.presentation("family")).toMatchObject({ shared: false, ownerId: "local-two" });
    const listed = async (headers: Record<string, string>) => (await s.app.inject({ url: "/api/bots", headers })).json().map((bot: { id: string }) => bot.id);
    expect(await listed(s.owner)).toEqual([secret, "legacy"]);
    // Sharing it again clears the owner, so nobody keeps a claim on a shared assistant.
    expect((await s.app.inject({ method: "PATCH", url: `/api/bots/${secret}`, headers: s.owner, payload: { ...input, shared: true } })).statusCode).toBe(200);
    expect(s.store.presentation(secret)).toEqual({ shared: true, ownerId: undefined, avatar: undefined });
    expect(await listed(s.member)).toEqual([secret, "family", "legacy"]);
  });

  it("forgets the owner and each person's state when an assistant is deleted", async () => {
    const s = await setup();
    seedMemberHistory(s.store);
    s.store.saveCardState("local-one", secret, "m1", "card", { checkedIds: ["a"], notes: {} });
    s.store.saveItem("local-one", { kind: "session", botId: secret, sessionId: "session", title: "Ledger notes" });
    expect((await s.app.inject({ method: "DELETE", url: `/api/bots/${secret}`, headers: s.owner })).statusCode).toBe(200);
    expect(s.calls).toContain("deleteBot");
    expect(s.store.presentation(secret)).toEqual({});
    expect(s.store.personal("drafts", "local-two", secret)).toBeNull();
    expect(s.store.cardState("local-one", secret, "m1", "card")).toEqual({ checkedIds: [], notes: {} });
    expect(s.store.savedItems("local-one")).toEqual([]);
    expect(s.store.savedItems("local-two").map(item => item.botId)).toEqual(["family"]);
    expect(s.store.preferences("local-two")).toMatchObject({ favorites: ["family"], followBots: [], sections: [{ botIds: ["family"] }] });
    expect(s.store.preferences("local-two").defaultBotId).toBeUndefined();
  });
});
