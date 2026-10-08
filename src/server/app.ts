import { avatarShapes, reasoningLevels, serviceTiers } from "../shared/types.js";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
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
import { installAuth, signedIn } from "./auth.js";
import { BackgroundWorker } from "./notifications.js";
import type { ApnsSender } from "./apns.js";
import { HermesUpgrades } from "./upgrades.js";
import { installIntegrationsRoutes } from "./integrations.js";
import { installVaultRoutes } from "./vault.js";
import { registerVoiceRoutes } from "./voice.js";
import { installDiscoveryRoutes } from "./discovery.js";
import { assertRoutineEditable, installExperienceRoutes } from "./experience.js";
import { installComputerRoutes } from "./computer.js";
import { installCollaborationRoutes } from './collaboration.js';
import { loggerOptions, RepeatFilter, safeError } from "./logging.js";
import { HealthMonitor, installHealthRoutes } from "./health.js";
import { installEtags } from "./etag.js";
import { installSecurityHeaders } from "./security-headers.js";
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
const draftInput = z.object({ text: z.string().max(50000), attachments: z.array(fileRef).max(10).default([]) });
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
    upgrades?: HermesUpgrades;
    logStream?: { write(line: string): void };
  } = {},
) {
  const store = options.store ?? new Store(config.database);
  const app = Fastify({
    ...loggerOptions(config.logLevel ?? "silent", options.logStream),
    bodyLimit: 1024 * 1024,
    trustProxy: false,
    routerOptions: { maxParamLength: 8192 },
  });
  installSecurityHeaders(app, config.origin);
  installEtags(app);
  await app.register(cookie);
  await app.register(websocket, {options: {maxPayload: 256 * 1024}});
  await app.register(multipart, {
    limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  });
  await installAuth(app, store, config, options.verifyGoogle);
  const upgrades = options.upgrades ?? new HermesUpgrades(config, runtime);
  app.addHook("onRequest", async (req, reply) => {
    if (!upgrades.maintenance() || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const path = req.url.split("?")[0];
    if ((path.startsWith("/api/bots") && !/\/(draft|read)$/.test(path)) || path.startsWith("/api/routines") || path.startsWith("/api/groups") || path.startsWith("/api/integrations"))
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
    };
    const status = err.statusCode ?? 502;
    if (status >= 500) {
      const route = `${req.method} ${req.routeOptions.url ?? "unmatched"}`;
      const repeats = serverErrors.hit(`${route} ${status} ${err.message}`);
      if (repeats === 0) req.log.error({ error: safeError(err), route, status }, "Request failed");
      else if (repeats !== undefined) req.log.error({ route, status, error: err.message, repeats }, "Request failure repeated");
    }
    reply.code(status).send({
      error:
        err.statusCode && err.statusCode < 500
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
  await installExperienceRoutes(app, runtime, store);
  await installDiscoveryRoutes(app, runtime, store);
  await installCollaborationRoutes(app, runtime, store);
  await installVaultRoutes(app, runtime);
  await registerVoiceRoutes(app, runtime);
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
    preferences: store.preferences(signedIn(req).id),
    ...await runtimeSnapshot(),
    csrfToken: req.csrfToken,
    vapidPublicKey: config.vapidPublicKey || undefined,
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
  app.get("/api/bots", async () => {
    const [bots, capabilities] = await Promise.all([runtime.listBots(), runtime.capabilities()]);
    return bots.map(bot => decorateBot(bot, capabilities.avatarMetadata.supported));
  });
  app.post("/api/bots", async (req) => {
    await requireCapability("botConfiguration");
    const input = botInput.parse(req.body);
    const bot = await runtime.saveBot(input as BotInput);
    store.savePresentation(bot.id, {
      shared: input.shared,
      ownerId: input.shared ? undefined : signedIn(req).id,
    });
    return decorateBot(bot, (await runtime.capabilities()).avatarMetadata.supported);
  });
  app.patch("/api/bots/:id", async (req) => {
    await requireCapability("botConfiguration");
    const input = botInput.parse(req.body);
    const bot = await runtime.saveBot(input as BotInput, params(req).id);
    store.savePresentation(bot.id, {
      shared: input.shared,
      ownerId: input.shared ? undefined : signedIn(req).id,
    });
    return decorateBot(bot, (await runtime.capabilities()).avatarMetadata.supported);
  });
  app.delete("/api/bots/:id", async (req) => {
    await requireCapability("botConfiguration");
    await runtime.deleteBot(params(req).id);
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
    store.savePresentation(bot.id, {
      ...store.presentation(bot.id),
      shared: store.presentation(bot.id).shared ?? bot.shared,
      avatar: value,
    });
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
    const result = await runtime.conversation(params(req).id);
    // Attribution augments the canonical Hermes history, never stores a transcript.
    result.messages = result.messages.map((message) => {
      const attribution =
        store.submissionForMessage(params(req).id, message.id) ??
        store.submission(message.id);
      const user = attribution
        ? store.getUser(attribution.input.senderId)
        : undefined;
      return user
        ? { ...message, sender: { id: user.id, name: user.name } }
        : message;
    });
    return {
      ...result,
      draft: store.personal("drafts", signedIn(req).id, params(req).id),
      readPosition: store.personal(
        "read_positions",
        signedIn(req).id,
        params(req).id,
      ),
    };
  });
  const submit = async (req: FastifyRequest, explicitSteering = false) => {
    const body = z
      .object({
        requestId: z.string().uuid(),
        text: z.string().max(50000),
        attachments: z.array(fileRef).max(10).default([]),
        reviewedInterruption: z.boolean().default(false),
        reviewedUncertain: z.boolean().default(false),
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
    if (previous) {
      if (JSON.stringify(previous.input) !== JSON.stringify(input))
        throw failure(
          409,
          "This submission ID was already used for different content",
        );
      if (!reviewedUncertain || previous.receipt.status !== "uncertain")
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
    const conversation = await runtime.conversation(input.botId);
    if (conversation.activity.state === "interrupted" && !reviewedInterruption)
      throw failure(
        409,
        "Review the interrupted task before starting another message.",
      );
    const steering =
      explicitSteering ||
      ["thinking", "working", "waiting", "blocked"].includes(
        conversation.activity.state,
      );
    if (steering) await requireCapability("steering");
    const intent = store.intent(input);
    if (!intent.created && !reviewedUncertain) return intent.receipt;
    if (conversation.activity.runId)
      store.participate(conversation.activity.runId, input.senderId);
    try {
      const receipt = await (steering
        ? runtime.steer({ ...input, reviewedInterruption })
        : runtime.submit({ ...input, reviewedInterruption }));
      store.receipt(receipt);
      return receipt;
    } catch {
      return store.submission(input.requestId)!.receipt;
    }
  };
  app.post("/api/bots/:id/messages", async (req) => submit(req));
  app.post("/api/bots/:id/steer", async (req) => submit(req, true));
  app.get("/api/submissions/:id", async (req) => {
    const requestId = z.string().uuid().parse(params(req).id);
    const previous = store.submission(requestId);
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
    const conversation = await runtime.conversation(p.id);
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
    const conversation = await runtime.conversation(p.id);
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
  for (const [route, table] of [
    ["draft", "drafts"],
    ["read-position", "read_positions"],
  ] as const) {
    app.get(`/api/bots/:id/${route}`, async (req) =>
      store.personal(table, signedIn(req).id, params(req).id),
    );
    app.put(`/api/bots/:id/${route}`, async (req) => {
      const value =
        route === "draft"
          ? draftInput.parse(req.body)
          : z
              .object({
                messageId: z.string().max(200).optional(),
                scrollTop: z.number().min(0).optional(),
              })
              .parse(req.body);
      store.savePersonal(table, signedIn(req).id, params(req).id, value);
      return value;
    });
  }
  app.post("/api/bots/:id/uploads", async (req) => {
    await requireCapability("uploads");
    const file = await req.file();
    if (!file) throw failure(400, "No file provided");
    if (
      ![
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "application/pdf",
        "text/plain",
      ].includes(file.mimetype)
    )
      throw failure(415, "Use an image, PDF, or plain-text file");
    const data = await file.toBuffer();
    if (file.file.truncated) throw failure(413, "File exceeds 20 MB");
    return runtime.upload(params(req).id, {
      name: file.filename,
      mime: file.mimetype,
      data,
    });
  });
  app.get("/api/files/:id", async (req, reply) => {
    await requireCapability("generatedFiles");
    const file = await runtime.download(params(req).id);
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
    return reply.send(file.data);
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
  app.get("/api/routines", async () => {
    await requireCapability("routines");
    return (await runtime.routines()).map((r) => ({
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
      title: "Agent Interface test",
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
  app.post("/api/native/push/test", async req => {
    requireNativePush(req);
    const { botId } = z.object({ botId: id }).strict().parse(req.body);
    if (!(await runtime.listBots()).some(bot => bot.id === botId)) throw failure(404, "Bot not found");
    const eventId = crypto.randomUUID();
    store.queueNotification(eventId, signedIn(req).id, { title: "Agent Interface test", body: "Push delivery is connected.", url: `/?bot=${encodeURIComponent(botId)}`, tag: eventId });
    return { ok: true, detail: "Queued for this person. Confirm delivery on the signed-in physical device." };
  });
  const clientRoot = resolve("dist/client");
  if (existsSync(clientRoot)) {
    await app.register(staticFiles, {
      root: clientRoot,
      cacheControl: true,
      maxAge: "1h",
      setHeaders: (reply, path) => {
        if (path.endsWith("index.html") || path.endsWith("sw.js"))
          reply.header("Cache-Control", "no-cache");
      },
    });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "API endpoint not found" })
        : reply.type("text/html").sendFile("index.html"),
    );
  }
  const worker = new BackgroundWorker(store, runtime, config, undefined, options.sendApns, app.log);
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
  return { app, store, worker, health };
}
