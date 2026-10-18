import { avatarShapes, reasoningLevels, serviceTiers } from "../shared/types.js";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { z } from "zod";
import { botIdFor } from "../shared/types.js";
import type {
  Avatar,
  BotInput,
  Bootstrap,
  CapabilityKey,
  Preferences,
  Runtime,
  Submission,
} from "../shared/types.js";
import { allowedIdentity, type Config } from "./config.js";
import { Store } from "./store.js";
import { installAuth, signedIn, stillSignedIn } from "./auth.js";
import { installBotAccess, notFound, redactAgents, visible, visibleTo } from "./bot-access.js";
import { BackgroundWorker } from "./notifications.js";
import type { ApnsSender } from "./apns.js";
import type { LiveActivitySender } from "./live-activity.js";
import { HermesUpgrades } from "./upgrades.js";
import { installIntegrationsRoutes } from "./integrations.js";
import { installVaultRoutes, nameRequesters } from "./vault.js";
import { registerVoiceRoutes } from "./voice.js";
import { installDiscoveryRoutes } from "./discovery.js";
import { assertRoutineEditable, installExperienceRoutes } from "./experience.js";
import { installComputerRoutes } from "./computer.js";
import { installCollaborationRoutes } from './collaboration.js';
import { loggerOptions, RepeatFilter, safeError } from "./logging.js";
import { HealthMonitor, installHealthRoutes } from "./health.js";
import { installEtags } from "./etag.js";
import { installSecurityHeaders } from "./security-headers.js";
import { installInlineUi } from "./inline-ui.js";
import { immutableCacheControl, isHashedAsset } from "./static-cache.js";
import { isApiRequest, routePattern } from "./route-path.js";
import { formatBytes, MAX_ATTACHMENTS, MAX_DOWNLOAD_BYTES, MAX_UPLOAD_BYTES, UPLOAD_KINDS, UPLOAD_MIME_TYPES } from "../shared/uploads.js";
import { filesBefore, historyWindow, MAX_HISTORY_TURNS, windowFiles } from "../shared/history.js";
const id = z.string().min(1).max(200);
const avatar = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("geometric"),
    shape: z.enum(avatarShapes),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    eyes: z.enum(["round", "oval", "visor", "spark"]),
    accessory: z.enum(["none", "hat", "glasses"]),
    eyeWidth: z.number().min(0.6).max(1.5).optional(),
    eyeHeight: z.number().min(0.6).max(1.5).optional(),
    eyeSpacing: z.number().min(0.6).max(1.5).optional(),
  }),
  z.object({
    mode: z.literal("mascot"),
    family: z.enum(["sprout", "fox", "bear", "pumpkin", "santa", "rudolph", "turkey", "bunny"]),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    eyes: z.enum(["round", "oval", "visor", "spark"]),
    accessory: z.enum(["none", "hat", "glasses"]),
    eyeWidth: z.number().min(0.6).max(1.5).optional(),
    eyeHeight: z.number().min(0.6).max(1.5).optional(),
    eyeSpacing: z.number().min(0.6).max(1.5).optional(),
  }),
  z.object({
    mode: z.literal("portrait"),
    src: z.string().regex(/^\/api\/files\//),
    origin: z.enum(["uploaded", "generated"]),
  }),
]);
const botInput = z.object({
  confirmModel: z.boolean().optional(),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  instructions: z.string().max(50000),
  model: z.string().min(1).max(200),
  provider: z.string().min(1).max(200).optional(),
  enabledMcpServers: z.array(id).max(100).optional(),
  shared: z.boolean(),
  // Making an assistant personal hides it from everyone else, so the person confirms that.
  confirmPrivate: z.boolean().optional(),
  enabledTools: z.array(id).optional(),
  enabledSkills: z.array(id).optional(),
});
const preferenceInput = z.object({
  presentation: z.enum(["simple", "advanced"]),
  theme: z.enum(["system", "light", "dark"]),
  favorites: z.array(id).max(100),
  modelFavorites: z.array(z.object({ provider: id, model: id })).max(100).optional(),
  defaultBotId: id.optional(),
  sections: z
    .array(
      z.object({ id, name: z.string().max(100), botIds: z.array(id).max(100) }),
    )
    .max(30),
  followBots: z.array(id).max(100),
  startPage: z.enum(["today", "assistant"]).optional(),
  notifications: z.object({ timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en", {timeZone:value}); return true; } catch { return false; } }), quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), batchMinutes: z.number().int().min(0).max(60) }).refine(value => !!value.quietStart === !!value.quietEnd && (!value.quietStart || value.quietStart !== value.quietEnd), "Choose different quiet start and end times.").optional(),
});
const fileRef = z.object({
  id: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  name: z.string().max(255),
  mime: z.string().max(100),
  size: z.number().optional(),
  url: z.string().optional(),
});
const draftInput = z.object({ text: z.string().max(50000), attachments: z.array(fileRef).max(MAX_ATTACHMENTS).default([]), baseRevision: z.number().int().min(0).optional() });
function failure(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}
export async function createApp(
  config: Config,
  runtime: Runtime,
  options: {
    store?: Store;
    background?: boolean;
    verifyGoogle?: Parameters<typeof installAuth>[3];
    sendApns?: ApnsSender;
    sendLiveActivity?: LiveActivitySender;
    upgrades?: HermesUpgrades;
    logStream?: { write(line: string): void };
    clientRoot?: string;
  } = {},
) {
  const store = options.store ?? new Store(config.database);
  const app = Fastify({
    ...loggerOptions(config.logLevel ?? "silent", options.logStream),
    bodyLimit: 1024 * 1024,
    trustProxy: false,
    routerOptions: { maxParamLength: 8192 },
  });
  // Every registered route, so tests can prove each one is gated rather than sample a few.
  const routes: { method: string; url: string }[] = [];
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) routes.push({ method, url: route.url });
  });
  installSecurityHeaders(app, config.origin);
  installInlineUi(app);
  installEtags(app);
  await app.register(cookie);
  await app.register(websocket, {options: {maxPayload: 256 * 1024}});
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });
  await installAuth(app, store, config, options.verifyGoogle);
  const roster = installBotAccess(app, store, runtime);
  const upgrades = options.upgrades ?? new HermesUpgrades(config, runtime);
  upgrades.visibleTo = (botId, userId) => visibleTo(store, botId, userId);
  app.addHook("onRequest", async (req, reply) => {
    if (!upgrades.maintenance() || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const path = routePattern(req);
    if ((path.startsWith("/api/bots") && !/\/(draft|read-position)$/.test(path)) || path.startsWith("/api/routines") || path.startsWith("/api/groups") || path.startsWith("/api/integrations"))
      return reply.code(409).send({ error: path.startsWith("/api/integrations")
        ? "Hermes is being upgraded. Try changing connections after the update finishes."
        : "Hermes is being upgraded. Your draft is saved; send it after the update finishes.", code: "hermes_maintenance" });
  });
  const serverErrors = new RepeatFilter();
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: "Invalid request",
        details: error.issues.map((x) => ({
          path: x.path,
          message: x.message,
        })),
      });
    const err = error as Error & {
      statusCode?: number;
      code?: string;
      confirmRequired?: boolean;
      // A 5xx whose fixed message tells the person what to do next.
      expose?: boolean;
    };
    const status = err.statusCode ?? 502;
    if (status >= 500) {
      const route = `${req.method} ${req.routeOptions.url ?? "unmatched"}`;
      const repeats = serverErrors.hit(`${route} ${status} ${err.message}`);
      if (repeats === 0) req.log.error({ error: safeError(err), route, status }, "Request failed");
      else if (repeats !== undefined) req.log.error({ route, status, error: err.message, repeats }, "Request failure repeated");
    }
    // A stream can fail after a route set file headers; the error is always JSON.
    reply.removeHeader("Content-Disposition");
    reply.removeHeader("Content-Length");
    reply.type("application/json; charset=utf-8");
    reply.code(status).send({
      error:
        err.statusCode && (err.statusCode < 500 || err.expose)
          ? err.message
          : "The Hermes operation could not be completed",
      detail: config.production ? undefined : err.message,
      code: err.code,
      confirmRequired: err.confirmRequired,
    });
  });
  const requireCapability = async (key: CapabilityKey) => {
    const cap = (await runtime.capabilities())[key];
    if (!cap?.supported)
      throw failure(409, cap?.reason ?? `${key} is unavailable`);
  };
  const params = (req: { params: unknown }) =>
    req.params as { id: string; approvalId?: string };
  const decorateBot = (
    bot: Awaited<ReturnType<Runtime["listBots"]>>[number],
    nativeAvatar = false,
  ) => ({ ...bot, ...store.presentation(bot.id),
    ...(nativeAvatar ? { avatar: bot.avatar } : {}),
  });
  // Someone else's private assistant leaves this person's lists, so their saved
  // preferences stop naming it too.
  const preferencesFor = (userId: string): Preferences => {
    const value = store.preferences(userId);
    const seen = (botId: string) => visibleTo(store, botId, userId);
    return { ...value, favorites: value.favorites.filter(seen), followBots: value.followBots.filter(seen),
      sections: value.sections.map(section => ({ ...section, botIds: section.botIds.filter(seen) })),
      defaultBotId: value.defaultBotId && seen(value.defaultBotId) ? value.defaultBotId : undefined };
  };
  app.get("/api/health", async () => ({ ok: true }));
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
  await installIntegrationsRoutes(app, runtime, {
    origin: config.origin,
    canManage: req => config.localDevAuth && !config.production || Boolean(config.integrationAdmins?.includes(signedIn(req).email.toLowerCase())),
  });
  await installComputerRoutes(app, config, store, runtime, () => upgrades.maintenance());
  await installExperienceRoutes(app, runtime, store, roster);
  await installDiscoveryRoutes(app, runtime, store, roster);
  await installCollaborationRoutes(app, runtime, store, roster);
  await installVaultRoutes(app, runtime);
  await registerVoiceRoutes(app, runtime, { visible: (botId, userId) => visibleTo(store, botId, userId),
    redact: async (message, userId) => (await redactAgents(store, roster, userId)).message(message) });
  let snapshot: Promise<Pick<Bootstrap, "bots" | "capabilities" | "connection">> | undefined;
  const runtimeSnapshot = () => {
    if (snapshot) return snapshot;
    snapshot = (async () => {
      // Share only runtime reads. Identity, preferences and CSRF remain request-scoped.
      const [bots, capabilities] = await Promise.all([
        runtime.listBots(), runtime.capabilities(),
      ]);
      return { bots: bots.map(bot => decorateBot(bot, capabilities.avatarMetadata.supported)), capabilities, connection: await runtime.status() };
    })().finally(() => { snapshot = undefined; });
    return snapshot;
  };
  app.get("/api/bootstrap", async (req) => ({
    user: signedIn(req),
    household: store.users().filter((user) => allowedIdentity(config, user)),
    preferences: preferencesFor(signedIn(req).id),
    ...await runtimeSnapshot().then(value => ({ ...value, bots: value.bots.filter(bot => visible(bot, signedIn(req).id)) })),
    csrfToken: req.csrfToken,
    vapidPublicKey: config.vapidPublicKey || undefined,
    nativeApp: config.nativeApp,
  }));
  app.post("/api/connection/retry", async () =>
    runtime.reconnect ? runtime.reconnect() : runtime.status(),
  );
  app.patch("/api/preferences", async (req) => {
    const value = preferenceInput.parse(req.body) as Preferences;
    const previous = store.preferences(signedIn(req).id);
    value.modelFavorites ??= previous.modelFavorites;
    value.startPage ??= previous.startPage;
    value.notifications ??= previous.notifications;
    store.savePreferences(signedIn(req).id, value);
    return value;
  });
  app.put("/api/preferences/models", async (req) => {
    const { modelFavorites } = z.object({
      modelFavorites: z.array(z.object({ provider: id, model: id })).max(100),
    }).strict().parse(req.body);
    const userId = signedIn(req).id;
    store.savePreferences(userId, { ...store.preferences(userId), modelFavorites });
    return { modelFavorites };
  });
  app.get("/api/bots/:id/inference", async req => {
    if (!runtime.inferenceSettings) throw failure(409, "Hermes inference controls are unavailable.");
    return runtime.inferenceSettings(params(req).id);
  });
  app.patch("/api/bots/:id/inference", async req => {
    await requireCapability("botConfiguration");
    if (!runtime.inferenceSettings) throw failure(409, "Hermes inference controls are unavailable.");
    const update = z.object({ reasoning: z.enum(reasoningLevels).optional(), speed: z.enum(serviceTiers).optional() })
      .strict().refine(value => Object.keys(value).length > 0).parse(req.body);
    return runtime.inferenceSettings(params(req).id, update);
  });
  app.get("/api/models", async (req) => {
    const { botId } = z.object({ botId: id.optional() }).parse(req.query);
    if (!runtime.modelOptions) throw failure(409, "The connected Hermes installation does not expose model options.");
    return runtime.modelOptions(botId);
  });
  app.get("/api/bots", async (req) => {
    const [bots, capabilities] = await Promise.all([runtime.listBots(), runtime.capabilities()]);
    return bots.map(bot => decorateBot(bot, capabilities.avatarMetadata.supported)).filter(bot => visible(bot, signedIn(req).id));
  });
  app.post("/api/bots", async (req) => {
    await requireCapability("botConfiguration");
    const { confirmPrivate: _, ...input } = botInput.parse(req.body);
    const next = { shared: input.shared, ownerId: input.shared ? undefined : signedIn(req).id };
    // Its sharing is recorded before Hermes creates it, so a personal one is never briefly
    // public and a recreated ID never inherits an old record. An existing assistant's is never touched.
    const id = botIdFor(input.name);
    if (id && await roster.has(id))
      throw failure(409, "An assistant with this name already exists. Choose another name.");
    const prior = id ? store.presentation(id) : {};
    const version = id ? store.swapPresentation(id, prior, next) : false;
    let bot;
    try { bot = await runtime.saveBot(input as BotInput); }
    catch (error) {
      // Hermes may have created the profile and then failed to remove it; it stays the creator's.
      const created = (error as { createdBotId?: unknown }).createdBotId;
      if (typeof created === "string") {
        if (created !== id) { if (version !== false) store.restorePresentation(id, version, prior); store.savePresentation(created, next); }
        roster.forget();
        throw Object.assign(failure(502, `Hermes created ${input.name} but could not finish setting it up. It exists${input.shared ? "" : " and stays your personal assistant"}; review it in its settings.`), { expose: true, code: "created_incomplete" });
      }
      if (version !== false) store.restorePresentation(id, version, prior);
      throw error;
    }
    roster.forget();
    // A runtime that names it differently still gets its record.
    if (bot.id !== id) { if (version !== false) store.restorePresentation(id, version, prior); store.savePresentation(bot.id, next); }
    return decorateBot(bot, (await runtime.capabilities()).avatarMetadata.supported);
  });
  app.get("/api/bots/:id", async req => {
    const botId=params(req).id;
    const value=runtime.botDetail ? await runtime.botDetail(botId) : (await runtime.listBots()).find(bot=>bot.id===botId);
    if(!value)throw failure(404,"Bot not found");
    return decorateBot(value,(await runtime.capabilities()).avatarMetadata.supported);
  });
  app.patch("/api/bots/:id", async (req) => {
    await requireCapability("botConfiguration");
    const { confirmPrivate, ...input } = botInput.parse(req.body);
    // Only its owner reaches a private assistant, so a personal one always belongs to the
    // person saving it. Claiming one everyone could see hides it from them, so it needs a yes.
    const id = params(req).id, userId = signedIn(req).id;
    const previous = store.presentation(id);
    // Another member may have made it theirs since this request was let in.
    if (!visible(previous, userId)) throw Object.assign(failure(404, notFound.error), { code: notFound.code });
    if (!input.shared && !(previous.shared === false && previous.ownerId) && !confirmPrivate)
      throw Object.assign(failure(409, "Confirm making this assistant personal. It will disappear for the rest of the household."), { code: "private_confirmation_required" });
    // Claim the new sharing before Hermes changes anything, and only if nobody changed it first.
    const next = { shared: input.shared, ownerId: input.shared ? undefined : userId };
    const version = store.swapPresentation(id, previous, next);
    if (version === false)
      throw Object.assign(failure(409, "Someone changed who can see this assistant while you were saving. Review it and try again."), { code: "sharing_changed" });
    let bot;
    // A failed save puts sharing back only if no later save has changed it since.
    try { bot = await runtime.saveBot(input as BotInput, id); }
    catch (error) { store.restorePresentation(id, version, previous); throw error; }
    roster.forget();
    return decorateBot(bot, (await runtime.capabilities()).avatarMetadata.supported);
  });
  app.delete("/api/bots/:id", async (req) => {
    await requireCapability("botConfiguration");
    await runtime.deleteBot(params(req).id);
    // A new assistant that reuses this ID starts with no owner, visibility or per-person state.
    store.forgetBot(params(req).id);
    roster.forget();
    return { ok: true };
  });
  app.put("/api/bots/:id/avatar", async (req) => {
    const value = avatar.parse(req.body) as Avatar;
    const bot = (await runtime.listBots()).find((b) => b.id === params(req).id);
    if (!bot) throw failure(404, "Bot not found");
    if (
      (await runtime.capabilities()).avatarMetadata?.supported &&
      runtime.setAvatar
    )
      await runtime.setAvatar(bot.id, value);
    store.saveAvatar(bot.id, value, bot.shared);
    return value;
  });
  app.post("/api/bots/:id/portrait", async (req) => {
    await requireCapability("portraitGeneration");
    const prompt = z
      .object({ prompt: z.string().min(1).max(2000) })
      .parse(req.body);
    return runtime.generatePortrait(params(req).id, prompt.prompt);
  });
  app.get("/api/bots/:id/conversation", async (req) => {
    // Without a window, as for the native app, the whole history is returned.
    const window = z.object({
      start: z.string().min(1).max(512).optional(),
      turns: z.coerce.number().int().min(0).max(MAX_HISTORY_TURNS).optional(),
    }).parse(req.query);
    const windowed = window.start !== undefined || window.turns !== undefined;
    const { window: cut, ...result } = await runtime.conversation(params(req).id, windowed ? { window } : undefined);
    // Attribution augments the canonical Hermes history, never stores a transcript.
    const redact = await redactAgents(store, roster, signedIn(req).id);
    if (result.toolCalls) result.toolCalls = result.toolCalls.map(redact.call);
    // A runtime that already cut the window adds only the earlier messages still needed for files.
    const context = cut?.context ?? [];
    const read = [...context, ...result.messages];
    const originalFileIds = new Set(read.flatMap(message => message.files ?? []).map(file => file.id));
    const shown = read.map((message) => {
      const attribution =
        store.submissionForMessage(params(req).id, message.id) ??
        store.submission(message.id);
      const user = attribution
        ? store.getUser(attribution.input.senderId)
        : undefined;
      return user
        ? { ...message, origin: undefined, sender: { id: user.id, name: user.name } }
        : message;
    }).map(redact.message);
    result.attention = nameRequesters(result.attention, userId => store.getUser(userId)?.name);
    const visibleFileIds = new Set(shown.flatMap(message => message.files ?? []).map(file => file.id));
    result.files = result.files?.filter(file => !originalFileIds.has(file.id) || visibleFileIds.has(file.id));
    let earlier: number | undefined, earlierFiles: number | undefined;
    result.messages = shown.slice(context.length);
    if (cut) {
      earlier = cut.earlier;
      // Signed file references scale with the window too. The rest load on demand.
      ({ files: result.files, earlierFiles } = windowFiles(shown, context.length, result.files));
    } else if (windowed) {
      ({ messages: result.messages, earlier } = historyWindow(shown, window));
      ({ files: result.files, earlierFiles } = windowFiles(shown, earlier, result.files));
    }
    return {
      ...result,
      ...(earlier !== undefined ? { earlier, earlierFiles } : {}),
      draft: store.draft(signedIn(req).id, params(req).id),
      readPosition: store.personal(
        "read_positions",
        signedIn(req).id,
        params(req).id,
      ),
    };
  });
  // Files of the history before a window, for the artifacts list.
  app.get("/api/bots/:id/files", async (req) => {
    const { before } = z.object({ before: z.string().min(1).max(512).optional() }).parse(req.query);
    const redact = await redactAgents(store, roster, signedIn(req).id);
    return filesBefore((await runtime.conversation(params(req).id)).messages.map(redact.message), before);
  });
  // Change notices for one conversation, so open chats refetch instead of polling. Sign-in
  // and assistant access are the conversation read's own hooks; each notice rechecks the session.
  const watchers = new Map<string, Set<() => void>>();
  const streams = new Set<() => void>();
  // The app's own conversation writes notify at once, before Hermes reports their effect.
  const conversationWrites = new Set(["messages", "steer", "stop", "requests/:approvalId", "approvals/:approvalId", "secure-requests/:requestId"]
    .map(path => `POST /api/bots/:id/${path}`));
  const rosterListeners = new Set<() => void>();
  app.addHook("onResponse", async (req, reply) => {
    if(req.method!=="GET"&&reply.statusCode<400)for(const changed of rosterListeners)changed();
    if (reply.statusCode < 400 && conversationWrites.has(`${req.method} ${routePattern(req)}`))
      for (const changed of watchers.get(params(req).id) ?? []) changed();
  });
  app.addHook("preClose", async () => { for (const end of streams) end(); });
  app.get("/api/events", {exposeHeadRoute:false}, async (req,reply) => {
    reply.hijack();
    const response=reply.raw;
    response.writeHead(200,{...reply.getHeaders() as Record<string,string>,"Content-Type":"text/event-stream; charset=utf-8","Content-Encoding":"identity","X-Accel-Buffering":"no","Connection":"close"});
    let ended=false,last=0,pending:ReturnType<typeof setTimeout>|undefined;
    const send=(text:string)=>{if(!stillSignedIn(store,config,req))end();else if(!ended)response.write(text);};
    const changed=()=>{pending??=setTimeout(()=>{pending=undefined;last=Date.now();send("event: roster\ndata: roster\n\n");},Math.max(0,last+1000-Date.now()));};
    const unwatch=runtime.watchRoster?.(changed);
    rosterListeners.add(changed);
    const heartbeat=setInterval(()=>send("event: ping\ndata: ping\n\n"),25_000);
    function end(){if(ended)return;ended=true;unwatch?.();rosterListeners.delete(changed);clearTimeout(pending);clearInterval(heartbeat);streams.delete(end);response.end();}
    streams.add(end);response.on("close",end);response.write("retry: 3000\n\n");changed();
  });
  app.get("/api/bots/:id/events", { exposeHeadRoute: false }, async (req, reply) => {
    const botId = id.parse(params(req).id);
    const optedIn = (req.query as {inflight?: string}).inflight === "1";
    let redact = optedIn ? await redactAgents(store, roster, signedIn(req).id) : undefined;
    let hidden = JSON.stringify(store.privateBots());
    reply.hijack();
    const response = reply.raw;
    // A hijacked reply writes its own headers, so the hooks' security headers are copied over.
    response.writeHead(200, {
      ...reply.getHeaders() as Record<string, string | number | string[]>,
      "Content-Type": "text/event-stream; charset=utf-8",
      // Caddy's encode handler would hold notices in its compressor; it skips an encoded body.
      "Content-Encoding": "identity",
      "X-Accel-Buffering": "no",
      // An ended stream's connection is never reused, so shutdown need not wait for it.
      "Connection": "close",
    });
    let last = 0, ended = false, pending: ReturnType<typeof setTimeout> | undefined;
    const send = (text: string) => {
      // Ends, sending nothing more, once the person signs out or the assistant becomes someone else's.
      if (!stillSignedIn(store, config, req) || !visibleTo(store, botId, req.user?.id)) end();
      else if (!ended) response.write(text);
    };
    // A streamed reply changes on every token. Notices go at most once a second.
    const changed = () => {
      pending ??= setTimeout(() => { pending = undefined; last = Date.now(); send("data: change\n\n"); },
        Math.max(0, last + 1000 - Date.now()));
    };
    let livePending: ReturnType<typeof setTimeout> | undefined, liveLast = 0;
    const notice = (kind?: "inflight") => {
      if (!optedIn || kind !== "inflight") {
        clearTimeout(livePending); livePending = undefined;
        if (optedIn) void redactAgents(store, roster, signedIn(req).id).then(value => { redact = value; });
        changed(); return;
      }
      livePending ??= setTimeout(() => {
        livePending = undefined; liveLast = Date.now();
        void (async () => {
          // Privacy can change through another assistant's settings while this stream stays open.
          const next = JSON.stringify(store.privateBots());
          if (next !== hidden) { redact = await redactAgents(store, roster, signedIn(req).id); hidden = next; }
          const value = runtime.inflight?.(botId);
          if (!value || !redact) { changed(); return; }
          send(`event: inflight\ndata: ${JSON.stringify({...value,message:redact.message(value.message),toolCalls:value.toolCalls.map(redact.call)})}\n\n`);
        })().catch(() => changed());
      }, Math.max(0, liveLast + 250 - Date.now()));
    };
    const listeners = watchers.get(botId) ?? new Set();
    watchers.set(botId, listeners.add(changed));
    const unwatch = runtime.watch?.(botId, notice);
    // Pings keep proxies from closing a quiet stream and let the client notice a dead one.
    const heartbeat = setInterval(() => send("event: ping\ndata: ping\n\n"), 25_000);
    function end() {
      if (ended) return;
      ended = true;
      unwatch?.();
      listeners.delete(changed);
      if (!listeners.size && watchers.get(botId) === listeners) watchers.delete(botId);
      clearTimeout(pending);
      clearTimeout(livePending);
      clearInterval(heartbeat);
      streams.delete(end);
      response.end();
    }
    streams.add(end);
    response.on("close", end);
    response.write("retry: 3000\n\n");
    if (optedIn) changed();
  });
  const submit = async (req: FastifyRequest, explicitSteering = false) => {
    const body = z
      .object({
        requestId: z.string().uuid(),
        text: z.string().max(50000),
        attachments: z.array(fileRef).max(MAX_ATTACHMENTS).default([]),
        reviewedInterruption: z.boolean().default(false),
        reviewedUncertain: z.boolean().default(false),
        draftBaseRevision: z.number().int().min(0).optional(),
      })
      .refine((v) => !!v.text.trim() || !!v.attachments.length, {
        message: "Message cannot be empty",
      })
      .parse(req.body);
    const { reviewedInterruption, reviewedUncertain, ...message } = body;
    const input: Submission = {
      ...message,
      botId: params(req).id,
      senderId: signedIn(req).id,
    };
    const previous = store.submission(input.requestId);
    const interruptionRejected=previous?.receipt.status==='rejected'&&previous.receipt.message==='Review the interrupted task before starting another message.';
    const retryInterruption=interruptionRejected&&reviewedInterruption;
    if (previous) {
      if (JSON.stringify(previous.input) !== JSON.stringify(input))
        throw failure(
          409,
          "This submission ID was already used for different content",
        );
      if(interruptionRejected&&!reviewedInterruption)throw failure(409,'Review the interrupted task before starting another message.');
      if (!retryInterruption && (!reviewedUncertain || previous.receipt.status !== "uncertain"))
        return previous.receipt;
      await requireCapability("idempotency");
      const known = await runtime.lookupSubmission(input.requestId);
      if (known) {
        store.receipt(known);
        return known;
      }
    } else if (reviewedUncertain) {
      await requireCapability("idempotency");
    }
    await requireCapability("chat");
    const fast = await runtime.canonicalSubmit?.() === true;
    const conversation = fast ? undefined : await runtime.conversation(input.botId, { history: false });
    if (conversation?.activity.state === "interrupted" && !reviewedInterruption)
      throw failure(
        409,
        "Review the interrupted task before starting another message.",
      );
    const steering =
      explicitSteering ||
      ["thinking", "working", "waiting", "blocked"].includes(
        conversation?.activity.state ?? "idle",
      );
    if (steering || fast) await requireCapability("steering");
    const intent = store.intent(input);
    if (!intent.created && !reviewedUncertain && !retryInterruption) return intent.receipt;
    if (conversation?.activity.runId)
      store.participate(conversation.activity.runId, input.senderId);
    try {
      const receipt = await (steering
        ? runtime.steer({ ...input, reviewedInterruption })
        : runtime.submit({ ...input, reviewedInterruption }));
      store.receipt(receipt);
      if(receipt.runId)store.participate(receipt.runId,input.senderId);
      return receipt;
    } catch (error) {
      if((error as {code?:string}).code==='interruption_pending'){
        store.receipt({requestId:input.requestId,status:'rejected',message:'Review the interrupted task before starting another message.'});
        throw failure(409,'Review the interrupted task before starting another message.');
      }
      return store.submission(input.requestId)!.receipt;
    }
  };
  app.post("/api/bots/:id/messages", async (req) => submit(req));
  app.post("/api/bots/:id/steer", async (req) => submit(req, true));
  app.get("/api/submissions/:id", async (req) => {
    const requestId = z.string().uuid().parse(params(req).id);
    const recorded = store.submission(requestId);
    // Only its sender, while they can still see the assistant, learns anything about a recorded
    // submission. An unrecorded ID is a client's own unguessable pending ID, kept checkable,
    // which lets a former sender check their own message after its assistant is deleted.
    const previous = recorded && recorded.input.senderId === signedIn(req).id && visibleTo(store, recorded.input.botId, signedIn(req).id) ? recorded : undefined;
    if (recorded && !previous) return { requestId, status: "uncertain", message: "No admission receipt was found yet. A delayed original request may still arrive. Preserve this request ID and review before retrying the same message." };
    try {
      if ((await runtime.capabilities()).idempotency.supported) {
        const receipt = await runtime.lookupSubmission(requestId);
        if (receipt) {
          if (previous) store.receipt(receipt);
          return receipt;
        }
        if (!previous)
          return {
            requestId,
            status: "uncertain",
            message:
              "No admission receipt was found yet. A delayed original request may still arrive. Preserve this request ID and review before retrying the same message.",
          };
      }
    } catch {
      /* Missing transport evidence stays uncertain, never replay. */
    }
    return (
      previous?.receipt ?? {
        requestId,
        status: "uncertain",
        message:
          "Admission cannot be verified while Hermes is unavailable. This message will not be automatically resent.",
      }
    );
  });
  app.post("/api/bots/:id/requests/:approvalId", async (req) => {
    const { answers } = z
      .object({ answers: z.record(z.string().max(200), z.string().max(10000)) })
      .parse(req.body);
    const p = params(req);
    const conversation = await runtime.conversation(p.id, { history: false });
    const attention = conversation.attention?.find(
      (x) => x.id === p.approvalId,
    );
    if (!attention || attention.kind !== "clarify")
      throw failure(
        409,
        "This request must be handled in the official Hermes interface or is no longer pending",
      );
    await runtime.answerRequest(p.id, p.approvalId!, answers);
    if (conversation.activity.runId)
      store.participate(conversation.activity.runId, signedIn(req).id);
    return { ok: true };
  });
  app.post("/api/bots/:id/stop", async (req) => {
    await requireCapability("stop");
    await runtime.stop(params(req).id);
    return { ok: true };
  });
  app.post("/api/bots/:id/approvals/:approvalId", async (req) => {
    await requireCapability("approvals");
    const { decision } = z
      .object({ decision: z.enum(["approved", "denied"]) })
      .parse(req.body);
    const p = params(req);
    const conversation = await runtime.conversation(p.id, { history: false });
    const approval = conversation.approvals.find((a) => a.id === p.approvalId);
    if (
      !approval ||
      approval.status !== "pending" ||
      store.approval(p.approvalId!) ||
      (approval.expiresAt && Date.parse(approval.expiresAt) < Date.now())
    )
      throw failure(409, "This approval is no longer pending");
    await runtime.approve(p.id, p.approvalId!, decision, signedIn(req).id);
    store.attributeApproval(p.approvalId!, p.id, signedIn(req).id, decision);
    if (conversation.activity.runId)
      store.participate(conversation.activity.runId, signedIn(req).id);
    return { ok: true };
  });
  app.get("/api/bots/:id/draft", async (req) => store.draft(signedIn(req).id, params(req).id));
  app.put("/api/bots/:id/draft", async (req, reply) => {
    const { baseRevision, ...value } = draftInput.parse(req.body);
    const result = store.saveDraft(signedIn(req).id, params(req).id, value, baseRevision);
    if (!result.saved)
      return reply.code(409).send({ error: "This draft changed on another device.", code: "draft_conflict", draft: result.draft });
    return result.draft;
  });
  app.get("/api/bots/:id/read-position", async (req) =>
    store.personal("read_positions", signedIn(req).id, params(req).id),
  );
  app.put("/api/bots/:id/read-position", async (req) => {
    const value = z
      .object({
        messageId: z.string().max(200).optional(),
        scrollTop: z.number().min(0).optional(),
      })
      .parse(req.body);
    store.savePersonal("read_positions", signedIn(req).id, params(req).id, value);
    return value;
  });
  app.post("/api/bots/:id/uploads", async (req) => {
    await requireCapability("uploads");
    const file = await req.file();
    if (!file) throw failure(400, "No file provided");
    if (!(UPLOAD_MIME_TYPES as readonly string[]).includes(file.mimetype))
      throw failure(415, `Use ${UPLOAD_KINDS}.`);
    const data = await file.toBuffer();
    if (file.file.truncated) throw failure(413, `${file.filename || "This file"} is larger than ${formatBytes(MAX_UPLOAD_BYTES)}.`);
    return runtime.upload(params(req).id, {
      name: file.filename,
      mime: file.mimetype,
      data,
    });
  });
  // Stays no-store like every API response. An id is signed over a path, not a version, so an
  // overwritten artifact keeps its URL, and a browser cache is shared by whoever signs in next.
  app.get("/api/files/:id", async (req, reply) => {
    await requireCapability("generatedFiles");
    const file = await runtime.download(params(req).id, MAX_DOWNLOAD_BYTES);
    if (file.size !== undefined) reply.header("Content-Length", file.size);
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      )
      .type(
        [
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
          "application/pdf",
          "text/plain",
        ].includes(file.mime)
          ? file.mime
          : "application/octet-stream",
      );
    // Fastify drains a HEAD response's stream, so a stalled Hermes read would outlive it.
    if (req.method === "HEAD") {
      await file.body.cancel();
      // An empty stream keeps the file's length; an empty payload would report zero.
      return reply.send(Readable.from([]));
    }
    // Stream so one large artifact never sits in this process's memory.
    // Fastify destroys this when the person disconnects, which cancels the Hermes read.
    return reply.send(Readable.fromWeb(file.body as import("node:stream/web").ReadableStream<Uint8Array>));
  });
  for (const kind of ["tools", "skills"] as const) {
    app.get(`/api/bots/:id/${kind}`, async (req) => {
      await requireCapability(kind);
      return runtime[kind](params(req).id);
    });
    app.put(`/api/bots/:id/${kind}`, async (req) => {
      await requireCapability(kind);
      const { ids } = z.object({ ids: z.array(id).max(500) }).parse(req.body);
      await (kind === "tools"
        ? runtime.setTools(params(req).id, ids)
        : runtime.setSkills(params(req).id, ids));
      return { ok: true };
    });
  }
  app.get("/api/routines", async (req) => {
    await requireCapability("routines");
    const userId = signedIn(req).id;
    return (await runtime.routines()).filter(r => visibleTo(store, r.botId, userId)).map((r) => ({
      ...r,
      recipientIds: store.getRoutineRecipients(r.id),
    }));
  });
  const saveRoutine = async (
    req: { body: unknown; params: unknown },
    routineId?: string,
  ) => {
    await requireCapability("routines");
    if (routineId) await assertRoutineEditable(runtime, store, routineId);
    const input = z
      .object({
        botId: id,
        name: z.string().min(1).max(100),
        prompt: z.string().min(1).max(50000),
        schedule: z.string().min(1).max(500),
        enabled: z.boolean(),
        recipientIds: z.array(id).max(20),
      })
      .parse(req.body);
    if (
      input.recipientIds.some((id) => {
        const user = store.getUser(id);
        return !user || !allowedIdentity(config, user);
      })
    )
      throw failure(
        400,
        "Routine recipients must be signed-in household members",
      );
    // Nobody else would ever receive a private assistant's results, so do not pretend they will.
    const owner = store.presentation(input.botId);
    if (owner.shared === false && owner.ownerId && input.recipientIds.some(id => id !== owner.ownerId))
      throw Object.assign(failure(400, "Only you can receive your personal assistant's routine results."), { code: "private_recipients" });
    const routine = await runtime.saveRoutine(input, routineId);
    store.routineRecipients(routine.id, input.recipientIds);
    return { ...routine, recipientIds: input.recipientIds };
  };
  app.post("/api/routines", async (req) => saveRoutine(req));
  app.put("/api/routines/:id", async (req) => saveRoutine(req, params(req).id));
  app.delete("/api/routines/:id", async (req) => {
    await requireCapability("routines");
    await assertRoutineEditable(runtime, store, params(req).id);
    await runtime.deleteRoutine(params(req).id);
    store.routineRecipients(params(req).id, []);
    return { ok: true };
  });
  app.post("/api/push/subscriptions/status", async (req) => {
    const { endpoint } = z.object({ endpoint: z.string().url().max(8192) }).strict().parse(req.body);
    return { registered: store.hasSubscription(signedIn(req).id, endpoint) };
  });
  app.post("/api/push/subscriptions", async (req) => {
    if (!config.vapidPublicKey)
      throw failure(409, "Web Push is not configured");
    const input = z
      .object({
        endpoint: z
          .string()
          .url()
          .refine((x) => new URL(x).protocol === "https:"),
        keys: z.object({
          p256dh: z.string().min(1).max(1000),
          auth: z.string().min(1).max(1000),
        }),
      })
      .parse(req.body);
    store.subscribe(signedIn(req).id, input);
    return { ok: true };
  });
  app.post("/api/push/test", async (req) => {
    if (!config.vapidPublicKey)
      throw failure(409, "Web Push is not configured");
    const botId = z.object({ botId: id }).parse(req.body).botId;
    const eventId = crypto.randomUUID();
    store.queueNotification(eventId, signedIn(req).id, {
      title: "WildBots test",
      body: "Push delivery is connected.",
      url: `/?bot=${encodeURIComponent(botId)}`,
      tag: eventId,
    });
    return {
      ok: true,
      detail:
        "Queued for this person only. Physical phone delivery requires installed-app verification.",
    };
  });
  app.delete("/api/push/subscriptions", async (req) => {
    const { endpoint } = z
      .object({ endpoint: z.string().url() })
      .parse(req.body);
    store.unsubscribe(signedIn(req).id, endpoint);
    return { ok: true };
  });
  const requireNativePush = (req: FastifyRequest) => {
    if (!req.nativeSessionHash) throw failure(403, "Native device registration requires native sign-in");
    if (!config.apns) throw failure(409, "Apple push notifications are not configured on this host");
    return config.apns;
  };
  app.get("/api/native/push/config", async () => ({ available: !!config.apns, environment: config.apns?.environment }));
  app.put("/api/native/push/device", async req => {
    const apns = requireNativePush(req);
    const body = z.object({ deviceId: z.string().uuid(), token: z.string().regex(/^(?:[0-9a-fA-F]{2}){16,256}$/) }).strict().parse(req.body);
    store.registerNativeDevice(signedIn(req).id, req.nativeSessionHash!, body.deviceId, body.token.toLowerCase(), apns.environment);
    return { ok: true };
  });
  app.delete("/api/native/push/device", async req => {
    if (!req.nativeSessionHash) throw failure(403, "Native device registration requires native sign-in");
    const body = z.object({ deviceId: z.string().uuid() }).strict().parse(req.body);
    store.removeNativeDevice(signedIn(req).id, body.deviceId);
    return { ok: true };
  });
  // The worker owns the aggregate so a push and this read agree; handlers run after it exists.
  app.get("/api/native/live-activity", async req => {
    if (!req.nativeSessionHash) throw failure(403, "Live Activities require native sign-in");
    const { deviceId } = z.object({ deviceId: z.string().uuid().optional() }).strict().parse(req.query);
    const userId = signedIn(req).id;
    const context = deviceId ? store.liveActivityContext(userId, req.nativeSessionHash, deviceId) : undefined;
    return { available: !!config.apns, state: await worker.live.state(userId, context, context?.lastState) };
  });
  app.put("/api/native/live-activity", async req => {
    const apns = requireNativePush(req);
    const body = z.object({ deviceId: z.string().uuid(), token: z.string().regex(/^(?:[0-9a-fA-F]{2}){16,256}$/), botIds: z.array(id).max(10).default([]) })
      .strict().parse(req.body);
    const userId = signedIn(req).id, armedAt = Date.now();
    const armed = [...new Set(body.botIds)].filter(botId => visibleTo(store, botId, userId));
    // The next worker pass replays the current state; a Hermes outage must not fail a saved registration.
    store.registerLiveActivity(userId, req.nativeSessionHash!, body.deviceId, body.token.toLowerCase(), apns.environment, armed, armedAt);
    return { ok: true };
  });
  app.delete("/api/native/live-activity", async req => {
    if (!req.nativeSessionHash) throw failure(403, "Live Activities require native sign-in");
    const body = z.object({ deviceId: z.string().uuid(), token: z.string().regex(/^(?:[0-9a-fA-F]{2}){16,256}$/) }).strict().parse(req.body);
    store.removeLiveActivity(signedIn(req).id, body.deviceId, body.token.toLowerCase());
    return { ok: true };
  });
  app.post("/api/native/push/test", async req => {
    requireNativePush(req);
    const { botId } = z.object({ botId: id }).strict().parse(req.body);
    if (!(await runtime.listBots()).some(bot => bot.id === botId)) throw failure(404, "Bot not found");
    const eventId = crypto.randomUUID();
    store.queueNotification(eventId, signedIn(req).id, { title: "WildBots test", body: "Push delivery is connected.", url: `/?bot=${encodeURIComponent(botId)}`, tag: eventId });
    return { ok: true, detail: "Queued for this person. Confirm delivery on the signed-in physical device." };
  });
  const clientRoot = options.clientRoot ?? resolve("dist/client");
  if (existsSync(clientRoot)) {
    await app.register(staticFiles, {
      root: clientRoot,
      cacheControl: true,
      maxAge: "1h",
      setHeaders: (reply, path) => {
        if (path.endsWith("index.html") || path.endsWith("sw.js"))
          reply.header("Cache-Control", "no-cache");
        else if (isHashedAsset(clientRoot, path))
          reply.header("Cache-Control", immutableCacheControl);
      },
    });
    app.setNotFoundHandler((req, reply) =>
      isApiRequest(req)
        ? reply.code(404).send({ error: "API endpoint not found" })
        : reply.type("text/html").sendFile("index.html"),
    );
  }
  const worker = new BackgroundWorker(store, runtime, config, undefined, options.sendApns, app.log, options.sendLiveActivity);
  const health = new HealthMonitor({ store, runtime, worker, config, maintenance: () => upgrades.maintenance(), log: app.log });
  installHealthRoutes(app, health);
  if (options.background !== false) {
    worker.start();
    health.start();
  }
  app.addHook("onClose", async () => {
    health.stop();
    const stopped = worker.stop();
    await runtime.close();
    await stopped;
    store.close();
  });
  return { app, store, worker, health, routes };
}
