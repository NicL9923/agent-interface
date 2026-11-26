import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TopicChannel } from "../shared/channels.js";
import { mainEligible } from "../shared/main-assistant.js";
import type { Runtime } from "../shared/types.js";
import { apiRoute } from "./api-route.js";
import { signedIn } from "./auth.js";
import { visibleBots, type Roster } from "./bot-access.js";
import { httpError } from "./http-error.js";
import type { Store } from "./store.js";

export function installChannelRoutes(
  app: FastifyInstance,
  { runtime, store, roster }: { runtime: Runtime; store: Store; roster: Roster },
) {
  apiRoute(app, "GET /channels", {}, async (req) => {
    const userId = signedIn(req).id;
    const mainBotId = store.preferences(userId).mainBotId;
    if (!mainBotId) return { channels: [] satisfies TopicChannel[] };
    const bots = await visibleBots(runtime, store, userId);
    const byId = new Map(bots.map((bot) => [bot.id, bot]));
    const channels: TopicChannel[] = store.channels
      .listForOwner(userId, mainBotId)
      .flatMap((record) => {
        const bot = byId.get(record.botId);
        if (!bot) return [];
        return [
          {
            botId: record.botId,
            parentBotId: record.parentBotId,
            ownerId: record.ownerId,
            topic: record.topic,
            name: bot.name,
            description: bot.description ?? "",
            createdAt: new Date(record.createdAt).toISOString(),
          },
        ];
      });
    return { channels };
  });

  apiRoute(
    app,
    "POST /channels",
    {
      body: z
        .object({
          topic: z.string().min(1).max(60),
          description: z.string().max(400).optional(),
          instructions: z.string().max(10_000).optional(),
        })
        .strict(),
    },
    async (req, body) => {
      const userId = signedIn(req).id;
      const mainBotId = store.preferences(userId).mainBotId;
      if (!mainBotId)
        throw httpError(409, "Choose a main assistant before creating topic channels.", {
          code: "main_required",
        });
      const mainPresentation = store.presentation(mainBotId);
      if (!mainEligible(mainPresentation, userId))
        throw httpError(409, "Your main assistant must be your own personal assistant.", {
          code: "main_not_personal",
        });
      const mainDetail = runtime.botDetail
        ? await runtime.botDetail(mainBotId)
        : (await runtime.listBots()).find((item) => item.id === mainBotId);
      if (!mainDetail) throw httpError(404, "Your main assistant could not be found.");
      const topic = body.topic.trim();
      const channelName = topic.startsWith("#") ? topic : `#${topic}`;
      const description =
        body.description?.trim() || `Topic channel for ${topic} under ${mainDetail.name}.`;
      const baseInstructions = [
        `You are a focused topic channel for "${topic}", sharing personal context with ${mainDetail.name}.`,
        `Keep conversations centered on ${topic} while drawing on shared personal facts when helpful.`,
        body.instructions?.trim() || "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const created = await runtime.saveBot({
        name: channelName,
        description,
        instructions: baseInstructions,
        model: mainDetail.model,
        provider: mainDetail.provider,
        harness: mainDetail.harness,
        enabledMcpServers: mainDetail.enabledMcpServers,
        enabledTools: mainDetail.enabledTools,
        enabledSkills: mainDetail.enabledSkills,
        shared: false,
      });
      store.savePresentation(created.id, {
        shared: false,
        ownerId: userId,
        ...(mainPresentation.avatar ? { avatar: mainPresentation.avatar } : {}),
      });
      store.memory.setSharedPersonalMemoryEnabled(created.id, true);
      const record = store.channels.register({
        botId: created.id,
        parentBotId: mainBotId,
        ownerId: userId,
        topic: topic.replace(/^#+/, "").trim() || topic,
      });
      roster.forget();
      const channel: TopicChannel = {
        botId: record.botId,
        parentBotId: record.parentBotId,
        ownerId: record.ownerId,
        topic: record.topic,
        name: created.name,
        description: created.description ?? description,
        createdAt: new Date(record.createdAt).toISOString(),
      };
      return { channel, bot: { ...created, ...store.presentation(created.id) } };
    },
  );
}
