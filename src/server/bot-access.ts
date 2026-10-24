import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { agentEnvelope } from "../shared/collaboration.js";
import type { Bot, Message, Runtime, ToolCall } from "../shared/types.js";
import { routePattern } from "./route-path.js";
import type { Store } from "./store.js";
declare module "fastify" { interface FastifyRequest { privacyVersion?: number; assistantId?: string } }

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

// Only a genuine signature names a file's assistant, so a forged ID naming a private one
// fails exactly like any other forged ID. A runtime without signatures, as in tests,
// falls back to the readable body.
export function fileBotId(runtime: Pick<Runtime, "fileBotId">, fileId: string) {
  if (runtime.fileBotId) { const botId = runtime.fileBotId(fileId); return typeof botId === "string" ? botId : undefined; }
  try { const botId = (JSON.parse(Buffer.from(fileId.split(".")[0], "base64url").toString()) as { botId?: unknown }).botId; return typeof botId === "string" ? botId : undefined; }
  catch { return undefined; }
}

/**
 * Body and query routes still answer a hidden ID differently from a made-up one; telling
 * them apart takes deliberate probing, a documented privacy limit.
 * The last roster Hermes reported. A route naming an assistant that is not on it answers
 * the same 404 as a hidden one, so nobody can tell a private assistant from a made-up ID.
 * An ID missing from the cached roster refreshes it first, so a new assistant is never refused.
 */
export class Roster {
  private bots?: Bot[];
  private at = 0;
  private refreshing?: Promise<void>;
  // Every name an assistant has had is stored, so an old agent message still matches after a rename or restart.
  constructor(private runtime: Pick<Runtime, "listBots">, private store?: Pick<Store, "rememberNames" | "nameHistory">) {}
  note(bots: unknown) {
    // A disconnected Hermes reports its last roster as disconnected; it proves nothing.
    if (!Array.isArray(bots) || !bots.some(bot => bot?.activity !== "disconnected")) return;
    this.bots = bots;
    this.at = Date.now();
    this.store?.rememberNames(bots as Bot[]);
  }
  /** After this app creates, renames or deletes an assistant, the next check reads Hermes again. */
  forget() { this.at = 0; }
  private refresh() {
    this.refreshing ??= (async () => { try { this.note(await this.runtime.listBots()); } catch { /* Keep the last roster. */ } })()
      .finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private fresh() { return this.bots && Date.now() - this.at < 10_000; }
  /** False only when Hermes's current roster lacks it. */
  async exists(botId: string) {
    if (this.fresh() && this.bots!.some(bot => bot.id === botId)) return true;
    if (typeof this.runtime.listBots !== "function") return true;
    await this.refresh();
    return !this.bots || this.bots.some(bot => bot.id === botId);
  }
  /** True only when Hermes's current roster has it. */
  async has(botId: string) {
    if (typeof this.runtime.listBots === "function") await this.refresh();
    return !!this.bots?.some(bot => bot.id === botId);
  }
  /** Each assistant's current and earlier names. */
  async names() {
    if (!this.fresh()) await this.refresh();
    return this.store?.nameHistory() ?? new Map((this.bots ?? []).map(bot => [bot.id, new Set([bot.name])]));
  }
}

const hiddenText = "Message from another member's assistant: This message is private.";
/**
 * Removes another member's private assistant from agent exchanges inside an assistant this
 * person can see: incoming envelopes and message_agent handoffs keep their place, not their content.
 */
export async function redactAgents(store: Store, roster: Roster, userId: string) {
  const hidden = store.privateBots().filter(bot => bot.ownerId !== userId).map(bot => bot.botId);
  if (!hidden.length) return { message: <T extends Message>(message: T) => message, call: (call: ToolCall) => call, text: (text: string) => text };
  const names = await roster.names();
  const handles = new Set(hidden), labels = new Set(hidden.flatMap(id => [id, ...names.get(id) ?? []]).map(name => name.toLowerCase()));
  const named = (value: unknown) => typeof value === "string" && (handles.has(value) || labels.has(value.toLowerCase()));
  const target = (args?: string) => { try { return (JSON.parse(args ?? "") as { target?: unknown }).target; } catch { return undefined; } };
  // Any tool detail mentioning a hidden assistant is hidden, whatever the tool, as in a combined
  // "message_agent, web_search" batch. A handoff whose target cannot be read counts as hidden too.
  // IDs and handles match exactly. Names match as whole words, ignoring case, with Unicode word
  // boundaries, however short: "Penny" hides "Penny's" but not "halfpenny". A shared tool detail
  // that happens to use the word, like "penny", is hidden too, erring toward privacy.
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const words = [...new Set(hidden.flatMap(id => [...names.get(id) ?? []]))].filter(name => name.trim())
    .map(name => new RegExp(`(?<![\\p{L}\\p{N}_])${escape(name.trim())}(?![\\p{L}\\p{N}_])`, "iu"));
  const mentions = (value?: string) => !!value && ([...handles].some(id => value.includes(id)) || words.some(word => word.test(value)));
  const handoff = (name?: string) => !!name?.split(",").some(part => part.trim() === "message_agent");
  const hides = (call: ToolCall) => mentions(call.arguments) || mentions(call.result) || mentions(call.error)
    || handoff(call.name) && (named(target(call.arguments)) || !target(call.arguments));
  const call = (call: ToolCall): ToolCall => hides(call) ? { ...call, arguments: JSON.stringify({ target: "another member's assistant" }), result: undefined, error: undefined } : call;
  return {
    message: <T extends Message>(message: T): T => {
      const envelope = agentEnvelope(message);
      const originHidden = message.origin && (named(message.origin.handle) || named(message.origin.name) || mentions(message.origin.title));
      if (originHidden || envelope && (named(envelope.handle) || named(envelope.name))) return { ...message, text: hiddenText, origin: { kind: "agent", visibility: "activity" }, files: undefined, reasoning: undefined, toolCall: undefined };
      if (message.toolCall ? hides(message.toolCall) || message.role === "tool" && mentions(message.text) : handoff(message.toolName) || message.role === "tool" && mentions(message.text))
        return { ...message, text: "", origin: message.origin ? { kind: message.origin.kind, visibility: message.origin.visibility } : undefined, files: undefined, reasoning: undefined, ...(message.toolCall ? { toolCall: call(message.toolCall) } : {}) };
      return message;
    },
    // Calls still running are listed beside the messages.
    call,
    // Search snippets and previews are fragments, so any mention of a hidden handle or name hides them.
    text: (text: string) => mentions(text) ? hiddenText : text,
  };
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
  "POST /api/auth/native/renew": "none",
  "POST /api/csp-report": "none",
  "GET /api/health": "none",
  "GET /api/health/ready": "none",
  "GET /api/bootstrap": "list",
  "GET /api/events": "none",
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
  // The aggregate holds only assistants this person sees; registration drops unseen botIds.
  "GET /api/native/live-activity": "list",
  "PUT /api/native/live-activity": "list",
  "DELETE /api/native/live-activity": "none",
  // A push-to-start token names no assistant; the worker builds rows with the same visibility as updates.
  "PUT /api/native/live-activity/start": "none",
  "DELETE /api/native/live-activity/start": "none",
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
export function installBotAccess(app: FastifyInstance, store: Store, runtime: Pick<Runtime, "routines" | "listBots" | "fileBotId">, roster = new Roster(runtime, store)) {
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
    if (!param && !scope) return;
    req.privacyVersion = store.privacyVersion;
    const botId = param ? (req.params as Record<string, string>)[param]
      : scope === "query" ? named(req.query)
      : scope === "file" ? fileBotId(runtime, (req.params as { id: string }).id) : undefined;
    req.assistantId = botId;
    if (hidden(req, botId) || param && !(await roster.exists(botId!))) return refuse(reply);
  });
  // Body and routine checks need the parsed body or the scheduler, so they run just before the handler.
  app.addHook("preHandler", async (req, reply) => {
    const scope = assistantRoutes[key(req.method, routePattern(req))];
    if (scope?.startsWith("routine")) {
      const routineId = (req.params as { id?: string }).id;
      const row = (await runtime.routines()).find(routine => routine.id === routineId);
      // A trial remembers its assistant even after its routine is deleted.
      const requestId = (req.params as { requestId?: unknown }).requestId ?? (req.body as { requestId?: unknown } | undefined)?.requestId;
      const trial = typeof requestId === "string" ? store.routineTrial(requestId) : undefined;
      // A missing routine is the handler's 404, worded the same.
      if (row && hidden(req, row.botId) || trial && hidden(req, trial.botId)) return reply.code(404).send({ error: "Routine not found" });
    }
    if (scope === "body" || scope === "routine and body") {
      req.assistantId ??= named(req.body);
      if (hidden(req, named(req.body))) return refuse(reply);
    }
  });
  // Access is decided before awaited reads. If an assistant became private to someone else
  // while this read ran, nothing it gathered may leave: its own route answers 404 and any
  // other read asks to be retried, so every list re-filters without each handler remembering.
  // Writes and streamed downloads already under way are not recalled: a documented privacy limit.
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.privacyVersion === undefined || !["GET", "HEAD"].includes(req.method) || reply.statusCode === 404) return payload;
    const changed = store.changedSince(req.privacyVersion).filter(botId => hidden(req, botId));
    if (!changed.length) return payload;
    (payload as { destroy?: () => void } | null)?.destroy?.();
    for (const header of ["ETag", "Content-Length", "Content-Disposition"]) reply.removeHeader(header);
    reply.type("application/json; charset=utf-8");
    if (req.assistantId && changed.includes(req.assistantId)) return reply.code(404), JSON.stringify(notFound);
    reply.code(503);
    return JSON.stringify({ error: "Assistants changed while this loaded. Try again.", code: "assistants_changed" });
  });
  return roster;
}
