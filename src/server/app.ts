import type { ApiBody } from "../shared/api.js";
import { installAutomationRoutes } from "./automation.js";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type {
  Bot,
  Bootstrap,
  CapabilityKey,
  Preferences,
  Runtime,
  RuntimeStatus,
} from "../shared/types.js";
import { allowedIdentity, type Config } from "./config.js";
import { Store } from "./store.js";
import { installAuth, signedIn, stillSignedIn } from "./auth.js";
import { installBotAccess, redactAgents, visible, visibleTo } from "./bot-access.js";
import { BotDirectory, installBotRoutes } from "./bot-routes.js";
import { installConversationRoutes } from "./conversation-routes.js";
import { installPushRoutes } from "./push-routes.js";
import { BackgroundWorker } from "./notifications.js";
import type { ApnsSender } from "./apns.js";
import type { LiveActivitySender } from "./live-activity.js";
import { HermesUpgrades } from "./upgrades.js";
import { installIntegrationsRoutes } from "./integrations.js";
import { installVaultRoutes } from "./vault.js";
import { registerVoiceRoutes } from "./voice.js";
import { installDiscoveryRoutes } from "./discovery.js";
import { assertRoutineEditable, installExperienceRoutes } from "./experience.js";
import { installComputerRoutes } from "./computer.js";
import { installCollaborationRoutes, roomAccessible } from './collaboration.js';
import { GroupWatch } from "./group-watch.js";
import { loggerOptions } from "./logging.js";
import { errorHandler, httpError } from "./http-error.js";
import { openEventStream } from "./event-stream.js";
import { id, modelFavoriteList, preferences } from "./schemas.js";
import { apiRoute } from "./api-route.js";
import { HealthMonitor, installHealthRoutes } from "./health.js";
import { installEtags } from "./etag.js";
import { installSecurityHeaders } from "./security-headers.js";
import { installInlineUi } from "./inline-ui.js";
import { immutableCacheControl, isHashedAsset } from "./static-cache.js";
import { isApiRequest, routePattern } from "./route-path.js";
import { MAX_UPLOAD_BYTES } from "../shared/uploads.js";
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
    if ((path.startsWith("/api/bots") && !/\/(draft|read-position|presence)$/.test(path)) || path.startsWith("/api/routines") || path.startsWith("/api/groups") || path.startsWith("/api/integrations") || path === "/api/push/actions")
      return reply.code(409).send({ error: path.startsWith("/api/integrations")
        ? "Hermes is being upgraded. Try changing connections after the update finishes."
        : "Hermes is being upgraded. Your draft is saved; send it after the update finishes.", code: "hermes_maintenance" });
  });
  app.setErrorHandler(errorHandler({ production: config.production }));
  const requireCapability = async (key: CapabilityKey) => {
    const cap = (await runtime.capabilities())[key];
    if (!cap?.supported)
      throw httpError(409, cap?.reason ?? `${key} is unavailable`);
  };
  const params = (req: { params: unknown }) =>
    req.params as { id: string; approvalId?: string };
  const directory = new BotDirectory(runtime, store);
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
  const canManageIntegrations = (req: FastifyRequest) => config.localDevAuth && !config.production || Boolean(config.integrationAdmins?.includes(signedIn(req).email.toLowerCase()));
  await installIntegrationsRoutes(app, runtime, {
    origin: config.origin,
    canManage: canManageIntegrations,
  });
  await installComputerRoutes(app, config, store, runtime, () => upgrades.maintenance());
  await installExperienceRoutes(app, runtime, store, roster);
  await installAutomationRoutes(app, runtime, store, () => upgrades.maintenance(), canManageIntegrations);
  await installDiscoveryRoutes(app, runtime, store, roster);
  const collaboration = await installCollaborationRoutes(app, runtime, store, roster);
  const groups = new GroupWatch(runtime);
  await installVaultRoutes(app, runtime);
  await registerVoiceRoutes(app, runtime, { visible: (botId, userId) => visibleTo(store, botId, userId),
    redact: async (message, userId) => (await redactAgents(store, roster, userId)).message(message) });
  const dated = (status: RuntimeStatus): RuntimeStatus => {
    const revisionDate = upgrades.revisionDate(status.version);
    return revisionDate ? { ...status, revisionDate } : status;
  };
  let snapshot: Promise<Pick<Bootstrap, "bots" | "capabilities" | "connection">> | undefined;
  const runtimeSnapshot = () => {
    if (snapshot) return snapshot;
    snapshot = (async () => {
      // Share only runtime reads. Identity, preferences and CSRF remain request-scoped.
      const [bots, capabilities] = await Promise.all([
        runtime.listBots(), runtime.capabilities(),
      ]);
      return { bots: bots.map(bot => directory.decorate(bot, capabilities.avatarMetadata.supported)), capabilities, connection: dated(await runtime.status()) };
    })().finally(() => { snapshot = undefined; });
    return snapshot;
  };
  apiRoute(app, "GET /bootstrap", {}, async req => ({
    user: signedIn(req),
    household: store.users().filter((user) => allowedIdentity(config, user)),
    preferences: preferencesFor(signedIn(req).id),
    ...await runtimeSnapshot().then(async value => ({ ...value,
      bots: await directory.rosterFor(signedIn(req).id, value.bots, value.capabilities.avatarMetadata.supported,
        (req.query as { roster?: string }).roster === "lean"),
    })),
    csrfToken: req.csrfToken,
    vapidPublicKey: config.vapidPublicKey || undefined,
    nativeApp: config.nativeApp,
  }));
  apiRoute(app, "POST /connection/retry", {}, async () =>
    dated(await (runtime.reconnect ? runtime.reconnect() : runtime.status())),
  );
  apiRoute(app, "PATCH /preferences", { body: preferences }, async (req, value) => {
    const previous = store.preferences(signedIn(req).id);
    value.modelFavorites ??= previous.modelFavorites;
    value.startPage ??= previous.startPage;
    value.notifications ??= previous.notifications;
    store.savePreferences(signedIn(req).id, value);
    return value;
  });
  apiRoute(app, "PUT /preferences/models", { body: z.object({ modelFavorites: modelFavoriteList }).strict() }, async (req, { modelFavorites }) => {
    const userId = signedIn(req).id;
    store.savePreferences(userId, { ...store.preferences(userId), modelFavorites });
    return { modelFavorites };
  });
  apiRoute(app, "GET /models", {}, async req => {
    const { botId } = z.object({ botId: id.optional() }).parse(req.query);
    if (!runtime.modelOptions) throw httpError(409, "The connected Hermes installation does not expose model options.");
    return runtime.modelOptions(botId);
  });
  installBotRoutes(app, { runtime, store, roster, directory, requireCapability });
  const streams = new Set<() => void>();
  installConversationRoutes(app, { config, runtime, store, roster, streams, requireCapability });
  // Gateway frames are hints, not roster changes. Compare each viewer's visible
  // projection after one shared, cheap evaluation, at most once per second.
  const rosterListeners = new Set<(bots: Bot[], nativeAvatar: boolean) => void>();
  let rosterPending: ReturnType<typeof setTimeout> | undefined;
  let rosterEvaluating = false, rosterAgain = false, rosterLast = 0;
  let unwatchRoster: (() => void) | undefined;
  const rosterProjection = (bots: Bot[], userId: string, nativeAvatar: boolean) => JSON.stringify(
    directory.lean(bots.map(bot => directory.decorate(bot, nativeAvatar)).filter(bot => visible(bot, userId)))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
  const evaluateRoster = () => {
    if (!rosterListeners.size) return;
    if (rosterEvaluating) { rosterAgain = true; return; }
    rosterPending ??= setTimeout(() => {
      rosterPending = undefined;
      rosterEvaluating = true;
      rosterLast = Date.now();
      void Promise.all([runtime.listBots(), runtime.capabilities()]).then(([bots, capabilities]) => {
        roster.note(bots);
        for (const changed of rosterListeners) changed(bots, capabilities.avatarMetadata.supported);
      }).catch(() => { /* The fallback bootstrap retries unavailable runtime reads. */ })
        .finally(() => {
          rosterEvaluating = false;
          if (rosterAgain) { rosterAgain = false; evaluateRoster(); }
        });
    }, Math.max(0, rosterLast + 1000 - Date.now()));
  };
  app.addHook("onResponse", async (req, reply) => {
    const path = routePattern(req);
    if (req.method !== "GET" && reply.statusCode < 400 && path.startsWith("/api/bots")
      && !/\/(draft|read-position|presence|uploads)$/.test(path)) evaluateRoster();
  });
  app.addHook("preClose", async () => {
    clearTimeout(rosterPending);
    for (const end of streams) end();
  });
  // ?group=<roomId> also watches one group chat: the server polls it while any stream watches it.
  app.get("/api/events", { exposeHeadRoute: false }, async (req, reply) => {
    const { group } = z.object({ group: id.optional() }).parse(req.query);
    const userId = signedIn(req).id;
    if (group !== undefined) await collaboration.room(userId, group);
    const initial = await runtimeSnapshot();
    let projection = rosterProjection(initial.bots, signedIn(req).id, initial.capabilities.avatarMetadata.supported);
    let unwatchGroup: (() => void) | undefined;
    const stream = openEventStream(reply, streams, {
      allowed: () => stillSignedIn(store, config, req),
      teardown: () => {
        unwatchGroup?.();
        rosterListeners.delete(changed);
        if (!rosterListeners.size) {
          unwatchRoster?.();
          unwatchRoster = undefined;
          clearTimeout(rosterPending);
          rosterPending = undefined;
        }
      },
    });
    const changed = (bots: Bot[], nativeAvatar: boolean) => {
      if (!stillSignedIn(store, config, req)) { stream.end(); return; }
      const next = rosterProjection(bots, signedIn(req).id, nativeAvatar);
      if (next === projection) return;
      projection = next;
      stream.send("event: roster\ndata: roster\n\n");
    };
    rosterListeners.add(changed);
    unwatchRoster ??= runtime.watchRoster?.(evaluateRoster);
    // A room that gains someone else's private assistant ends the watch, as its routes answer 404.
    if (group !== undefined) unwatchGroup = groups.watch(group, state => {
      if (!roomAccessible(state.room, profile => visibleTo(store, profile, userId))) { stream.end(); return; }
      stream.send(`event: group\ndata: ${JSON.stringify({ roomId: group, latestSeq: state.room.latest_seq ?? 0 })}\n\n`);
    });
  });
  apiRoute(app, "GET /routines", {}, async (req) => {
    await requireCapability("routines");
    const userId = signedIn(req).id;
    return (await runtime.routines()).filter(r => visibleTo(store, r.botId, userId)).map((r) => ({
      ...r,
      recipientIds: store.getRoutineRecipients(r.id),
    }));
  });
  const routineSchema = z
      .object({
        botId: id,
        name: z.string().min(1).max(100),
        prompt: z.string().max(50000),
        schedule: z.string().min(1).max(500),
        enabled: z.boolean(),
        recipientIds: z.array(id).max(20),
        skills: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
        model: z.string().trim().max(500).nullable().optional(),
        provider: z.string().trim().max(200).nullable().optional(),
        enabledToolsets: z.array(z.string().trim().min(1).max(200)).max(100).nullable().optional(),
        script: z.string().trim().max(2000).nullable().optional(),
        noAgent: z.boolean().optional(),
        contextFrom: z.array(z.string().trim().min(1).max(200)).max(100).nullable().optional(),
      });
  const saveRoutine = async (
    input: ApiBody<"POST /routines">,
    routineId?: string,
  ) => {
    const all = routineId || input.contextFrom?.some(ref => ref !== 'self') ? await runtime.routines() : [];
    const previous = routineId ? all.find(row => row.id === routineId) : undefined;
    if (routineId && (!previous || previous.botId !== input.botId)) throw httpError(404, "Routine not found");
    // Compare against native state before forwarding updates. This also preserves
    // uneditable settings and avoids revalidating an untouched, missing script/source.
    for (const key of ['skills','model','provider','enabledToolsets','script','noAgent','contextFrom'] as const) {
      if (previous && input[key] !== undefined && JSON.stringify(input[key]) === JSON.stringify(previous[key])) delete input[key];
    }
    const effective = { ...previous, ...input };
    if (effective.noAgent && !effective.script?.trim()) throw httpError(400, "Script-only routines require a script from this assistant's scripts directory.");
    if (!effective.prompt.trim() && !effective.script?.trim() && !effective.skills?.length)
      throw httpError(400, "Add instructions, a skill, or a profile script for this routine to run.");
    // 41dfcf2c dashboard _cron_string_list converts [] to None. Do not turn a
    // deliberate zero-tool restriction into unrestricted access silently.
    if (Array.isArray(input.enabledToolsets) && input.enabledToolsets.length === 0)
      throw httpError(400, "Select at least one toolset or use profile tools. This Hermes dashboard cannot save an empty toolset allowlist.");
    if (input.contextFrom?.some(ref => ref !== 'self' && !all.some(row => row.id === ref && row.botId === input.botId)))
      throw httpError(400, "Context sources must be existing routines for this assistant.");
    if ((input.model !== undefined || input.provider !== undefined) && (effective.model || effective.provider)) {
      if (!runtime.modelOptions) throw httpError(409, "Model choices are unavailable. Keep the existing model or try again after reconnecting.");
      const catalog = await runtime.modelOptions(input.botId);
      const provider = catalog.providers.find(row => row.id === effective.provider || row.aliases?.includes(effective.provider ?? ''));
      if (!provider || !provider.authenticated || effective.model && !provider.models.some(row => row.id === effective.model && row.available))
        throw httpError(400, "Choose a model from an existing connected provider, or use the assistant's model.");
    }
    if (
      input.recipientIds.some((id) => {
        const user = store.getUser(id);
        return !user || !allowedIdentity(config, user);
      })
    )
      throw httpError(
        400,
        "Routine recipients must be signed-in household members",
      );
    // Nobody else would ever receive a private assistant's results, so do not pretend they will.
    const owner = store.presentation(input.botId);
    if (owner.shared === false && owner.ownerId && input.recipientIds.some(id => id !== owner.ownerId))
      throw httpError(400, "Only you can receive your personal assistant's routine results.", { code: "private_recipients" });
    const routine = await runtime.saveRoutine(input, routineId);
    store.routineRecipients(routine.id, input.recipientIds);
    return { ...effective, ...routine, recipientIds: input.recipientIds };
  };
  apiRoute(app, "POST /routines", { body: routineSchema, before: async () => requireCapability("routines") }, async (_, input) => saveRoutine(input));
  apiRoute(app, "PUT /routines/:id", { body: routineSchema, before: async req => { await requireCapability("routines"); await assertRoutineEditable(runtime, store, req.params.id); } }, async (req, input) => saveRoutine(input, req.params.id));
  apiRoute(app, "DELETE /routines/:id", {}, async (req) => {
    await requireCapability("routines");
    await assertRoutineEditable(runtime, store, params(req).id);
    await runtime.deleteRoutine(params(req).id);
    store.routineRecipients(params(req).id, []);
    return { ok: true };
  });
  // The worker owns the aggregate so a push and this read agree; handlers run after it exists.
  installPushRoutes(app, { config, runtime, store, live: () => worker.live });
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
    groups.close();
    health.stop();
    await worker.stop();
    await runtime.close();
    store.close();
  });
  return { app, store, worker, health, routes };
}
