import type { FastifyInstance, FastifyRequest } from "fastify";
import { NotFound } from "../shared/errors.js";
import { queueEditBody, queueListQuery, queueReorderBody } from "../shared/queue.js";
import type { RequireCapability, Runtime } from "../shared/types.js";
import { apiRoute } from "./api-route.js";
import { Roster, notFound, visibleTo } from "./bot-access.js";
import { httpError } from "./http-error.js";
import type { Store } from "./store.js";

export function installQueueRoutes(
  app: FastifyInstance,
  {
    store,
    runtime,
    roster = new Roster(runtime, store),
    requireCapability,
  }: {
    store: Store;
    roster?: Roster;
    runtime: Pick<Runtime, "listBots">;
    requireCapability: RequireCapability;
  },
) {
  const visibleUser = (req: FastifyRequest<{ Params: { id: string } }>) => {
    const user = req.user;
    if (!user) throw httpError(401, "Sign in required", { code: "session_expired" });
    if (!visibleTo(store, req.params.id, user.id))
      throw new NotFound(notFound.error, notFound.code);
    return user;
  };
  const access = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    visibleUser(req);
    if (!(await roster.exists(req.params.id))) throw new NotFound(notFound.error, notFound.code);
  };

  apiRoute(app, "GET /bots/:id/queue", { before: access }, async (req) => {
    visibleUser(req);
    return store.queue.snapshot(req.params.id, queueListQuery.parse(req.query));
  });

  apiRoute(
    app,
    "PATCH /bots/:id/queue/:itemId",
    { before: access, body: queueEditBody },
    async (req, { text }) => {
      const user = visibleUser(req);
      const { id, itemId } = req.params;
      return store.queue.edit(id, itemId, user.id, text, {
        allowHousehold: store.presentation(id).shared !== false,
      });
    },
  );

  apiRoute(
    app,
    "POST /bots/:id/queue/:itemId/reorder",
    { before: access, body: queueReorderBody },
    async (req, body) => {
      visibleUser(req);
      return store.queue.reorder(
        req.params.id,
        req.params.itemId,
        "beforeItemId" in body ? body.beforeItemId : null,
      );
    },
  );

  apiRoute(app, "POST /bots/:id/queue/:itemId/send-now", { before: access }, async (req) => {
    await requireCapability("chat", req.params.id);
    visibleUser(req);
    return store.queue.promoteToSendNow(req.params.id, req.params.itemId);
  });

  apiRoute(app, "DELETE /bots/:id/queue/:itemId", { before: access }, async (req) => {
    visibleUser(req);
    return store.queue.cancel(req.params.id, req.params.itemId);
  });
}
