import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Preferences, Runtime, RuntimeStatus } from "../shared/types.js";
import { apiRoute } from "./api-route.js";
import { signedIn } from "./auth.js";
import { visibleTo } from "./bot-access.js";
import type { BotDirectory } from "./bot-routes.js";
import { allowedIdentity, type Config } from "./config.js";
import { httpError } from "./http-error.js";
import type { RuntimeSnapshots } from "./runtime-snapshot.js";
import { id, modelFavoriteList, preferences } from "./schemas.js";
import type { Store } from "./store.js";
import type { HermesUpgrades } from "./upgrades.js";

/** The client's first read, retrying the Hermes connection, this person's preferences and model options. */
export function installBootstrapRoutes(app: FastifyInstance, collaborators: {
  config: Config;
  runtime: Runtime;
  store: Store;
  upgrades: Pick<HermesUpgrades, "revisionDate">;
  directory: BotDirectory;
  snapshot: RuntimeSnapshots;
}) {
  const { config, runtime, store, upgrades, directory, snapshot } = collaborators;
  // Someone else's private assistant leaves this person's lists, so their saved
  // preferences stop naming it too.
  const preferencesFor = (userId: string): Preferences => {
    const value = store.preferences(userId);
    const seen = (botId: string) => visibleTo(store, botId, userId);
    return { ...value, favorites: value.favorites.filter(seen), followBots: value.followBots.filter(seen),
      sections: value.sections.map(section => ({ ...section, botIds: section.botIds.filter(seen) })),
      ...(value.hiddenRoutineRuns ? { hiddenRoutineRuns: value.hiddenRoutineRuns.filter(entry => seen(entry.botId)) } : {}),
      defaultBotId: value.defaultBotId && seen(value.defaultBotId) ? value.defaultBotId : undefined };
  };
  const dated = (status: RuntimeStatus): RuntimeStatus => {
    const revisionDate = upgrades.revisionDate(status.version);
    return revisionDate ? { ...status, revisionDate } : status;
  };
  apiRoute(app, "GET /bootstrap", {}, async req => ({
    user: signedIn(req),
    household: store.users().filter((user) => allowedIdentity(config, user)),
    preferences: preferencesFor(signedIn(req).id),
    ...await snapshot.read().then(async value => ({ ...value, connection: dated(value.connection),
      bots: await directory.rosterFor(signedIn(req).id, value.bots, value.capabilities.avatarMetadata.supported,
        (req.query as { roster?: string }).roster === "lean"),
    })),
    csrfToken: req.csrfToken,
    vapidPublicKey: config.vapidPublicKey || undefined,
    nativeApp: config.nativeApp,
  }));
  apiRoute(app, "POST /connection/retry", {}, async () => {
    snapshot.invalidate();
    const status = dated(await (runtime.reconnect ? runtime.reconnect() : runtime.status()));
    snapshot.invalidate();
    return status;
  });
  apiRoute(app, "PATCH /preferences", { body: preferences }, async (req, value) => {
    const previous = store.preferences(signedIn(req).id);
    value.modelFavorites ??= previous.modelFavorites;
    value.startPage ??= previous.startPage;
    value.notifications ??= previous.notifications;
    // Older clients don't know hidden routine runs; their saves keep this person's list.
    value.hiddenRoutineRuns ??= previous.hiddenRoutineRuns;
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
}
