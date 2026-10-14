import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { botRoutes, installBotAccess } from "../src/server/bot-access.js";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import type { Runtime } from "../src/shared/types.js";
const origin = "http://127.0.0.1:3000";
const apps: { close(): unknown }[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

// Every runtime method records its use, so a refused request provably reached no handler.
function runtimeDouble(calls: string[]) {
  const fixed: Record<string, unknown> = {
    status: async () => ({ connected: true }),
    capabilities: async () => new Proxy({}, { get: () => ({ supported: true }) }),
    listBots: async () => ["mine", "family", "legacy"].map(id => ({ id, name: id, model: "test", shared: id === "family", activity: "idle" })),
    close: async () => {},
  };
  return new Proxy(fixed, {
    get: (target, name) => typeof name !== "string" || name === "then" ? undefined
      : target[name] ?? (async () => { calls.push(name); return {}; }),
  }) as unknown as Runtime;
}
async function setup() {
  const calls: string[] = [];
  const created = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), runtimeDouble(calls), { background: false });
  apps.push(created.app);
  const login = async (member: "one" | "two") => {
    const result = await created.app.inject({ method: "POST", url: "/api/auth/local", headers: { origin }, payload: { member } });
    return { cookie: `session=${result.cookies[0].value}`, "x-csrf-token": result.json().csrfToken as string, origin };
  };
  const owner = await login("one"), member = await login("two");
  created.store.savePresentation("mine", { shared: false, ownerId: "local-one" });
  created.store.savePresentation("family", { shared: true });
  created.store.savePresentation("legacy", { shared: false });
  return { ...created, calls, owner, member };
}
const values: Record<string, string> = { approvalId: "approval", messageId: "message", cardId: "card", target: "memory", itemId: "item", source: "onepassword", requestId: randomUUID(), sessionId: "session", routineId: "routine", resultId: "result" };
const request = (route: string, botId: string) => {
  const [method, url] = route.split(" ") as [string, string];
  return { method: method as "GET", url: url.replace(/:(\w+)/g, (_, name: string) => ["id", "botId"].includes(name) ? botId : values[name]!), payload: method === "GET" ? undefined : {} };
};

describe("assistant ownership", () => {
  it("lists every registered assistant route and refuses non-owners on each owner route before any Hermes call", async () => {
    const s = await setup();
    const owned = Object.entries(botRoutes).filter(([, access]) => access === "owner").map(([route]) => route);
    expect(owned).toEqual(expect.arrayContaining(["PATCH /api/bots/:id", "DELETE /api/bots/:id", "PUT /api/bots/:id/avatar"]));
    for (const [route, access] of Object.entries(botRoutes)) {
      const [method, url] = route.split(" ") as ["GET", string];
      expect(s.app.hasRoute({ method, url }), `${route} is listed but not registered`).toBe(true);
      s.calls.length = 0;
      const response = await s.app.inject({ ...request(route, "mine"), headers: s.member });
      if (access === "owner") {
        expect([route, response.statusCode, response.json().code]).toEqual([route, 403, "owner_only"]);
        expect(response.json().error).toBe("Only Local member one can do this with their personal assistant.");
        expect(s.calls, route).toEqual([]);
      } else if (response.statusCode === 403) expect(response.json().code, route).not.toBe("owner_only");
    }
  });

  it("lets the owner, and anyone for shared or ownerless assistants, through every owner route", async () => {
    const s = await setup();
    for (const [route, access] of Object.entries(botRoutes)) {
      if (access !== "owner") continue;
      for (const [botId, headers] of [["mine", s.owner], ["family", s.member], ["legacy", s.member]] as const) {
        const response = await s.app.inject({ ...request(route, botId), headers });
        expect([route, botId, response.statusCode === 403 ? response.json().code : undefined]).toEqual([route, botId, undefined]);
      }
    }
  });

  it("never lets another member take over or share someone's personal assistant", async () => {
    const s = await setup();
    const input = { name: "Mine", instructions: "", model: "test", shared: true };
    const takeover = await s.app.inject({ method: "PATCH", url: "/api/bots/mine", headers: s.member, payload: { ...input, shared: false } });
    expect(takeover.statusCode).toBe(403);
    expect((await s.app.inject({ method: "PATCH", url: "/api/bots/mine", headers: s.member, payload: input })).statusCode).toBe(403);
    expect(s.store.presentation("mine")).toMatchObject({ shared: false, ownerId: "local-one" });
    // The household still opens and uses it, as the clients promise.
    expect((await s.app.inject({ url: "/api/bots", headers: s.member })).json().map((bot: { id: string }) => bot.id)).toContain("mine");
    s.calls.length = 0;
    await s.app.inject({ url: "/api/bots/mine/conversation", headers: s.member });
    expect(s.calls).toContain("conversation");
    // The percent-encoded path reaches the same route pattern and is refused the same way.
    expect((await s.app.inject({ method: "DELETE", url: "/%61pi/bots/mine", headers: s.member })).statusCode).toBe(403);
  });

  it("refuses to start when an assistant route has no access decision", async () => {
    const app = Fastify(), store = new Store(":memory:"); apps.push(app, store);
    installBotAccess(app, store);
    expect(() => app.get("/api/bots/:id/new-feature", async () => ({}))).toThrow("Classify GET /api/bots/:id/new-feature");
  });
});
