import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Runtime } from "../shared/types.js";
import { apiRoute } from "./api-route.js";
import { signedIn } from "./auth.js";
import { visibleTo } from "./bot-access.js";
import type { Config } from "./config.js";
import { httpError } from "./http-error.js";
import type { LiveActivities } from "./live-activity.js";
import { apnsToken, id } from "./schemas.js";
import type { Store } from "./store.js";

/** Web Push subscriptions, native APNs devices and the aggregate Live Activity, with their test pushes. */
export function installPushRoutes(app: FastifyInstance, collaborators: {
  config: Config;
  runtime: Runtime;
  store: Store;
  /** The background worker's Live Activities, which exist once the worker does; handlers run after that. */
  live: () => LiveActivities;
}) {
  const { config, runtime, store, live } = collaborators;
  const endpoint = z.object({ endpoint: z.string().url().max(8192) }).strict();
  apiRoute(app, "POST /push/subscriptions/status", { body: endpoint }, async (req, { endpoint }) =>
    ({ registered: store.hasSubscription(signedIn(req).id, endpoint) }));
  const subscription = z
    .object({
      endpoint: z
        .string()
        .url()
        .refine((x) => new URL(x).protocol === "https:"),
      keys: z.object({
        p256dh: z.string().min(1).max(1000),
        auth: z.string().min(1).max(1000),
      }),
    });
  const webPush = {
    before: async () => {
      if (!config.vapidPublicKey)
        throw httpError(409, "Web Push is not configured");
    },
  };
  apiRoute(app, "POST /push/subscriptions", { ...webPush, body: subscription }, async (req, input) => {
    store.subscribe(signedIn(req).id, input);
    return { ok: true };
  });
  apiRoute(app, "POST /push/test", { ...webPush, body: z.object({ botId: id }) }, async (req, { botId }) => {
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
  apiRoute(app, "DELETE /push/subscriptions", { body: z.object({ endpoint: z.string().url() }) }, async (req, { endpoint }) => {
    store.unsubscribe(signedIn(req).id, endpoint);
    return { ok: true };
  });
  const nativeSession = (req: FastifyRequest, message: string) => {
    if (!req.nativeSessionHash) throw httpError(403, message);
    return req.nativeSessionHash;
  };
  const nativePush = (req: FastifyRequest) => {
    const session = nativeSession(req, "Native device registration requires native sign-in");
    if (!config.apns) throw httpError(409, "Apple push notifications are not configured on this host");
    return { session, apns: config.apns };
  };
  const requireNativePush = { before: async (req: FastifyRequest) => { nativePush(req); } };
  apiRoute(app, "GET /native/push/config", {}, async () => ({ available: !!config.apns, environment: config.apns?.environment }));
  apiRoute(app, "PUT /native/push/device", { ...requireNativePush, body: z.object({ deviceId: z.string().uuid(), token: apnsToken }).strict() },
    async (req, body) => {
      const { session, apns } = nativePush(req);
      store.registerNativeDevice(signedIn(req).id, session, body.deviceId, body.token.toLowerCase(), apns.environment);
      return { ok: true };
    });
  apiRoute(app, "DELETE /native/push/device", {
    before: async req => { nativeSession(req, "Native device registration requires native sign-in"); },
    body: z.object({ deviceId: z.string().uuid() }).strict(),
  }, async (req, body) => {
    store.removeNativeDevice(signedIn(req).id, body.deviceId);
    return { ok: true };
  });
  apiRoute(app, "GET /native/live-activity", {}, async req => {
    const session = nativeSession(req, "Live Activities require native sign-in");
    const { deviceId, local } = z.object({ deviceId: z.string().uuid().optional(), local: z.literal("1").optional() }).strict().parse(req.query);
    const userId = signedIn(req).id;
    const context = deviceId ? store.liveActivityContext(userId, session, deviceId) : undefined;
    // The app asks just before starting its own activity after a send; a pushed start would duplicate it.
    if (deviceId && local) store.liveActivityStartedLocally(userId, session, deviceId, Date.now());
    return { available: !!config.apns, state: await live().state(userId, context, context?.lastState) };
  });
  const accountScope = z.string().regex(/^[A-Za-z0-9_-]{4,1024}$/);
  /** The app's scope names its server address and account. Another account's would label this person's activity as someone else's. */
  const requireOwnScope = (scope: string | undefined, userId: string) => {
    if (scope !== undefined && !Buffer.from(scope, "base64url").toString("utf8").endsWith(`|${userId}`))
      throw httpError(400, "This Live Activity registration names a different account. Sign in again.");
  };
  // An app woken in the background for a pushed activity has no account loaded yet; it sends the activity's scope instead.
  const liveActivity = z.object({ deviceId: z.string().uuid(), token: apnsToken, botIds: z.array(id).max(10).default([]), scope: accountScope.optional() }).strict();
  apiRoute(app, "PUT /native/live-activity", { ...requireNativePush, body: liveActivity }, async (req, body) => {
    const { session, apns } = nativePush(req);
    const userId = signedIn(req).id, armedAt = Date.now();
    requireOwnScope(body.scope, userId);
    const armed = [...new Set(body.botIds)].filter(botId => visibleTo(store, botId, userId));
    // The next worker pass replays the current state; a Hermes outage must not fail a saved registration.
    store.registerLiveActivity(userId, session, body.deviceId, body.token.toLowerCase(), apns.environment, armed, armedAt);
    return { ok: true };
  });
  apiRoute(app, "DELETE /native/live-activity", {
    before: async req => { nativeSession(req, "Live Activities require native sign-in"); },
    body: z.object({ deviceId: z.string().uuid(), token: apnsToken }).strict(),
  }, async (req, body) => {
    store.dismissLiveActivity(signedIn(req).id, body.deviceId, body.token.toLowerCase());
    return { ok: true };
  });
  // iOS 18 push-to-start: the server starts the activity when work begins away from this device.
  const liveActivityStart = z.object({ deviceId: z.string().uuid(), token: apnsToken, scope: accountScope }).strict();
  apiRoute(app, "PUT /native/live-activity/start", { ...requireNativePush, body: liveActivityStart }, async (req, body) => {
    const { session, apns } = nativePush(req);
    const userId = signedIn(req).id;
    requireOwnScope(body.scope, userId);
    store.registerLiveActivityStart(userId, session, body.deviceId, body.token.toLowerCase(), apns.environment, body.scope);
    return { ok: true };
  });
  apiRoute(app, "DELETE /native/live-activity/start", {
    before: async req => { nativeSession(req, "Live Activities require native sign-in"); },
    body: z.object({ deviceId: z.string().uuid() }).strict(),
  }, async (req, body) => {
    store.removeLiveActivityStart(signedIn(req).id, body.deviceId);
    return { ok: true };
  });
  apiRoute(app, "POST /native/push/test", { ...requireNativePush, body: z.object({ botId: id }).strict() }, async (req, { botId }) => {
    if (!(await runtime.listBots()).some(bot => bot.id === botId)) throw httpError(404, "Bot not found");
    const eventId = crypto.randomUUID();
    store.queueNotification(eventId, signedIn(req).id, { title: "WildBots test", body: "Push delivery is connected.", url: `/?bot=${encodeURIComponent(botId)}`, tag: eventId });
    return { ok: true, detail: "Queued for this person. Confirm delivery on the signed-in physical device." };
  });
}
