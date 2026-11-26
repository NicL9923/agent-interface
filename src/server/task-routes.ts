import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BOT_TASK_STATUSES, TASK_STATUSES } from "../shared/tasks.js";
import type { Runtime } from "../shared/types.js";
import { apiRoute } from "./api-route.js";
import { signedIn } from "./auth.js";
import { notFound, visibleBots, visibleTo } from "./bot-access.js";
import { httpError } from "./http-error.js";
import { id } from "./schemas.js";
import type { Store } from "./store.js";

export function installTaskRoutes(
  app: FastifyInstance,
  { runtime, store }: { runtime: Runtime; store: Store },
) {
  apiRoute(app, "GET /tasks", {}, async (req) => {
    const userId = signedIn(req).id;
    const query = z
      .object({
        botId: id.optional(),
        status: z.enum(["open", ...TASK_STATUSES]).optional(),
      })
      .strict()
      .parse(req.query);
    const bots = await visibleBots(runtime, store, userId);
    const names = new Map(bots.map((bot) => [bot.id, bot.name]));
    const allowedIds = query.botId
      ? bots.some((bot) => bot.id === query.botId)
        ? [query.botId]
        : []
      : bots.map((bot) => bot.id);
    if (query.botId && !allowedIds.length)
      throw httpError(404, notFound.error, { code: notFound.code });
    const tasks = store.tasks
      .listForBots(allowedIds, { status: query.status })
      .map((task) => ({ ...task, botName: names.get(task.botId) ?? task.botId }));
    return { tasks };
  });

  apiRoute(
    app,
    "POST /tasks",
    {
      body: z
        .object({
          botId: id,
          title: z.string().min(1).max(200),
          notes: z.string().max(10_000).optional(),
          status: z.enum(BOT_TASK_STATUSES).optional(),
        })
        .strict(),
    },
    async (req, body) => {
      const userId = signedIn(req).id;
      const bots = await visibleBots(runtime, store, userId);
      const bot = bots.find((item) => item.id === body.botId);
      if (!bot) throw httpError(404, notFound.error, { code: notFound.code });
      const task = store.tasks.create({
        botId: bot.id,
        title: body.title,
        notes: body.notes,
        status: body.status,
        createdBy: `user:${userId}`,
      });
      return { task: { ...task, botName: bot.name } };
    },
  );

  apiRoute(
    app,
    "PATCH /tasks/:id",
    {
      body: z
        .object({
          title: z.string().min(1).max(200).optional(),
          notes: z.string().max(10_000).optional(),
          status: z.enum(TASK_STATUSES).optional(),
          summary: z.string().max(4_000).nullable().optional(),
          feedback: z.string().max(4_000).optional(),
        })
        .strict(),
    },
    async (req, body) => {
      const userId = signedIn(req).id;
      const taskId = z.object({ id }).parse(req.params).id;
      const existing = store.tasks.get(taskId);
      if (!existing || !visibleTo(store, existing.botId, userId))
        throw httpError(404, "Task not found.");
      const updated = store.tasks.update(taskId, body, {
        id: `user:${userId}`,
        allowComplete: true,
      });
      const bots = await visibleBots(runtime, store, userId);
      const botName = bots.find((item) => item.id === updated.botId)?.name ?? updated.botId;
      return { task: { ...updated, botName } };
    },
  );

  apiRoute(app, "DELETE /tasks/:id", {}, async (req) => {
    const userId = signedIn(req).id;
    const taskId = z.object({ id }).parse(req.params).id;
    const existing = store.tasks.get(taskId);
    if (!existing || !visibleTo(store, existing.botId, userId))
      throw httpError(404, "Task not found.");
    store.tasks.delete(taskId);
    return { ok: true as const };
  });
}
