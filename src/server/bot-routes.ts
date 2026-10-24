import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { IncompleteCreationError } from "../shared/errors.js";
import { botIdFor, reasoningLevels, serviceTiers, type Bot, type CapabilityKey, type Runtime } from "../shared/types.js";
import { apiRoute } from "./api-route.js";
import { signedIn } from "./auth.js";
import { notFound, visible, type Roster } from "./bot-access.js";
import { httpError } from "./http-error.js";
import { avatar, botSaveRequest, id } from "./schemas.js";
import type { Store } from "./store.js";

/** Marks a row unread when its latest message is newer than this person's last read of the chat. */
function withUnread(bot: Bot, readAt: number | undefined): Bot {
  const at = Date.parse(bot.lastMessage?.at ?? "");
  return readAt !== undefined && Number.isFinite(at) && at > readAt ? { ...bot, unread: true } : bot;
}

/** Roster rows as each person sees them, shared by the bot routes, bootstrap and the roster stream. */
export class BotDirectory {
  // Retain writable configuration across failed detail reads, like the runtime's roster fallback.
  private readonly details = new Map<string, Bot>();
  constructor(private readonly runtime: Runtime, private readonly store: Store) {}
  remember(bot: Bot) {
    this.details.set(bot.id, bot);
    return bot;
  }
  forget(botId: string) {
    this.details.delete(botId);
  }
  decorate(bot: Bot, nativeAvatar = false): Bot {
    return { ...bot, ...this.store.presentation(bot.id), ...(nativeAvatar ? { avatar: bot.avatar } : {}) };
  }
  lean(bots: Bot[]): Bot[] {
    return bots.map(({ instructions, enabledMcpServers, enabledTools, enabledSkills, ...bot }) => bot);
  }
  /** The roster this person may see, lean or with each assistant's writable configuration. */
  async rosterFor(userId: string, bots: Bot[], nativeAvatar: boolean, lean: boolean) {
    const ids = new Set(bots.map(bot => bot.id));
    for (const id of this.details.keys()) if (!ids.has(id)) this.details.delete(id);
    const reads = this.store.chatReads(userId);
    const rows = bots.map(bot => this.decorate(bot, nativeAvatar)).filter(bot => visible(bot, userId))
      .map(bot => withUnread(bot, reads.get(bot.id)));
    if (lean) return this.lean(rows);
    // Build 5 and cached bundles initialize writable settings from these rows.
    // Missing configuration is unsafe for those clients, so full remains the default.
    const detailed = await Promise.all(rows.map(async bot => {
      if (!this.runtime.botDetail) return bot;
      try {
        return withUnread(this.decorate(this.remember(await this.runtime.botDetail(bot.id)), nativeAvatar), reads.get(bot.id));
      } catch (error) {
        if (error instanceof Error && error.message === "Unknown Hermes bot.") {
          this.details.delete(bot.id);
          return undefined;
        }
        // Undefined configuration keys in Hermes's lean rows must not erase saved settings.
        return { ...this.details.get(bot.id), ...this.lean([bot])[0] };
      }
    }));
    return detailed.filter((bot): bot is Bot => bot !== undefined);
  }
}

/** Creating, reading, changing and deleting assistants, with their avatar, inference, tools and skills. */
export function installBotRoutes(app: FastifyInstance, collaborators: {
  runtime: Runtime;
  store: Store;
  roster: Roster;
  directory: BotDirectory;
  requireCapability: (key: CapabilityKey) => Promise<void>;
}) {
  const { runtime, store, roster, directory, requireCapability } = collaborators;
  const nativeAvatar = async () => (await runtime.capabilities()).avatarMetadata.supported;
  apiRoute(app, "GET /bots/:id/inference", {}, async req => {
    if (!runtime.inferenceSettings) throw httpError(409, "Hermes inference controls are unavailable.");
    return runtime.inferenceSettings(req.params.id);
  });
  const inference = z.object({ reasoning: z.enum(reasoningLevels).optional(), speed: z.enum(serviceTiers).optional() })
    .strict().refine(value => Object.keys(value).length > 0);
  const configurable = { before: () => requireCapability("botConfiguration") };
  apiRoute(app, "PATCH /bots/:id/inference", { ...configurable, body: inference }, async (req, update) => {
    if (!runtime.inferenceSettings) throw httpError(409, "Hermes inference controls are unavailable.");
    return runtime.inferenceSettings(req.params.id, update);
  });
  apiRoute(app, "GET /bots", {}, async req => {
    const [bots, capabilities] = await Promise.all([runtime.listBots(), runtime.capabilities()]);
    return directory.rosterFor(signedIn(req).id, bots, capabilities.avatarMetadata.supported,
      (req.query as { roster?: string }).roster === "lean");
  });
  apiRoute(app, "POST /bots", { ...configurable, body: botSaveRequest }, async (req, body) => {
    const { confirmPrivate: _, ...input } = body;
    const next = { shared: input.shared, ownerId: input.shared ? undefined : signedIn(req).id };
    // Its sharing is recorded before Hermes creates it, so a personal one is never briefly
    // public and a recreated ID never inherits an old record. An existing assistant's is never touched.
    const id = botIdFor(input.name);
    if (id && await roster.has(id))
      throw httpError(409, "An assistant with this name already exists. Choose another name.");
    const prior = id ? store.presentation(id) : {};
    const version = id ? store.swapPresentation(id, prior, next) : false;
    let bot;
    try { bot = await runtime.saveBot(input); }
    catch (error) {
      // Hermes may have created the profile and then failed to remove it; it stays the creator's.
      if (error instanceof IncompleteCreationError) {
        const created = error.createdBotId;
        if (created !== id) { if (version !== false) store.restorePresentation(id, version, prior); store.savePresentation(created, next); }
        roster.forget();
        throw httpError(502, `Hermes created ${input.name} but could not finish setting it up. It exists${input.shared ? "" : " and stays your personal assistant"}; review it in its settings.`, { expose: true, code: "created_incomplete" });
      }
      if (version !== false) store.restorePresentation(id, version, prior);
      throw error;
    }
    roster.forget();
    // A runtime that names it differently still gets its record.
    if (bot.id !== id) { if (version !== false) store.restorePresentation(id, version, prior); store.savePresentation(bot.id, next); }
    return directory.decorate(directory.remember(bot), await nativeAvatar());
  });
  apiRoute(app, "GET /bots/:id", {}, async req => {
    const botId = req.params.id;
    const value = runtime.botDetail ? await runtime.botDetail(botId)
      : (await runtime.listBots()).find(bot => bot.id === botId);
    if (!value) throw httpError(404, "Bot not found");
    return directory.decorate(directory.remember(value), await nativeAvatar());
  });
  apiRoute(app, "PATCH /bots/:id", { ...configurable, body: botSaveRequest }, async (req, body) => {
    const { confirmPrivate, ...input } = body;
    // Only its owner reaches a private assistant, so a personal one always belongs to the
    // person saving it. Claiming one everyone could see hides it from them, so it needs a yes.
    const id = req.params.id, userId = signedIn(req).id;
    const previous = store.presentation(id);
    // Another member may have made it theirs since this request was let in.
    if (!visible(previous, userId)) throw httpError(404, notFound.error, { code: notFound.code });
    if (!input.shared && !(previous.shared === false && previous.ownerId) && !confirmPrivate)
      throw httpError(409, "Confirm making this assistant personal. It will disappear for the rest of the household.", { code: "private_confirmation_required" });
    // Claim the new sharing before Hermes changes anything, and only if nobody changed it first.
    const next = { shared: input.shared, ownerId: input.shared ? undefined : userId };
    const version = store.swapPresentation(id, previous, next);
    if (version === false)
      throw httpError(409, "Someone changed who can see this assistant while you were saving. Review it and try again.", { code: "sharing_changed" });
    let bot;
    // A failed save puts sharing back only if no later save has changed it since.
    try { bot = await runtime.saveBot(input, id); }
    catch (error) { store.restorePresentation(id, version, previous); throw error; }
    roster.forget();
    return directory.decorate(directory.remember(bot), await nativeAvatar());
  });
  apiRoute(app, "DELETE /bots/:id", {}, async req => {
    await requireCapability("botConfiguration");
    await runtime.deleteBot(req.params.id);
    directory.forget(req.params.id);
    // A new assistant that reuses this ID starts with no owner, visibility or per-person state.
    store.forgetBot(req.params.id);
    roster.forget();
    return { ok: true };
  });
  apiRoute(app, "PUT /bots/:id/avatar", { body: avatar }, async (req, value) => {
    const bot = (await runtime.listBots()).find((b) => b.id === req.params.id);
    if (!bot) throw httpError(404, "Bot not found");
    if (
      (await runtime.capabilities()).avatarMetadata?.supported &&
      runtime.setAvatar
    )
      await runtime.setAvatar(bot.id, value);
    store.saveAvatar(bot.id, value, bot.shared);
    return value;
  });
  apiRoute(app, "POST /bots/:id/portrait", { before: () => requireCapability("portraitGeneration"),
    body: z.object({ prompt: z.string().min(1).max(2000) }) }, async (req, { prompt }) => {
    return runtime.generatePortrait(req.params.id, prompt);
  });
  const catalogIds = z.object({ ids: z.array(id).max(500) });
  for (const kind of ["tools", "skills"] as const) {
    apiRoute(app, `GET /bots/:id/${kind}`, {}, async req => {
      await requireCapability(kind);
      return runtime[kind](req.params.id);
    });
    apiRoute(app, `PUT /bots/:id/${kind}`, { before: () => requireCapability(kind), body: catalogIds }, async (req, { ids }) => {
      await (kind === "tools"
        ? runtime.setTools(req.params.id, ids)
        : runtime.setSkills(req.params.id, ids));
      return { ok: true };
    });
  }
}
