import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DELIVERABLE_KINDS, type DeliverableItem } from "../shared/deliverables.js";
import { parseInlineDocument } from "../shared/inline-ui.js";
import { replyCardsFromText } from "../shared/reply-cards.js";
import type { Message, Runtime } from "../shared/types.js";
import { apiRoute } from "./api-route.js";
import { signedIn } from "./auth.js";
import { notFound, redactAgents, visibleBots, type Roster } from "./bot-access.js";
import { httpError } from "./http-error.js";
import { id } from "./schemas.js";
import type { Store } from "./store.js";

const INLINE_FENCE = /^(`{3,})wildbots-html[ \t]*\r?\n([\s\S]*?)^\1[ \t]*$/gm;

/** Extracts valid `wildbots-html` inline view documents from an assistant message's Markdown. */
export function inlineViewsFromText(text: string) {
  const views: ReturnType<typeof parseInlineDocument>[] = [];
  if (!text.includes("wildbots-html")) return [];
  for (const match of text.matchAll(INLINE_FENCE)) {
    const parsed = parseInlineDocument(match[2].trim());
    if (parsed) views.push(parsed);
  }
  return views.filter((item): item is NonNullable<typeof item> => item !== null);
}

/** Collects interactive views, reply cards, and generated files from a list of messages. */
export function extractDeliverables(
  botId: string,
  botName: string,
  messages: readonly Message[],
): DeliverableItem[] {
  const items: DeliverableItem[] = [];
  const seenFiles = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const views = inlineViewsFromText(message.text);
    views.forEach((doc, viewIndex) => {
      items.push({
        id: `view:${botId}:${message.id}:${viewIndex}`,
        kind: "view",
        botId,
        botName,
        messageId: message.id,
        createdAt: message.createdAt ?? null,
        title: doc.title,
        subtitle: "Interactive view",
        inlineDoc: doc,
      });
    });
    const cards = replyCardsFromText(message.text);
    for (const card of cards) {
      if (card.type === "form") continue;
      items.push({
        id: `card:${botId}:${message.id}:${card.id}`,
        kind: "card",
        botId,
        botName,
        messageId: message.id,
        createdAt: message.createdAt ?? null,
        title: card.title,
        subtitle:
          card.type === "email"
            ? card.subject || "Email draft"
            : card.type === "event"
              ? "Calendar event"
              : card.type === "itinerary"
                ? `Itinerary · ${card.items.length} items`
                : `Checklist · ${card.items.length} items`,
        card,
      });
    }
    for (const file of message.files ?? []) {
      if (seenFiles.has(file.id)) continue;
      seenFiles.add(file.id);
      items.push({
        id: `file:${botId}:${file.id}`,
        kind: "file",
        botId,
        botName,
        messageId: message.id,
        createdAt: message.createdAt ?? null,
        title: file.name,
        subtitle: file.mime,
        file,
      });
    }
  }
  return items;
}

export function installDeliverableRoutes(
  app: FastifyInstance,
  { runtime, store, roster }: { runtime: Runtime; store: Store; roster: Roster },
) {
  apiRoute(app, "GET /deliverables", {}, async (req) => {
    const userId = signedIn(req).id;
    const query = z
      .object({
        botId: id.optional(),
        kind: z.enum(["all", ...DELIVERABLE_KINDS]).optional(),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .strict()
      .parse(req.query);
    const bots = await visibleBots(runtime, store, userId);
    const selected = query.botId ? bots.filter((bot) => bot.id === query.botId) : bots;
    if (query.botId && !selected.length)
      throw httpError(404, notFound.error, { code: notFound.code });
    const redact = await redactAgents(store, roster, userId);
    const all: DeliverableItem[] = [];
    for (const bot of selected) {
      let messages: Message[] = store.transcripts.listPage(bot.id, { limit: 120 }).messages;
      if (!messages.length) {
        try {
          const conv = await runtime.conversation(bot.id, { window: { turns: 40 } });
          messages = [...(conv.window?.context ?? []), ...conv.messages];
        } catch {
          messages = [];
        }
      }
      const redacted = messages.map(redact.message);
      all.push(...extractDeliverables(bot.id, bot.name, redacted));
    }
    const needle = query.q?.trim().toLowerCase() ?? "";
    const filtered = all
      .filter((item) => {
        if (query.kind && query.kind !== "all" && item.kind !== query.kind) return false;
        if (!needle) return true;
        return (
          item.title.toLowerCase().includes(needle) ||
          (item.subtitle?.toLowerCase().includes(needle) ?? false) ||
          item.botName.toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))
      .slice(0, query.limit ?? 80);
    return { items: filtered };
  });
}
