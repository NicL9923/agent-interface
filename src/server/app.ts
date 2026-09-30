import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type {
  Avatar,
  BotInput,
  CapabilityKey,
  Preferences,
  Runtime,
  Submission,
} from "../shared/types.js";
import { allowedIdentity, type Config } from "./config.js";
import { Store } from "./store.js";
import { installAuth, signedIn } from "./auth.js";
import { BackgroundWorker } from "./notifications.js";
const id = z.string().min(1).max(200);
const avatar = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("geometric"),
    shape: z.enum([
      "drop",
      "triangle",
      "cloud",
      "circle",
      "capsule",
      "blob",
      "pebble",
      "squircle",
      "hex",
    ]),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    eyes: z.enum(["round", "oval", "visor", "spark"]),
    accessory: z.enum(["none", "hat", "glasses"]),
    eyeWidth: z.number().min(0.6).max(1.5).optional(),
    eyeHeight: z.number().min(0.6).max(1.5).optional(),
    eyeSpacing: z.number().min(0.6).max(1.5).optional(),
  }),
  z.object({
    mode: z.literal("mascot"),
    family: z.enum(["sprout", "fox", "bear"]),
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
  defaultBotId: id.optional(),
  sections: z
    .array(
      z.object({ id, name: z.string().max(100), botIds: z.array(id).max(100) }),
    )
    .max(30),
  followBots: z.array(id).max(100),
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
  } = {},
) {
  const store = options.store ?? new Store(config.database);
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    trustProxy: false,
    routerOptions: { maxParamLength: 8192 },
  });
  app.addHook("onRequest", async (_req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "same-origin");
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  });
  await installAuth(app, store, config, options.verifyGoogle);
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
    reply.code(err.statusCode ?? 502).send({
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
  ) => ({ ...bot, ...store.presentation(bot.id) });
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/bootstrap", async (req) => ({
    user: signedIn(req),
    household: store.users().filter((user) => allowedIdentity(config, user)),
    preferences: store.preferences(signedIn(req).id),
    bots: (await runtime.listBots()).map(decorateBot),
    capabilities: await runtime.capabilities(),
    connection: await runtime.status(),
    csrfToken: req.csrfToken,
    vapidPublicKey: config.vapidPublicKey || undefined,
  }));
  app.patch("/api/preferences", async (req) => {
    const value = preferenceInput.parse(req.body) as Preferences;
    store.savePreferences(signedIn(req).id, value);
    return value;
  });
  app.get("/api/bots", async () => (await runtime.listBots()).map(decorateBot));
  app.post("/api/bots", async (req) => {
    await requireCapability("botConfiguration");
    const input = botInput.parse(req.body);
    const bot = await runtime.saveBot(input as BotInput);
    store.savePresentation(bot.id, {
      shared: input.shared,
      ownerId: input.shared ? undefined : signedIn(req).id,
    });
    return decorateBot(bot);
  });
  app.patch("/api/bots/:id", async (req) => {
    await requireCapability("botConfiguration");
    const input = botInput.parse(req.body);
    const bot = await runtime.saveBot(input as BotInput, params(req).id);
    store.savePresentation(bot.id, {
      shared: input.shared,
      ownerId: input.shared ? undefined : signedIn(req).id,
    });
    return decorateBot(bot);
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
          ? z
              .object({
                text: z.string().max(50000),
                attachments: z.array(fileRef).max(10).default([]),
              })
              .parse(req.body)
          : z
              .object({
                messageId: z.string().max(200).optional(),
                scrollTop: z.number().min(0),
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
    await runtime.deleteRoutine(params(req).id);
    store.routineRecipients(params(req).id, []);
    return { ok: true };
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
    store.db
      .prepare(
        "INSERT INTO outbox(id,event_id,user_id,payload) VALUES(?,?,?,?)",
      )
      .run(
        eventId,
        eventId,
        signedIn(req).id,
        JSON.stringify({
          title: "Agent Interface test",
          body: "Push delivery is connected.",
          url: `/?bot=${encodeURIComponent(botId)}`,
          tag: eventId,
        }),
      );
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
  const worker = new BackgroundWorker(store, runtime, config);
  if (options.background !== false) worker.start();
  app.addHook("onClose", async () => {
    const stopped = worker.stop();
    await runtime.close();
    await stopped;
    store.close();
  });
  return { app, store, worker };
}
