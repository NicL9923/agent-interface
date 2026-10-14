import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Bot, Runtime } from "../shared/types.js";
import { routePattern } from "./route-path.js";
import type { Store } from "./store.js";

// A personal assistant with a recorded owner is private: for anyone else it does not
// exist anywhere in WildBots. Shared assistants and older personal ones without a
// recorded owner stay open to every household member, who may also change them.
// Hermes itself is household-wide, so this hides an assistant; it is not an account boundary.
type Presentation = { shared?: boolean; ownerId?: string };
export const visible = (bot: Presentation, userId: string | undefined) =>
  bot.shared !== false || !bot.ownerId || bot.ownerId === userId;

/** Whether this person may see, use and change the assistant. */
export function visibleTo(store: Store, botId: string | undefined, userId: string | undefined) {
  return visible(store.presentation(botId), userId);
}

/** The roster this person sees, with each assistant's presentation applied. */
export async function visibleBots(runtime: Pick<Runtime, "listBots">, store: Store, userId: string) {
  return (await runtime.listBots()).map(bot => ({ ...bot, ...store.presentation(bot.id) }) as Bot)
    .filter(bot => visible(bot, userId));
}

export const notFound = { error: "Assistant not found", code: "assistant_not_found" } as const;

// Signed file IDs carry their assistant in a readable body; Hermes verifies the signature.
export function fileBotId(fileId: string) {
  try { return (JSON.parse(Buffer.from(fileId.split(".")[0], "base64url").toString()) as { botId?: unknown }).botId; }
  catch { return undefined; }
}

// Every route under /api/bots/:id or /api/bots/:botId names one assistant in its path
// and answers 404 to anyone who may not see it. Every other API route is listed here
// with how it finds the assistants it touches. Registering an unlisted one fails at
// startup, so no route that could name an assistant ships without a decision.
//   none     touches no assistant, or only what this person already owns.
//   list     its handler returns only assistants this person sees, which the
//            visibility sweep test proves for every GET route.
//   body     botId or profile in the request body.
//   query    botId or profile in the query string.
//   routine  the :id routine's assistant; "routine and body" also checks the body.
//   file     the assistant a signed file belongs to.
//   group    its handler checks every member of the group or proposed group.
export type BotScope = "none" | "list" | "body" | "query" | "routine" | "routine and body" | "file" | "group";
export const assistantRoutes: Readonly<Record<string, BotScope>> = {
  "GET /api/auth/config": "none",
  "POST /api/auth/confirm": "none",
  "POST /api/auth/google": "none",
  "POST /api/auth/local": "none",
  "POST /api/auth/logout": "none",
  "POST /api/auth/native/complete": "none",
  "POST /api/auth/native/exchange": "none",
  "POST /api/csp-report": "none",
  "GET /api/health": "none",
  "GET /api/health/ready": "none",
  "GET /api/bootstrap": "list",
  "POST /api/connection/retry": "none",
  "PATCH /api/preferences": "none",
  "PUT /api/preferences/models": "none",
  "GET /api/bots": "list",
  "POST /api/bots": "none",
  "GET /api/models": "query",
  "GET /api/submissions/:id": "none",
  "GET /api/files/:id": "file",
  "GET /api/today": "list",
  "PUT /api/today/seen": "none",
  "GET /api/search": "list",
  "GET /api/saved": "list",
  "POST /api/saved": "body",
  "DELETE /api/saved/:id": "none",
  "GET /api/automations": "list",
  "GET /api/routines": "list",
  "POST /api/routines": "body",
  "PUT /api/routines/:id": "routine and body",
  "DELETE /api/routines/:id": "routine",
  "PATCH /api/routines/:id/state": "routine",
  "POST /api/routines/:id/run": "routine",
  "GET /api/routines/:id/runs/:requestId": "routine",
  "POST /api/routines/preview": "body",
  "GET /api/routines/templates": "none",
  "GET /api/groups": "group",
  "POST /api/groups": "group",
  "GET /api/groups/:roomId": "group",
  "GET /api/groups/:roomId/log": "group",
  "POST /api/groups/:roomId/messages": "group",
  "POST /api/groups/:roomId/stop": "group",
  "POST /api/groups/:roomId/approve": "group",
  "GET /api/integrations": "query",
  "POST /api/integrations/:id/check": "body",
  "POST /api/integrations/:id/connect": "body",
  "POST /api/integrations/:id/disconnect": "body",
  "POST /api/integrations/mcp": "body",
  "GET /api/integrations/flows/:flowId": "query",
  "DELETE /api/integrations/flows/:flowId": "query",
  "POST /api/integrations/flows/:flowId/callback": "body",
  // The control holder names the assistant using the computer.
  "GET /api/computer": "list",
  "POST /api/computer/desktop": "none",
  "POST /api/computer/control": "list",
  "GET /api/computer/desktop/ws": "none",
  "POST /api/computer/terminal": "none",
  "POST /api/computer/terminal/end": "none",
  "GET /api/computer/terminal/ws": "none",
  // Busy assistants block an update; another member's private one is not named.
  "GET /api/hermes/upgrade": "list",
  "POST /api/hermes/upgrade/check": "list",
  "POST /api/hermes/upgrade/install": "list",
  "POST /api/hermes/upgrade/control": "list",
  "POST /api/push/subscriptions/status": "none",
  "POST /api/push/subscriptions": "none",
  "DELETE /api/push/subscriptions": "none",
  "POST /api/push/test": "body",
  "GET /api/native/push/config": "none",
  "PUT /api/native/push/device": "none",
  "DELETE /api/native/push/device": "none",
  "POST /api/native/push/test": "body",
  // Audio this person asked for moments ago, from an assistant they could see.
  "GET /api/voice/audio/:audioId": "none",
};

const scoped = /^\/api\/bots\/:(\w+)(?:\/|$)/;
// Fastify derives a HEAD route from each GET.
const key = (method: string, url: string) => `${method === "HEAD" ? "GET" : method} ${url}`;
const named = (value: unknown) => {
  const fields = value && typeof value === "object" ? value as { botId?: unknown; profile?: unknown } : {};
  const botId = fields.botId ?? fields.profile;
  return typeof botId === "string" ? botId : undefined;
};

/** Install after authentication and before any assistant route. */
export function installBotAccess(app: FastifyInstance, store: Store, runtime: Pick<Runtime, "routines">) {
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api/") || scoped.test(route.url)) return;
    for (const method of [route.method].flat())
      if (!assistantRoutes[key(method, route.url)])
        throw new Error(`Classify ${method} ${route.url} for assistant visibility in src/server/bot-access.ts`);
  });
  // Without a signed-in person, as for a path the sign-in hook missed, nobody sees a private assistant.
  const hidden = (req: FastifyRequest, botId: unknown) =>
    typeof botId === "string" && !visibleTo(store, botId, req.user?.id);
  const refuse = (reply: FastifyReply) => reply.code(404).send(notFound);
  app.addHook("onRequest", async (req, reply) => {
    const url = routePattern(req);
    const param = scoped.exec(url)?.[1];
    const scope = assistantRoutes[key(req.method, url)];
    const botId = param ? (req.params as Record<string, string>)[param]
      : scope === "query" ? named(req.query)
      : scope === "file" ? fileBotId((req.params as { id: string }).id) : undefined;
    if (hidden(req, botId)) return refuse(reply);
  });
  // Body and routine checks need the parsed body or the scheduler, so they run just before the handler.
  app.addHook("preHandler", async (req, reply) => {
    const scope = assistantRoutes[key(req.method, routePattern(req))];
    if (scope?.startsWith("routine")) {
      const routineId = (req.params as { id?: string }).id;
      const row = (await runtime.routines()).find(routine => routine.id === routineId);
      // A missing routine is the handler's 404, worded the same.
      if (row && hidden(req, row.botId)) return reply.code(404).send({ error: "Routine not found" });
    }
    if ((scope === "body" || scope === "routine and body") && hidden(req, named(req.body))) return refuse(reply);
  });
}
