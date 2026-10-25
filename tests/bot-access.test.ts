import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { assistantRoutes, installBotAccess, redactAgents, Roster } from "../src/server/bot-access.js";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import { HermesUpgrades } from "../src/server/upgrades.js";
import { defaultPreferences, type Runtime } from "../src/shared/types.js";
import { IncompleteCreationError } from "../src/shared/errors.js";
import { localLogin } from "./helpers/server.js";
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
    botDetail: async (id: string) => ({ id, name: names[id], model: "test", shared: id === "family", activity: id === secret ? "working" : "idle", lastMessage: { text: `Latest from ${names[id]}` }, instructions: "Saved instructions", enabledMcpServers: [], enabledTools: [], enabledSkills: [] }),
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
    watch: () => () => {},
    // Like Hermes, only a genuine signature names the file's assistant.
    fileBotId: (id: string) => id.endsWith(".signature") ? JSON.parse(Buffer.from(id.split(".")[0], "base64url").toString()).botId : undefined,
    saveRoutine: async (input: { botId: string }) => { calls.push("saveRoutine"); return { ...input, id: "r-new" }; },
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
  const owner = await localLogin(created.app, origin, "one"), other = await localLogin(created.app, origin, "two");
  created.store.savePresentation(secret, { shared: false, ownerId: "local-one" });
  created.store.savePresentation("family", { shared: true });
  created.store.savePresentation("legacy", { shared: false });
  return { ...created, calls, owner, member: other, runtime: runtime as unknown as Record<string, unknown> };
}
// Kim saved, pinned and followed the assistant while it was shared, before Nicolas made it his.
function seedMemberHistory(store: Store) {
  store.savePreferences("local-two", { ...defaultPreferences, favorites: [secret, "family"], followBots: [secret],
    sections: [{ id: "work", name: "Work", botIds: [secret, "family"] }], defaultBotId: secret });
  store.saveItem("local-two", { kind: "session", botId: secret, sessionId: "session", title: "Ledger notes" });
  store.saveItem("local-two", { kind: "session", botId: "family", sessionId: "session", title: "Family notes" });
  store.saveDraft("local-two", secret, { text: "Half a thought", attachments: [] });
  store.recordEvents([{ id: "e-secret", botId: secret, runId: "run", kind: "completed", title: `${secretName} finished`, occurredAt: new Date().toISOString() }], "1");
}
const values: Record<string, string> = { approvalId: "approval", messageId: "m1", cardId: "card", target: "memory", itemId: "item", source: "onepassword", requestId: randomUUID(), sessionId: "session", routineId: "r-family", resultId: "result", roomId: "ledger-room", flowId: "f".repeat(24), audioId: "audio" };
const ids: Record<string, (botId: string) => string> = { "/api/routines/:id": () => "r-secret", "/api/files/:id": fileId, "/api/submissions/:id": () => randomUUID(), "/api/integrations/:id": () => "workspace" };
const queries: Record<string, (botId: string) => string> = { // Search names the private assistant to be refused, and otherwise searches every visible one.
  "/api/search": botId => botId === secret ? `q=ledger&botId=${botId}` : "q=ledger", "/api/models": botId => `botId=${botId}`, "/api/integrations": botId => `profile=${botId}`, "/api/integrations/flows/:flowId": botId => `profile=${botId}` };
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
    installBotAccess(app, store, { routines: async () => [], listBots: async () => [] });
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
      // A change stream never ends, so only its status is read.
      const stream = url.endsWith("/events");
      const refused = await s.app.inject({ ...request(method, url, secret), headers: s.member });
      const routine = scope === "routine" || scope === "routine and body";
      expect([method, url, refused.statusCode, refused.json().code ?? refused.json().error])
        .toEqual([method, url, 404, routine ? "Routine not found" : "assistant_not_found"]);
      expect(s.calls, `${method} ${url}`).toEqual([]);
      checked++;
      for (const [botId, headers] of [[secret, s.owner], ["family", s.member], ["legacy", s.member]] as const) {
        if (routine && botId !== secret) continue;
        const allowed = await s.app.inject({ ...request(method, url, botId), headers, payloadAsStream: stream });
        if (stream) { expect(allowed.statusCode).toBe(200); allowed.stream().destroy(); continue; }
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
    // The change stream never ends and carries no content; its own test covers it.
    const gets = [...new Set(s.routes.filter(route => route.method === "GET" && route.url.startsWith("/api/") && !route.url.endsWith("/events")).map(route => route.url))];
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
    expect(busy, "a private assistant still blocks an update, without its name").toEqual(["An assistant"]);
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
    expect(s.store.draft("local-two", secret)).toBeNull();
    expect(s.store.cardState("local-one", secret, "m1", "card")).toEqual({ checkedIds: [], notes: {} });
    expect(s.store.savedItems("local-one")).toEqual([]);
    expect(s.store.savedItems("local-two").map(item => item.botId)).toEqual(["family"]);
    expect(s.store.preferences("local-two")).toMatchObject({ favorites: ["family"], followBots: [], sections: [{ botIds: ["family"] }] });
    expect(s.store.preferences("local-two").defaultBotId).toBeUndefined();
  });
});

const deferred = () => { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; };
const makePrivate = (store: Store, botId: string, ownerId = "local-one") => store.savePresentation(botId, { shared: false, ownerId });

describe("private assistants under concurrency and side channels", () => {
  it("lets no read that finishes after its assistant turns private carry what it gathered", async () => {
    const s = await setup();
    const gate = deferred();
    const conversation = s.runtime.conversation as (botId: string) => Promise<unknown>;
    s.runtime.conversation = async (botId: string) => { await gate.wait; return conversation(botId); };
    const routines = s.runtime.routines as () => Promise<unknown>;
    s.runtime.routines = async () => { await gate.wait; return routines(); };
    const reading = s.app.inject({ url: "/api/bots/family/conversation", headers: s.member });
    const listing = s.app.inject({ url: "/api/routines", headers: s.member });
    const owners = s.app.inject({ url: "/api/routines", headers: s.owner });
    await new Promise(resolve => setTimeout(resolve, 20));
    makePrivate(s.store, "family");
    gate.release();
    const [read, list, own] = await Promise.all([reading, listing, owners]);
    expect([read.statusCode, read.json().code]).toEqual([404, "assistant_not_found"]);
    expect(read.body).not.toContain("Family Helper");
    expect([list.statusCode, list.json().code]).toEqual([503, "assistants_changed"]);
    expect(list.body).not.toContain("r-family");
    // The owner gained nothing to hide, so their read stands.
    expect(own.statusCode).toBe(200);
  });

  it("ends a change stream, sending nothing more, once its assistant becomes someone else's", async () => {
    const s = await setup();
    const notify: (() => void)[] = [];
    s.runtime.watch = (_botId: string, changed: () => void) => { notify.push(changed); return () => {}; };
    const response = await s.app.inject({ url: "/api/bots/family/events", headers: s.member, payloadAsStream: true });
    expect(response.statusCode).toBe(200);
    makePrivate(s.store, "family");
    notify.forEach(changed => changed());
    let body = "";
    for await (const chunk of response.stream()) body += chunk;
    expect(body).not.toContain("change");
  });

  it("refuses a save authorized before another member made the assistant theirs", async () => {
    const s = await setup();
    const input = { name: "Family", instructions: "", model: "test", shared: true };
    const gate = deferred();
    const capabilities = s.runtime.capabilities as () => Promise<unknown>;
    s.runtime.capabilities = async () => { await gate.wait; return capabilities(); };
    const delayed = s.app.inject({ method: "PATCH", url: "/api/bots/family", headers: s.member, payload: input });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(s.store.swapPresentation("family", { shared: true }, { shared: false, ownerId: "local-one" })).not.toBe(false);
    gate.release();
    expect((await delayed).statusCode).toBe(404);
    expect(s.store.presentation("family")).toMatchObject({ shared: false, ownerId: "local-one" });
    expect(s.calls).not.toContain("saveBot");
    // A compare-and-set against stale sharing writes nothing.
    expect(s.store.swapPresentation("family", { shared: true }, { shared: false, ownerId: "local-two" })).toBe(false);
    expect(s.store.presentation("family")).toMatchObject({ ownerId: "local-one" });
  });

  it("hides another member's private assistant inside a shared assistant's agent exchanges", async () => {
    const s = await setup();
    s.runtime.conversation = async (botId: string) => ({ botId, activity: { state: "idle" }, approvals: [], attention: [], messages: [
      { id: "in", role: "user", text: `Message from 🤖 ${secretName} (@${secret}): The ledger balance is 42.` },
      { id: "out", role: "tool", text: "", toolName: "message_agent", toolCall: { id: "c", name: "message_agent", status: "completed", arguments: JSON.stringify({ target: secret, message: "Share the balance" }), result: "Balance 42" } },
      { id: "metadata", role: "assistant", text: "Private answer", origin: { kind: "agent", visibility: "activity", name: secretName, handle: secret, title: "Balance 42" }, reasoning: "Balance 42", files: [{ id: "private-file", name: "Balance 42", mime: "text/plain" }] },
      { id: "plain", role: "assistant", text: "Dinner is at six." },
    ], files: [{ id: "private-file", name: "Balance 42", mime: "text/plain" }] });
    const member = (await s.app.inject({ url: "/api/bots/family/conversation", headers: s.member })).body;
    for (const leak of [secret, secretName, "42", "Share the balance", "private-file"]) expect(member).not.toContain(leak);
    expect(member).toContain("another member's assistant");
    expect(member).toContain("Dinner is at six.");
    for (const suffix of ["", "?before=plain"]) {
      const files = await s.app.inject({url:`/api/bots/family/files${suffix}`,headers:s.member});
      expect(files.statusCode).toBe(200);
      expect(files.body).not.toContain("private-file");
      expect(files.body).not.toContain("Balance 42");
    }
    const owner = (await s.app.inject({ url: "/api/bots/family/conversation", headers: s.owner })).body;
    expect(owner).toContain("The ledger balance is 42.");
  });

  it("answers a hidden assistant exactly like one that does not exist, including forged files", async () => {
    const s = await setup();
    for (const path of ["draft", "read-position", "conversation"]) {
      const hidden = await s.app.inject({ url: `/api/bots/${secret}/${path}`, headers: s.member });
      const missing = await s.app.inject({ url: `/api/bots/zz-nobody/${path}`, headers: s.member });
      expect([missing.statusCode, missing.body]).toEqual([hidden.statusCode, hidden.body]);
    }
    // A save, even a stale one that would conflict, answers the same 404 and reveals no revision.
    for (const baseRevision of [0, 7]) {
      const hidden = await s.app.inject({ method: "PUT", url: `/api/bots/${secret}/draft`, headers: s.member, payload: { text: "Probe", attachments: [], baseRevision } });
      const missing = await s.app.inject({ method: "PUT", url: "/api/bots/zz-nobody/draft", headers: s.member, payload: { text: "Probe", attachments: [], baseRevision } });
      expect([missing.statusCode, missing.body]).toEqual([hidden.statusCode, hidden.body]);
      expect(hidden.statusCode).toBe(404);
    }
    // The owner's drafts keep their revisions.
    const put = (text: string, baseRevision: number) => s.app.inject({ method: "PUT", url: `/api/bots/${secret}/draft`, headers: s.owner, payload: { text, attachments: [], baseRevision } });
    expect((await put("Owner note", 0)).json()).toMatchObject({ text: "Owner note", revision: 1 });
    expect((await put("Owner note on an old copy", 0)).json()).toMatchObject({ code: "draft_conflict", draft: { text: "Owner note", revision: 1 } });
    const forged = (botId: string) => `${fileId(botId).split(".")[0]}.forged`;
    const hidden = await s.app.inject({ url: `/api/files/${forged(secret)}`, headers: s.member });
    const missing = await s.app.inject({ url: `/api/files/${forged("zz-nobody")}`, headers: s.member });
    expect([missing.statusCode, missing.body]).toEqual([hidden.statusCode, hidden.body]);
  });

  it("keeps the sender's receipts and remembered trials from anyone who cannot see them", async () => {
    const s = await setup();
    const requestId = randomUUID();
    s.store.intent({ requestId, botId: "family", senderId: "local-one", text: "Hi", attachments: [] });
    s.store.receipt({ requestId, status: "accepted", runId: "run-x", messageId: "41" });
    s.runtime.lookupSubmission = async () => ({ requestId, status: "accepted", runId: "run-x", messageId: "41" });
    const theirs = (await s.app.inject({ url: `/api/submissions/${requestId}`, headers: s.member })).json();
    expect(theirs).toMatchObject({ status: "uncertain" });
    expect(JSON.stringify(theirs)).not.toContain("run-x");
    expect((await s.app.inject({ url: `/api/submissions/${requestId}`, headers: s.owner })).json()).toMatchObject({ runId: "run-x" });
    // Kim ran a trial while the assistant was shared; it became private and the routine was deleted.
    const trial = randomUUID();
    s.store.rememberRoutineTrial(trial, "local-two", "r-gone", "family");
    makePrivate(s.store, "family");
    s.calls.length = 0;
    const receipt = await s.app.inject({ url: `/api/routines/r-gone/runs/${trial}`, headers: s.member });
    expect([receipt.statusCode, receipt.json().error]).toEqual([404, "Routine not found"]);
    expect(s.calls).toEqual([]);
  });

  it("names no private assistant's busy state, however many are busy", async () => {
    const s = await setup();
    makePrivate(s.store, "legacy");
    s.runtime.listBots = async () => Object.entries(names).map(([id, name]) => ({ id, name, model: "test", shared: id === "family", activity: id === "family" ? "idle" : "working" }));
    expect((await s.app.inject({ url: "/api/hermes/upgrade", headers: s.member })).json().busyBots).toEqual(["An assistant"]);
  });

  it("refuses routine recipients who would never receive a private assistant's results", async () => {
    const s = await setup();
    const routine = { botId: secret, name: "Books", prompt: "Reconcile", schedule: "0 8 * * *", enabled: true };
    const refused = await s.app.inject({ method: "POST", url: "/api/routines", headers: s.owner, payload: { ...routine, recipientIds: ["local-one", "local-two"] } });
    expect([refused.statusCode, refused.json().code]).toEqual([400, "private_recipients"]);
    expect(s.calls).not.toContain("saveRoutine");
    expect((await s.app.inject({ method: "POST", url: "/api/routines", headers: s.owner, payload: { ...routine, recipientIds: ["local-one"] } })).statusCode).toBe(200);
  });
});

describe("private assistant notification history", () => {
  const event = (id: string, botId = secret) => ({ id, botId, runId: "run", kind: "completed" as const, title: `${names[botId]} finished`, occurredAt: new Date().toISOString() });
  function seeded() {
    const store = new Store(":memory:"); apps.push(store);
    for (const id of ["local-one", "local-two"]) store.user({ id, name: id, email: `${id}@example.test` });
    store.participate("run", "local-two");
    store.savePreferences("local-two", { ...defaultPreferences, followBots: [secret] });
    makePrivate(store, secret);
    return store;
  }
  const queuedFor = (store: Store, userId: string) => (store.db.prepare("SELECT event_id FROM outbox WHERE user_id=?").all(userId) as { event_id: string }[]).map(row => row.event_id);

  it("forgets a deleted assistant's events, runs and notifications so nothing reaches former participants", () => {
    const store = seeded();
    store.savePresentation(secret, { shared: true });
    store.recordEvents([event("shared-era")], "1");
    makePrivate(store, secret);
    store.recordEvents([event("private-era")], "2");
    store.forgetBot(secret);
    store.db.prepare("DELETE FROM outbox").run();
    store.enqueueKnownEvents();
    expect(queuedFor(store, "local-two")).toEqual([]);
    expect(store.db.prepare("SELECT count(*) AS n FROM notification_events").get()).toEqual({ n: 0 });
    expect(store.db.prepare("SELECT count(*) AS n FROM participants WHERE run_id='run'").get()).toEqual({ n: 0 });
  });

  it("sends each event only to whoever could see the assistant when it happened, by its own time", () => {
    const store = new Store(":memory:"); apps.push(store);
    for (const id of ["alice", "bob", "carol"]) {
      store.user({ id, name: id, email: `${id}@example.test` });
      store.savePreferences(id, { ...defaultPreferences, followBots: ["books"] });
    }
    const at = (offset: number) => new Date(Date.now() + offset).toISOString();
    // Alice's private period, shared, Bob's private period, shared again.
    const periods = (rows: [number, string | null][]) => { store.db.prepare("DELETE FROM bot_visibility_periods").run(); for (const [offset, owner] of rows) store.db.prepare("INSERT INTO bot_visibility_periods VALUES('books',?,?)").run(Date.now() + offset, owner); };
    store.savePresentation("books", { shared: true });
    periods([[-100_000, "alice"], [-80_000, null], [-60_000, "bob"], [-40_000, null]]);
    const event = (id: string, occurredAt: string) => ({ id, botId: "books", runId: "run", kind: "completed" as const, title: "Books finished", occurredAt });
    // Discovery reports these late, after the last share, so ingestion time would mislead.
    store.recordEvents([event("alice-era", at(-90_000)), event("shared-era", at(-70_000)), event("bob-era", at(-50_000)), event("now", at(-1_000)), event("undated", "soon")], "1");
    const queued = (userId: string) => (store.db.prepare("SELECT event_id FROM outbox WHERE user_id=? ORDER BY event_id").all(userId) as { event_id: string }[]).map(row => row.event_id);
    expect(queued("alice")).toEqual(["alice-era", "now", "shared-era"]);
    expect(queued("bob")).toEqual(["bob-era", "now", "shared-era"]);
    expect(queued("carol")).toEqual(["now", "shared-era"]);
    // Today agrees.
    expect(store.eventPage("carol", 0, store.latestEventFrontier(), ["books"]).events.map(row => row.id)).toEqual(["shared-era", "now"]);
  });

  it("records the private period when an assistant first changes hands", () => {
    const store = seeded();
    // Shared from the beginning until local-one made it theirs.
    expect(store.visibilityPeriods(secret).map(period => [period.startedAt === 0, period.ownerId])).toEqual([[true, null], [false, "local-one"]]);
  });

  it("never moves another member's Today frontier for hidden events", () => {
    const store = seeded();
    store.savePresentation("family", { shared: true });
    store.recordEvents([event("visible", "family")], "1");
    const before = store.eventPage("local-two", 0, store.latestEventFrontier(), ["family"]).frontier;
    store.recordEvents([event("hidden-1"), event("hidden-2")], "2");
    expect(store.eventPage("local-two", 0, store.latestEventFrontier(), ["family"]).frontier).toBe(before);
    expect(Number(store.eventPage("local-one", 0, store.latestEventFrontier(), ["family", secret]).frontier)).toBeGreaterThan(Number(before));
  });
});

describe("private assistant saves and agent traffic", () => {
  it("records a new personal assistant as private before Hermes creates it, and forgets it if Hermes fails", async () => {
    const s = await setup();
    const during: unknown[] = [];
    let fail = false;
    s.runtime.saveBot = async (input: { name: string; shared: boolean }) => {
      during.push(s.store.presentation("night-ledger"));
      if (fail) throw Object.assign(new Error("Hermes refused"), { statusCode: 502 });
      return { id: "night-ledger", name: input.name, model: "test", shared: input.shared, activity: "idle" };
    };
    const create = { name: "Night Ledger", instructions: "", model: "test", shared: false };
    expect((await s.app.inject({ method: "POST", url: "/api/bots", headers: s.owner, payload: create })).statusCode).toBe(200);
    expect(during[0]).toMatchObject({ shared: false, ownerId: "local-one" });
    s.store.forgetBot("night-ledger");
    fail = true;
    expect((await s.app.inject({ method: "POST", url: "/api/bots", headers: s.owner, payload: create })).statusCode).toBe(502);
    expect(during[1]).toMatchObject({ shared: false, ownerId: "local-one" });
    expect(s.store.presentation("night-ledger")).toEqual({});
    // An existing assistant's record is never overwritten by a create that Hermes would refuse.
    const existing = await s.app.inject({ method: "POST", url: "/api/bots", headers: s.member, payload: { ...create, name: "Family" } });
    expect(existing.statusCode).toBe(409);
    expect(s.store.presentation("family")).toMatchObject({ shared: true });
  });

  it("rolls back only its own sharing write, never a later save's", () => {
    const store = new Store(":memory:"); apps.push(store);
    store.savePresentation("books", { shared: true });
    const first = store.swapPresentation("books", { shared: true }, { shared: false, ownerId: "one" });
    // A second save writes the same values; Hermes accepts it.
    expect(store.swapPresentation("books", { shared: false, ownerId: "one" }, { shared: false, ownerId: "one" })).not.toBe(false);
    // The first save's Hermes call then fails.
    expect(store.restorePresentation("books", first as number, { shared: true })).toBe(false);
    expect(store.presentation("books")).toMatchObject({ shared: false, ownerId: "one" });
  });

  it("hides another member's private assistant in calls still running and after it is renamed", async () => {
    const s = await setup();
    let name = secretName;
    const listBots = s.runtime.listBots as () => Promise<{ id: string; name: string }[]>;
    s.runtime.listBots = async () => (await listBots()).map(bot => bot.id === secret ? { ...bot, name } : bot);
    s.runtime.conversation = async (botId: string) => ({ botId, activity: { state: "working" }, approvals: [], attention: [], messages: [
      { id: "in", role: "user", text: `Message from 🤖 ${name}: The ledger balance is 42.` },
    ], toolCalls: [{ id: "live", name: "message_agent", status: "running", arguments: JSON.stringify({ target: secret, message: "Share the balance" }), result: "Balance 42" }] });
    const read = async () => (await s.app.inject({ url: "/api/bots/family/conversation", headers: s.member })).body;
    for (const leak of [secret, secretName, "42", "Share the balance"]) expect(await read()).not.toContain(leak);
    // The owner renames it; the next read already knows the new name.
    s.runtime.saveBot = async () => { name = "Midnight Tally"; return { id: secret, name, model: "test", shared: false, activity: "idle" }; };
    expect((await s.app.inject({ method: "PATCH", url: `/api/bots/${secret}`, headers: s.owner, payload: { name: "Midnight Tally", instructions: "", model: "test", shared: false } })).statusCode).toBe(200);
    const after = await read();
    for (const leak of ["Midnight Tally", "42"]) expect(after).not.toContain(leak);
  });
});

describe("private assistant redaction across tools, restarts and failed creation", () => {
  it("hides any tool detail that names another member's private assistant, whatever the tool", async () => {
    const s = await setup();
    s.runtime.conversation = async (botId: string) => ({ botId, activity: { state: "idle" }, approvals: [], attention: [], messages: [
      { id: "batch", role: "tool", text: "", toolName: "message_agent, web_search", toolCall: { id: "b", name: "message_agent, web_search", status: "completed", arguments: JSON.stringify({ calls: [{ name: "message_agent", arguments: { target: secret, message: "Share the balance" } }] }), result: "Balance 42" } },
      { id: "search", role: "tool", text: `Searched for ${secretName}`, toolName: "web_search", toolCall: { id: "w", name: "web_search", status: "completed", arguments: JSON.stringify({ query: secretName }), result: "Ledger 42" } },
      { id: "plain", role: "tool", text: "Weather is fine", toolName: "web_search", toolCall: { id: "p", name: "web_search", status: "completed", arguments: JSON.stringify({ query: "weather" }), result: "Sunny" } },
    ] });
    const body = (await s.app.inject({ url: "/api/bots/family/conversation", headers: s.member })).body;
    for (const leak of [secret, secretName, "42", "Share the balance"]) expect(body).not.toContain(leak);
    expect(body).toContain("Sunny");
  });

  it("matches a private assistant's names as whole words, however short", async () => {
    const s = await setup();
    s.store.rememberNames([{ id: secret, name: "Penny" }]);
    const roster = new Roster({ listBots: async () => [{ id: secret, name: "Al", model: "test", shared: false, activity: "idle" }] }, s.store);
    const redact = await redactAgents(s.store, roster, "local-two");
    const result = (text: string) => redact.call({ id: "w", name: "web_search", status: "completed", arguments: "{}", result: text }).result;
    expect(result("Prices in halfpenny coins")).toBe("Prices in halfpenny coins");
    expect(result("Penny's ledger is balanced")).toBeUndefined();
    expect(result("Ask Al about it")).toBeUndefined();
    expect(result("Always and alpha")).toBe("Always and alpha");
  });

  it("remembers earlier names across a restart", async () => {
    const s = await setup();
    await s.app.inject({ url: "/api/bots/family/conversation", headers: s.member });
    // A later process starts after the rename, with only the new name in Hermes's roster.
    const restarted = new Roster({ listBots: async () => [{ id: secret, name: "Midnight Tally", model: "test", shared: false, activity: "idle" }] }, s.store);
    const redact = await redactAgents(s.store, restarted, "local-two");
    expect(redact.message({ id: "old", role: "user", text: `Message from 🤖 ${secretName}: The ledger balance is 42.` }).text).not.toContain(secretName);
    expect(redact.message({ id: "new", role: "user", text: "Message from 🤖 Midnight Tally: 42" }).text).not.toContain("Midnight Tally");
  });

  it("keeps a profile Hermes created but could not remove private to its creator", async () => {
    const s = await setup();
    s.runtime.saveBot = async () => { throw new IncompleteCreationError("Hermes created the bot but configuration failed and automatic cleanup was refused. Review bot night-ledger.", "night-ledger"); };
    const failed = await s.app.inject({ method: "POST", url: "/api/bots", headers: s.owner, payload: { name: "Night Ledger", instructions: "", model: "test", shared: false } });
    expect([failed.statusCode, failed.json().code]).toEqual([502, "created_incomplete"]);
    expect(failed.json().error).toContain("Night Ledger");
    expect(s.store.presentation("night-ledger")).toMatchObject({ shared: false, ownerId: "local-one" });
  });
});
