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
import { eventStreamConnection, type EventStream } from "./event-stream.js";
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
  // Runtime reads shared by every bootstrap and event stream. A roster notice sends every open
  // client here within a few milliseconds, and polls and focus events arrive in clusters across
  // household devices, so a resolved read is reused briefly. 1.5 s is longer than the roster
  // stream's 1 s evaluation floor, so a read refreshed by one evaluation outlives the bootstraps
  // it triggers, and it is the longest a disconnect can go unreported to a fresh bootstrap.
  const SNAPSHOT_TTL_MS = 1500;
  type RuntimeSnapshot = Pick<Bootstrap, "bots" | "capabilities" | "connection">;
  let snapshotRead: Promise<RuntimeSnapshot> | undefined;
  let snapshotKept: { value: RuntimeSnapshot; at: number } | undefined;
  // Counts invalidations, so a read that began before one is never kept.
  let snapshotEpoch = 0;
  /**
   * Keeps a read only while the runtime is connected and answering, so an outage is never served
   * from memory: Hermes reports a failed roster read as disconnected rows, and a lost socket as
   * a disconnected status. Either replaces what was kept, so the outage shows at once.
   */
  const keepSnapshot = (value: RuntimeSnapshot, startedAt: number, epoch: number) => {
    if (epoch !== snapshotEpoch) return;
    snapshotKept = value.connection.connected && !value.bots.some(bot => bot.activity === "disconnected") ? { value, at: startedAt } : undefined;
  };
  /** Forgets the snapshot after this app changed runtime state, so the next read sees the change. */
  const invalidateSnapshot = () => { snapshotEpoch++; snapshotKept = undefined; snapshotRead = undefined; };
  const runtimeSnapshot = (): Promise<RuntimeSnapshot> => {
    if (snapshotKept && Date.now() - snapshotKept.at < SNAPSHOT_TTL_MS) return Promise.resolve(snapshotKept.value);
    if (snapshotRead) return snapshotRead;
    const startedAt = Date.now(), epoch = snapshotEpoch;
    // Share only runtime reads, undecorated: presentation, identity, preferences and CSRF stay request-scoped.
    const read: Promise<RuntimeSnapshot> = (async () => {
      const [bots, capabilities] = await Promise.all([runtime.listBots(), runtime.capabilities()]);
      return { bots, capabilities, connection: await runtime.status() };
    })();
    snapshotRead = read;
    // A rejected read is never kept: the next caller reads again.
    read.then(value => { if (snapshotRead === read) snapshotRead = undefined; keepSnapshot(value, startedAt, epoch); },
      () => { if (snapshotRead === read) snapshotRead = undefined; });
    return read;
  };
  apiRoute(app, "GET /bootstrap", {}, async req => ({
    user: signedIn(req),
    household: store.users().filter((user) => allowedIdentity(config, user)),
    preferences: preferencesFor(signedIn(req).id),
    ...await runtimeSnapshot().then(async value => ({ ...value, connection: dated(value.connection),
      bots: await directory.rosterFor(signedIn(req).id, value.bots, value.capabilities.avatarMetadata.supported,
        (req.query as { roster?: string }).roster === "lean"),
    })),
    csrfToken: req.csrfToken,
    vapidPublicKey: config.vapidPublicKey || undefined,
    nativeApp: config.nativeApp,
  }));
  apiRoute(app, "POST /connection/retry", {}, async () => {
    invalidateSnapshot();
    const status = dated(await (runtime.reconnect ? runtime.reconnect() : runtime.status()));
    invalidateSnapshot();
    return status;
  });
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
      const startedAt = Date.now(), epoch = snapshotEpoch;
      void Promise.all([runtime.listBots(), runtime.capabilities(), runtime.status().catch(() => undefined)]).then(([bots, capabilities, status]) => {
        roster.note(bots);
        // The bootstrap each client sends on the notice below reuses this read.
        if (status) keepSnapshot({ bots, capabilities, connection: status }, startedAt, epoch);
        for (const changed of rosterListeners) changed(bots, capabilities.avatarMetadata.supported);
      }).catch(() => { /* The fallback bootstrap retries unavailable runtime reads. */ })
        .finally(() => {
          rosterEvaluating = false;
          if (rosterAgain) { rosterAgain = false; evaluateRoster(); }
        });
    }, Math.max(0, rosterLast + 1000 - Date.now()));
  };
  // Writes to assistants that can change the roster. Drafts, read positions, presence and uploads
  // touch only this app's own state.
  const changesRoster = (path: string) => path.startsWith("/api/bots") && !/\/(draft|read-position|presence|uploads)$/.test(path);
  // The next bootstrap must show what this app just changed, whether or not the write succeeded:
  // a failed create or save may still have reached Hermes. Dropped before the response is sent,
  // so a client's very next read cannot find the old snapshot. Upgrades, connections, routines
  // and notification actions change runtime state too.
  app.addHook("onSend", async (req, _reply, payload) => {
    const path = routePattern(req);
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)
      && (changesRoster(path) || /^\/api\/(hermes|integrations|routines|push\/actions)(\/|$)/.test(path))) invalidateSnapshot();
    return payload;
  });
  app.addHook("onResponse", async (req, reply) => {
    if (req.method !== "GET" && reply.statusCode < 400 && changesRoster(routePattern(req))) evaluateRoster();
  });
  app.addHook("preClose", async () => {
    clearTimeout(rosterPending);
    for (const end of streams) end();
  });
  // ?group=<roomId> also watches one group chat: the server polls it while any stream watches it.
  app.get("/api/events", { exposeHeadRoute: false }, async (req, reply) => {
    // Followed before the first await, so a client that leaves during setup never holds a watch.
    const connection = eventStreamConnection(reply);
    const { group } = z.object({ group: id.optional() }).parse(req.query);
    const userId = signedIn(req).id;
    if (group !== undefined) await collaboration.room(userId, group);
    if (connection.closed) return connection.abandon();
    const initial = await runtimeSnapshot();
    if (connection.closed) return connection.abandon();
    let projection = rosterProjection(initial.bots, signedIn(req).id, initial.capabilities.avatarMetadata.supported);
    let stream: EventStream | undefined;
    // Admitted before the stream opens, so a refused watch answers 429 instead of a silent stream.
    // A room that gains someone else's private assistant ends the watch, as its routes answer 404.
    const unwatchGroup = group === undefined ? undefined : groups.watch(group, userId, state => {
      if (!roomAccessible(state.room, profile => visibleTo(store, profile, userId))) { stream?.end(); return; }
      stream?.send(`event: group\ndata: ${JSON.stringify({ roomId: group, latestSeq: state.room.latest_seq ?? 0 })}\n\n`);
    });
    const changed = (bots: Bot[], nativeAvatar: boolean) => {
      if (!stillSignedIn(store, config, req)) { stream?.end(); return; }
      const next = rosterProjection(bots, signedIn(req).id, nativeAvatar);
      if (next === projection) return;
      projection = next;
      stream?.send("event: roster\ndata: roster\n\n");
    };
    const teardown = () => {
      unwatchGroup?.();
      rosterListeners.delete(changed);
      if (!rosterListeners.size) {
        unwatchRoster?.();
        unwatchRoster = undefined;
        clearTimeout(rosterPending);
        rosterPending = undefined;
      }
    };
    // Nothing it reserved outlives a setup that failed.
    stream = connection.open(streams, {
      reserve: () => {
        rosterListeners.add(changed);
        unwatchRoster ??= runtime.watchRoster?.(evaluateRoster);
      },
      allowed: () => stillSignedIn(store, config, req),
      teardown,
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
        if (path.endsWith("index.html") || path.endsWith("native-computer.html") || path.endsWith("sw.js"))
          reply.header("Cache-Control", "no-cache");
        else if (isHashedAsset(clientRoot, path))
          reply.header("Cache-Control", immutableCacheControl);
      },
    });
    // The iOS app's shared desktop viewer. It holds nothing private: the app hands it a ticket in the hash.
    app.get("/native/computer", (_req, reply) => reply.sendFile("native-computer.html"));
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
