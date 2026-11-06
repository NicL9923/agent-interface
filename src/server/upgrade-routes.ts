import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { signedIn } from "./auth.js";
import { routePattern } from "./route-path.js";
import type { HermesUpgrades } from "./upgrades.js";

/**
 * While Hermes upgrades, refuses writes that would reach it: assistant changes other than drafts,
 * read positions and presence, routines, group chats, connections and notification actions.
 * Install before the routes it guards.
 */
export function installMaintenanceGate(app: FastifyInstance, upgrades: Pick<HermesUpgrades, "maintenance">) {
  app.addHook("onRequest", async (req, reply) => {
    if (!upgrades.maintenance() || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const path = routePattern(req);
    if ((path.startsWith("/api/bots") && !/\/(draft|read-position|presence)$/.test(path)) || path.startsWith("/api/routines") || path.startsWith("/api/groups") || path.startsWith("/api/integrations") || path === "/api/push/actions")
      return reply.code(409).send({ error: path.startsWith("/api/integrations")
        ? "Hermes is being upgraded. Try changing connections after the update finishes."
        : "Hermes is being upgraded. Your draft is saved; send it after the update finishes.", code: "hermes_maintenance" });
  });
}

/** Checking, installing and recovering Hermes updates. */
export function installUpgradeRoutes(app: FastifyInstance, upgrades: HermesUpgrades) {
  app.get("/api/hermes/upgrade", async req => upgrades.status(signedIn(req)));
  app.post("/api/hermes/upgrade/check", async req => {
    z.object({}).strict().parse(req.body);
    return upgrades.check(signedIn(req));
  });
  app.post("/api/hermes/upgrade/install", async req => {
    const input = z.object({ candidateRevision: z.string().regex(/^[a-f0-9]{40}$/), requestId: z.string().uuid() }).strict().parse(req.body);
    return upgrades.install(signedIn(req), input);
  });
  app.post("/api/hermes/upgrade/control", async req => {
    const input = z.object({ action: z.enum(["retry", "cancel", "restart_service"]), operationId: z.string().uuid(), requestId: z.string().uuid() }).strict().parse(req.body);
    return upgrades.control(signedIn(req), input);
  });
}
