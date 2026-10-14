import type { FastifyInstance } from "fastify";
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

const scoped = /^\/api\/bots\/:(\w+)(?:\/|$)/;
// Fastify derives a HEAD route from each GET.
const key = (method: string, url: string) => `${method === "HEAD" ? "GET" : method} ${url}`;

/** Install after authentication and before any assistant route. */
export function installBotAccess(app: FastifyInstance, store: Store) {
  app.addHook("onRoute", (route) => {
    if (!scoped.test(route.url)) return;
    for (const method of [route.method].flat())
      if (!botRoutes[key(method, route.url)])
        throw new Error(`Classify ${method} ${route.url} as household or owner access in src/server/bot-access.ts`);
  });
  app.addHook("onRequest", async (req, reply) => {
    const url = routePattern(req);
    const param = scoped.exec(url)?.[1];
    if (!param || botRoutes[key(req.method, url)] !== "owner") return;
    const bot = store.presentation((req.params as Record<string, string>)[param]);
    // Without a signed-in person, as for a path the sign-in hook missed, nobody is the owner.
    if (bot.shared !== false || !bot.ownerId || bot.ownerId === req.user?.id) return;
    const owner = store.getUser(bot.ownerId)?.name;
    return reply.code(403).send({ code: "owner_only", error: owner
      ? `Only ${owner} can do this with their personal assistant.`
      : "Only the owner can do this with this personal assistant." });
  });
}
