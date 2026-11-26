import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Runtime } from "../shared/types.js";
import { apiRoute } from "./api-route.js";
import { signedIn } from "./auth.js";
import { notFound, visibleBots, visibleTo } from "./bot-access.js";
import { httpError } from "./http-error.js";
import { id } from "./schemas.js";
import type { Store } from "./store.js";

export function installConfirmationRoutes(
  app: FastifyInstance,
  { runtime, store }: { runtime: Runtime; store: Store },
) {
  apiRoute(app, "GET /confirmations", {}, async (req) => {
    const userId = signedIn(req).id;
    const bots = await visibleBots(runtime, store, userId);
    const names = new Map(bots.map((bot) => [bot.id, bot.name]));
    const confirmations = store.confirmations
      .listPendingForBots(bots.map((bot) => bot.id))
      .map((item) => ({ ...item, botName: names.get(item.botId) ?? item.botId }));
    return { confirmations };
  });

  apiRoute(
    app,
    "POST /bots/:id/confirmations/:confirmationId",
    {
      body: z
        .object({
          decision: z.enum(["approved", "declined"]),
          note: z.string().max(2_000).optional(),
        })
        .strict(),
    },
    async (req, body) => {
      const userId = signedIn(req).id;
      const { id: botId, confirmationId } = z.object({ id, confirmationId: id }).parse(req.params);
      if (!visibleTo(store, botId, userId))
        throw httpError(404, notFound.error, { code: notFound.code });
      const confirmation = store.confirmations.decide(
        botId,
        confirmationId,
        body.decision,
        userId,
        body.note,
      );
      return { confirmation };
    },
  );
}
