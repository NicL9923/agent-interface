import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CapabilityKey, Runtime } from "../shared/types.js";
import type { Config } from "./config.js";
import { Store } from "./store.js";
import { installAuth, signedIn } from "./auth.js";
import { installBotAccess, redactAgents, visibleTo } from "./bot-access.js";
import { BotDirectory, installBotRoutes } from "./bot-routes.js";
import { installConversationRoutes } from "./conversation-routes.js";
import { installPushRoutes } from "./push-routes.js";
import { BackgroundWorker } from "./notifications.js";
import type { ApnsSender } from "./apns.js";
import type { LiveActivitySender } from "./live-activity.js";
import { HermesUpgrades } from "./upgrades.js";
import { installMaintenanceGate, installUpgradeRoutes } from "./upgrade-routes.js";
import { installIntegrationsRoutes } from "./integrations.js";
import { installVaultRoutes } from "./vault.js";
import { registerVoiceRoutes } from "./voice.js";
import { installTalkRoutes } from "./talk.js";
import { installDiscoveryRoutes } from "./discovery.js";
import { installAccountUsageRoutes } from "./account-usage.js";
import { installExperienceRoutes } from "./experience.js";
import { installAutomationRoutes } from "./automation.js";
import { installComputerRoutes } from "./computer.js";
import { installMacLink, MAX_FRAME } from "./mac-link.js";
import { installTerminalRequestRoutes } from "./terminal-requests.js";
import { installCollaborationRoutes } from "./collaboration.js";
import { installRoutineRoutes } from "./routine-routes.js";
import { installBootstrapRoutes, visiblePreferences } from "./bootstrap-routes.js";
import { installMainAssistantRoutes, MainAssistants } from "./main-assistant.js";
import { installClientErrorRoutes } from "./client-errors.js";
import { installEventRoutes } from "./event-routes.js";
import { installSnapshotInvalidation, runtimeSnapshots } from "./runtime-snapshot.js";
import { GroupWatch } from "./group-watch.js";
import { GroupCatalogWatch } from "./group-catalog-watch.js";
import { loggerOptions } from "./logging.js";
import { errorHandler, httpError } from "./http-error.js";
import { defaultMetadataProbe, HealthMonitor, installHealthRoutes, type MetadataProbe } from "./health.js";
import { installEtags } from "./etag.js";
import { installSecurityHeaders } from "./security-headers.js";
import { installInlineUi } from "./inline-ui.js";
import { immutableCacheControl, isHashedAsset, isPreviousAsset, mustRevalidate, previousAssetFile, readPreviousAssets } from "./static-cache.js";
import { isApiRequest } from "./route-path.js";
import { MAX_UPLOAD_BYTES } from "../shared/uploads.js";
import { DirectRoutes, installDirectRouteGate, loadDirectIdentity, type DirectAddress } from "./direct-routes.js";
import { apiRoute } from "./api-route.js";
import { installShutdown } from "./shutdown.js";

/**
 * Builds the app: plugins and hooks, the collaborators routes share, each route group's install,
 * the built client and the background work. Route groups live in their own modules.
 */
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
    /** The file the deploy tooling writes to name the previous release's assets; tests name theirs. Without a clientRoot it is dist/previous-release.json. */
    previousRelease?: string;
    metadataProbe?: MetadataProbe;
    /** Replaces interface discovery for direct routes, so tests choose the addresses. */
    directAddresses?: () => DirectAddress[];
  } = {},
) {
  const store = options.store ?? new Store(config.database);
  const app = Fastify({
    ...loggerOptions(config.logLevel ?? "silent", options.logStream),
    bodyLimit: 1024 * 1024,
    trustProxy: false,
    routerOptions: { maxParamLength: 8192 },
  });
  installShutdown(app);
  // Every registered route, so tests can prove each one is gated rather than sample a few.
  const routes: { method: string; url: string }[] = [];
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) routes.push({ method, url: route.url });
  });
  // Before authentication, so a direct listener refuses anything but the native bearer API first.
  installDirectRouteGate(app);
  installSecurityHeaders(app, config.origin);
  installInlineUi(app);
  installEtags(app);
  await app.register(cookie);
  // Large enough for a linked Mac's file read or screenshot. Every other socket refuses frames over
  // 256 KiB itself; see socketFrameLimit.
  await app.register(websocket, {options: {maxPayload: MAX_FRAME}});
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });
  await installAuth(app, store, config, options.verifyGoogle);
  const roster = installBotAccess(app, store, runtime);
  const upgrades = options.upgrades ?? new HermesUpgrades(config, runtime);
  upgrades.visibleTo = (botId, userId) => visibleTo(store, botId, userId);
  installMaintenanceGate(app, upgrades);
  app.setErrorHandler(errorHandler({ production: config.production }));
  const requireCapability = async (key: CapabilityKey) => {
    const cap = (await runtime.capabilities())[key];
    if (!cap?.supported)
      throw httpError(409, cap?.reason ?? `${key} is unavailable`);
  };
  const directory = new BotDirectory(runtime, store);
  app.get("/api/health", async () => ({ ok: true }));
  // Listeners open in start(), after the primary origin listens; until then the app is told of none.
  const directRoutes = config.directRoutes && new DirectRoutes(
    config.directRoutes, loadDirectIdentity(config.directRoutes.stateDirectory, app.log),
    (req, res) => app.routing(req, res), app.log, options.directAddresses);
  apiRoute(app, "GET /native/routes", {}, async () => ({ routes: directRoutes?.routes() ?? [] }));
  installClientErrorRoutes(app);
  installUpgradeRoutes(app, upgrades);
  const canManageIntegrations = (req: FastifyRequest) => config.localDevAuth && !config.production || Boolean(config.integrationAdmins?.includes(signedIn(req).email.toLowerCase()));
  await installIntegrationsRoutes(app, runtime, {
    origin: config.origin,
    canManage: canManageIntegrations,
  });
  await installComputerRoutes(app, config, store, runtime, () => upgrades.maintenance());
  await installTerminalRequestRoutes(app, config, store, runtime);
  installMacLink(app, config, store);
  await installExperienceRoutes(app, runtime, store, roster);
  await installAutomationRoutes(app, runtime, store, () => upgrades.maintenance(), canManageIntegrations);
  await installDiscoveryRoutes(app, runtime, store, roster);
  await installAccountUsageRoutes(app, runtime, store);
  const collaboration = await installCollaborationRoutes(app, runtime, store, roster);
  const groups = new GroupWatch(runtime);
  const catalogs = collaboration.catalogRead && new GroupCatalogWatch(collaboration.catalogRead);
  await installVaultRoutes(app, runtime);
  await registerVoiceRoutes(app, runtime, { visible: (botId, userId) => visibleTo(store, botId, userId),
    redact: async (message, userId) => (await redactAgents(store, roster, userId)).message(message) });
  const snapshot = runtimeSnapshots(runtime);
  installBootstrapRoutes(app, { config, runtime, store, upgrades, directory, snapshot });
  const mains = new MainAssistants(runtime, store, config, app.log);
  installMainAssistantRoutes(app, { runtime, store, mains, requireCapability, preferences: userId => visiblePreferences(store, userId) });
  installBotRoutes(app, { runtime, store, roster, directory, requireCapability, mains });
  const streams = new Set<() => void>();
  const conversations = installConversationRoutes(app, { config, runtime, store, roster, streams, requireCapability });
  installTalkRoutes(app, { runtime, store, roster, directory, requireCapability, send: conversations.send });
  installSnapshotInvalidation(app, snapshot);
  installEventRoutes(app, { config, runtime, store, roster, directory, snapshot, room: collaboration.room, groups, catalogs, streams });
  installRoutineRoutes(app, { config, runtime, store, roster, requireCapability });
  // The worker owns the aggregate so a push and this read agree; handlers run after it exists.
  installPushRoutes(app, { config, runtime, store, live: () => worker.live });
  // Universal links and Handoff for the iOS app, whose bundle ID is the APNs topic. Only chat and Today
  // links open the app; sign-in and everything else stay on the web.
  app.get("/.well-known/apple-app-site-association", (_req, reply) => {
    if (!config.apns) return reply.code(404).send({ error: "Not found" });
    const appID = `${config.apns.teamId}.${config.apns.topic}`;
    return reply.type("application/json").header("Cache-Control", "public, max-age=3600").send(appleAppSiteAssociation(appID));
  });
  const clientRoot = options.clientRoot ?? resolve("dist/client");
  if (existsSync(clientRoot)) {
    const previousFile = options.previousRelease ?? (options.clientRoot ? undefined : resolve("dist/previous-release.json"));
    const previous = previousFile ? readPreviousAssets(previousFile, message => app.log.warn(message)) : undefined;
    await app.register(staticFiles, {
      root: clientRoot,
      cacheControl: true,
      maxAge: "1h",
      setHeaders: (reply, path) => {
        if (mustRevalidate(clientRoot, path))
          reply.header("Cache-Control", "no-cache");
        else if (isHashedAsset(clientRoot, path) || isPreviousAsset(previous, path))
          reply.header("Cache-Control", immutableCacheControl);
      },
    });
    // The iOS app's shared desktop viewer and system terminal. They hold nothing private: the app hands
    // each a ticket in the hash.
    // These handlers send without returning the reply: a returned reply is thenable, so Fastify
    // would add one more finished-watcher to every static response for nothing.
    app.get("/native/computer", (_req, reply) => { reply.sendFile("native-computer.html"); });
    app.get("/native/terminal", (_req, reply) => { reply.sendFile("native-terminal.html"); });
    app.setNotFoundHandler((req, reply) => {
      if (isApiRequest(req)) reply.code(404).send({ error: "API endpoint not found" });
      // A bundle a release retired, asked for by a page still running that release. The shell in its
      // place would reach the page as a script it cannot run; a 404 says plainly that the file is
      // gone, and the screen offers Reload. Not kept, since a rollback can bring the file back. A missing
      // boot.js is the same: index.html loads it as a script, and without it the app reads for itself.
      // A page that opened under the release this one replaced still asks for that release's files, so a
      // hashed one the previous release holds is sent from there, as long as the tooling names that directory.
      else if (req.url.startsWith("/assets/") || req.url.split("?")[0] === "/boot.js") {
        const retired = req.method === "GET" || req.method === "HEAD" ? previousAssetFile(previous, req.url.split("?")[0]) : undefined;
        if (retired) { req.log.info({ file: retired.name }, "Served a retired asset from the previous release"); reply.sendFile(retired.name, retired.root); }
        else reply.code(404).header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("Not found");
      }
      else reply.type("text/html").sendFile("index.html");
    });
  }
  const worker = new BackgroundWorker(store, runtime, config, undefined, options.sendApns, app.log, options.sendLiveActivity);
  worker.identify = events => mains.identify(events);
  const health = new HealthMonitor({
    store, runtime, worker, config, maintenance: () => upgrades.maintenance(), log: app.log,
    metadataProbe: options.metadataProbe ?? defaultMetadataProbe(config),
  });
  installHealthRoutes(app, health);
  if (options.background !== false) {
    worker.start();
    health.start();
    mains.start();
  }
  app.addHook("onClose", async () => {
    await directRoutes?.close();
    groups.close();
    catalogs?.close();
    health.stop();
    await mains.stop();
    await worker.stop();
    await runtime.close();
    store.close();
  });
  return { app, store, worker, health, routes, directRoutes, mains };
}

/** The association file Apple's CDN fetches for universal links and Handoff from Safari. */
export function appleAppSiteAssociation(appID: string) {
  return {
    applinks: {
      details: [{
        appIDs: [appID],
        components: [
          { "/": "/", "?": { bot: "?*" }, comment: "A chat, as notifications and the web link it" },
          { "/": "/", "?": { view: "today" }, comment: "Today" },
        ],
      }],
    },
    activitycontinuation: { apps: [appID] },
  };
}
