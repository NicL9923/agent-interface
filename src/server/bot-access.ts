import type { FastifyInstance, FastifyReply } from "fastify";
import type { Runtime } from "../shared/types.js";
import { routePattern } from "./route-path.js";
import type { Store } from "./store.js";

// A personal assistant is personalized, not private: both clients tell people that
// every household member can open and use it. Only its owner changes what it is.
// Owner-only reads are the drill-downs from search and automations, whose lists
// already show a personal assistant only to its owner. Shared assistants and older
// ones without a recorded owner stay open to everyone.
export type BotAccess = "household" | "owner";

// Every route that names one assistant in its path is listed here. Registering an
// unlisted one fails at startup, so no route ships without a deliberate decision.
export const botRoutes: Readonly<Record<string, BotAccess>> = {
  "PATCH /api/bots/:id": "owner",
  "DELETE /api/bots/:id": "owner",
  "PUT /api/bots/:id/avatar": "owner",
  "POST /api/bots/:id/portrait": "owner",
  "GET /api/bots/:id/inference": "household",
  "PATCH /api/bots/:id/inference": "owner",
  "GET /api/bots/:id/tools": "household",
  "PUT /api/bots/:id/tools": "owner",
  "GET /api/bots/:id/skills": "household",
  "PUT /api/bots/:id/skills": "owner",
  "GET /api/bots/:id/conversation": "household",
  "GET /api/bots/:id/events": "household",
  "POST /api/bots/:id/messages": "household",
  "POST /api/bots/:id/steer": "household",
  "POST /api/bots/:id/stop": "household",
  "POST /api/bots/:id/requests/:approvalId": "household",
  "POST /api/bots/:id/approvals/:approvalId": "household",
  "GET /api/bots/:id/draft": "household",
  "PUT /api/bots/:id/draft": "household",
  "GET /api/bots/:id/read-position": "household",
  "PUT /api/bots/:id/read-position": "household",
  "POST /api/bots/:id/uploads": "household",
  "GET /api/bots/:id/starters": "household",
  "GET /api/bots/:id/messages/:messageId/cards/:cardId/state": "household",
  "PUT /api/bots/:id/messages/:messageId/cards/:cardId/state": "household",
  "POST /api/bots/:id/voice/transcribe": "household",
  "POST /api/bots/:id/voice/speak": "household",
  // Memory and logins follow Hermes profile access, which the docs describe as household-wide.
  "GET /api/bots/:id/memory": "household",
  "PUT /api/bots/:id/memory/:target": "household",
  "PATCH /api/bots/:id/memory/:target": "household",
  "DELETE /api/bots/:id/memory/:target": "household",
  "GET /api/bots/:id/vault": "household",
  "POST /api/bots/:id/vault/logins": "household",
  "DELETE /api/bots/:id/vault/logins/:itemId": "household",
  "PUT /api/bots/:id/vault/sources/:source": "household",
  "POST /api/bots/:id/vault/sources/:source/unlock": "household",
  "POST /api/bots/:id/vault/sources/:source/lock": "household",
  "POST /api/bots/:id/secure-requests/:requestId": "household",
  // Any native session, including other platforms', reached from owner-filtered search.
  "GET /api/bots/:botId/history/:sessionId": "owner",
  "GET /api/bots/:botId/routines/:routineId/results": "owner",
  "GET /api/bots/:botId/routines/:routineId/results/:resultId": "owner",
};

// Routines are part of what an assistant does, so they follow the same rule. Automations
// already list only routines of assistants a person may change; every other routine route
// now agrees. Each entry names where the route finds the assistants it touches:
// "routine" is the :id routine's assistant, "body" is botId in the request, "list" is
// filtered by its handler, and "none" touches no assistant.
export type RoutineScope = "none" | "list" | "routine" | "body" | "routine and body";
export const routineRoutes: Readonly<Record<string, RoutineScope>> = {
  "GET /api/routines": "list",
  "POST /api/routines": "body",
  "PUT /api/routines/:id": "routine and body",
  "DELETE /api/routines/:id": "routine",
  "PATCH /api/routines/:id/state": "routine",
  "POST /api/routines/:id/run": "routine",
  "GET /api/routines/:id/runs/:requestId": "routine",
  "POST /api/routines/preview": "body",
  "GET /api/routines/templates": "none",
};

/** Whether this person may change the assistant: shared, ownerless, or theirs. */
export function canChange(store: Store, botId: string, userId: string | undefined) {
  const bot = store.presentation(botId);
  return bot.shared !== false || !bot.ownerId || bot.ownerId === userId;
}
const scoped = /^\/api\/bots\/:(\w+)(?:\/|$)/;
const routinePath = /^\/api\/routines(?:\/|$)/;
// Fastify derives a HEAD route from each GET.
const key = (method: string, url: string) => `${method === "HEAD" ? "GET" : method} ${url}`;

/** Install after authentication and before any assistant route. */
export function installBotAccess(app: FastifyInstance, store: Store, runtime: Pick<Runtime, "routines">) {
  app.addHook("onRoute", (route) => {
    const table: Record<string, unknown> | undefined = scoped.test(route.url) ? botRoutes : routinePath.test(route.url) ? routineRoutes : undefined;
    if (!table) return;
    for (const method of [route.method].flat())
      if (!table[key(method, route.url)])
        throw new Error(`Classify ${method} ${route.url} for assistant ownership in src/server/bot-access.ts`);
  });
  const refuse = (reply: FastifyReply, ownerId: string) => {
    const owner = store.getUser(ownerId)?.name;
    return reply.code(403).send({ code: "owner_only", error: owner
      ? `Only ${owner} can do this with their personal assistant.`
      : "Only the owner can do this with this personal assistant." });
  };
  app.addHook("onRequest", async (req, reply) => {
    const url = routePattern(req);
    const param = scoped.exec(url)?.[1];
    if (!param || botRoutes[key(req.method, url)] !== "owner") return;
    const botId = (req.params as Record<string, string>)[param];
    // Without a signed-in person, as for a path the sign-in hook missed, nobody is the owner.
    if (!canChange(store, botId, req.user?.id)) return refuse(reply, store.presentation(botId).ownerId!);
  });
  // Routine checks need the parsed body, so they run just before the handler.
  app.addHook("preHandler", async (req, reply) => {
    const scope = routineRoutes[key(req.method, routePattern(req))];
    if (!scope || scope === "none" || scope === "list") return;
    if (scope !== "body") {
      const routineId = (req.params as { id?: string }).id;
      const row = (await runtime.routines()).find(routine => routine.id === routineId);
      // The list hides it, so do not reveal it exists. A missing one is the handler's 404.
      if (row && !canChange(store, row.botId, req.user?.id)) return reply.code(404).send({ error: "Routine not found" });
    }
    const botId = scope === "routine" ? undefined : (req.body as { botId?: unknown } | undefined)?.botId;
    if (typeof botId === "string" && !canChange(store, botId, req.user?.id)) return refuse(reply, store.presentation(botId).ownerId!);
  });
}
