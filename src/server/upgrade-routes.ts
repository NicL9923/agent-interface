import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { apiRoute } from "./api-route.js";
import { signedIn } from "./auth.js";
import { hermesMaintenanceSendMessage } from "../shared/errors.js";
import { routePattern } from "./route-path.js";
import type { HermesUpgrades } from "./upgrades.js";

/**
 * While Hermes upgrades, refuses writes that would reach it: assistant changes other than drafts,
 * read positions and presence, routines, group chats, connections and notification actions.
 * Install before the routes it guards.
 */
export function installMaintenanceGate(
  app: FastifyInstance,
  upgrades: Pick<HermesUpgrades, "maintenance">,
) {
  app.addHook("onRequest", async (req, reply) => {
    if (!upgrades.maintenance() || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const path = routePattern(req);
    if (
      (path.startsWith("/api/bots") && !/\/(draft|read-position|presence)$/.test(path)) ||
      path.startsWith("/api/routines") ||
      path.startsWith("/api/groups") ||
      path.startsWith("/api/integrations") ||
      path === "/api/push/actions"
    )
      return reply.code(409).send({
        error: path.startsWith("/api/integrations")
          ? "Hermes is being upgraded. Try changing connections after the update finishes."
          : hermesMaintenanceSendMessage,
        code: "hermes_maintenance",
      });
  });
}

/** Checking, installing and recovering Hermes updates. */
export function installUpgradeRoutes(app: FastifyInstance, upgrades: HermesUpgrades) {
  apiRoute(app, "GET /hermes/upgrade", {}, async (req) => upgrades.status(signedIn(req)));
  apiRoute(app, "POST /hermes/upgrade/check", { body: z.object({}).strict() }, async (req) =>
    upgrades.check(signedIn(req)),
  );
  apiRoute(
    app,
    "POST /hermes/upgrade/install",
    {
      body: z
        .object({
          candidateRevision: z.string().regex(/^[a-f0-9]{40}$/),
          requestId: z.string().uuid(),
        })
        .strict(),
    },
    async (req, input) => upgrades.install(signedIn(req), input),
  );
  apiRoute(
    app,
    "POST /hermes/upgrade/control",
    {
      body: z
        .object({
          action: z.enum(["retry", "cancel", "restart_service"]),
          operationId: z.string().uuid(),
          requestId: z.string().uuid(),
        })
        .strict(),
    },
    async (req, input) => upgrades.control(signedIn(req), input),
  );
}
