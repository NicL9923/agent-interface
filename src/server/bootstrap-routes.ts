import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { HarnessOption, Preferences, PreferencesPatch, Runtime } from "../shared/types.js";
import { applyMergePatch, MERGE_PATCH } from "../shared/merge-patch.js";
import { apiRoute } from "./api-route.js";
import { signedIn } from "./auth.js";
import { visibleTo } from "./bot-access.js";
import { mainEligible } from "../shared/main-assistant.js";
import type { BotDirectory } from "./bot-routes.js";
import { allowedIdentity, type Config } from "./config.js";
import { httpError } from "./http-error.js";
import { safeError } from "./logging.js";
import type { RuntimeSnapshots } from "./runtime-snapshot.js";
import { id, modelFavoriteList, notifications, preferences, preferencesPatch } from "./schemas.js";
import type { Store } from "./store.js";

/**
 * This person's preferences as their clients see them: assistants they cannot see are left out,
 * and so is a main assistant that is no longer their own personal one.
 */
export function visiblePreferences(store: Store, userId: string): Preferences {
  const value = store.preferences(userId);
  const seen = (botId: string) => visibleTo(store, botId, userId);
  const main =
    value.mainBotId && mainEligible(store.presentation(value.mainBotId), userId)
      ? value.mainBotId
      : undefined;
  return {
    ...value,
    favorites: value.favorites.filter(seen),
    followBots: value.followBots.filter(seen),
    sections: value.sections.map((section) => ({
      ...section,
      botIds: section.botIds.filter(seen),
    })),
    ...(value.hiddenRoutineRuns
      ? { hiddenRoutineRuns: value.hiddenRoutineRuns.filter((entry) => seen(entry.botId)) }
      : {}),
    defaultBotId: value.defaultBotId && seen(value.defaultBotId) ? value.defaultBotId : undefined,
    mainBotId: main,
    ...(value.checkIns
      ? { checkIns: main ? value.checkIns : { ...value.checkIns, enabled: false } }
      : {}),
  };
}

const mediaType = (header: string | undefined) => header?.split(";")[0].trim().toLowerCase();

/**
 * A whole-object save, as clients from before partial saves send. Each field it leaves out is cleared,
 * except the ones below, which those clients may not know. Kept exactly as it was, so their saves store
 * what they always did.
 */
function whole(previous: Preferences, value: Preferences): Preferences {
  value.modelFavorites ??= previous.modelFavorites;
  value.startPage ??= previous.startPage;
  // Older clients don't know the chat style either; their saves keep this person's choice.
  value.chatStyle ??= previous.chatStyle;
  value.ownBubble ??= previous.ownBubble;
  value.notifications ??= previous.notifications;
  // Older clients don't know hidden routine runs; their saves keep this person's list.
  value.hiddenRoutineRuns ??= previous.hiddenRoutineRuns;
  value.mainSuggestionDismissed ??= previous.mainSuggestionDismissed;
  // The main assistant and its check-ins change only through their own routes, which keep Hermes
  // matching, so neither an older client nor a stale copy here can change or clear them.
  value.mainBotId = previous.mainBotId;
  value.checkIns = previous.checkIns;
  return value;
}

/**
 * A partial save: each field it names replaces the saved one, `null` clears it, and every other field,
 * the routed ones included, keeps its saved value. Two stale copies saving different fields both land.
 */
function patched(previous: Preferences, patch: PreferencesPatch): Preferences {
  const next = applyMergePatch(previous, patch) as Preferences;
  // Merged key by key, the settings must still be whole and valid, as a whole save's are.
  if (patch.notifications) z.object({ notifications }).parse({ notifications: next.notifications });
  return next;
}

/** The client's first read, retrying the runtime connection, this person's preferences and model options. */
export function installBootstrapRoutes(
  app: FastifyInstance,
  collaborators: {
    config: Config;
    runtime: Runtime;
    store: Store;
    directory: BotDirectory;
    snapshot: RuntimeSnapshots;
    /** The native harnesses new assistants can use. */
    probeHarnesses?: () => Promise<HarnessOption[]>;
  },
) {
  const { config, runtime, store, directory, snapshot, probeHarnesses } = collaborators;
  // Someone else's private assistant leaves this person's lists, so their saved
  // preferences stop naming it too.
  const preferencesFor = (userId: string): Preferences => visiblePreferences(store, userId);
  apiRoute(app, "GET /bootstrap", {}, async (req) => {
    const user = signedIn(req);
    const lean = (req.query as { roster?: string }).roster === "lean";
    const [read, harnesses] = await Promise.all([
      snapshot.read().then(async (value) => ({
        ...value,
        bots: await directory.rosterFor(
          user.id,
          value.bots,
          value.capabilities.avatarMetadata.supported,
          lean,
        ),
      })),
      probeHarnesses
        ? probeHarnesses().catch((error: unknown) => {
            req.log.warn({ error: safeError(error) }, "Native harness probes failed");
            return undefined;
          })
        : Promise.resolve(undefined),
    ]);
    return {
      user,
      household: store.users().filter((member) => allowedIdentity(config, member)),
      preferences: preferencesFor(user.id),
      ...read,
      csrfToken: req.csrfToken,
      formKey: store.formKey(user.id),
      vapidPublicKey: config.vapidPublicKey || undefined,
      nativeApp: config.nativeApp,
      ...(probeHarnesses ? { harnesses } : {}),
    };
  });
  apiRoute(app, "POST /connection/retry", {}, async () => {
    snapshot.invalidate();
    const status = await (runtime.reconnect ? runtime.reconnect() : runtime.status());
    snapshot.invalidate();
    return status;
  });
  // A partial save is a merge patch. The parser takes it only on this route, so no other route reads one as whole.
  const json = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser(MERGE_PATCH, { parseAs: "string" }, (req, body, done) => {
    if (req.method !== "PATCH" || req.routeOptions.url !== "/api/preferences")
      return done(httpError(415, `Only PATCH /api/preferences takes ${MERGE_PATCH}.`), undefined);
    void json(req, body as string, done);
  });
  const partial = (req: { headers: { "content-type"?: string } }) =>
    mediaType(req.headers["content-type"]) === MERGE_PATCH;
  apiRoute(
    app,
    "PATCH /preferences",
    {
      // A whole body meets the whole schema first, so an older client's refusal lists every field it
      // always did, before the looser partial schema reads the body.
      before: async (req) => {
        if (!partial(req)) preferences.parse(req.body);
      },
      body: preferencesPatch,
    },
    async (req, patch) => {
      const userId = signedIn(req).id;
      const previous = store.preferences(userId);
      store.savePreferences(
        userId,
        partial(req) ? patched(previous, patch) : whole(previous, preferences.parse(req.body)),
      );
      return preferencesFor(userId);
    },
  );
  apiRoute(
    app,
    "PUT /preferences/models",
    { body: z.object({ modelFavorites: modelFavoriteList }).strict() },
    async (req, { modelFavorites }) => {
      const userId = signedIn(req).id;
      store.savePreferences(userId, { ...store.preferences(userId), modelFavorites });
      return { modelFavorites };
    },
  );
  apiRoute(app, "GET /models", {}, async (req) => {
    const { botId } = z.object({ botId: id.optional() }).parse(req.query);
    if (!runtime.modelOptions)
      throw httpError(409, "The connected Hermes installation does not expose model options.");
    return runtime.modelOptions(botId);
  });
}
