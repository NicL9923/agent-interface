import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Bot, Runtime } from "../shared/types.js";
import type { GroupState } from "../shared/collaboration.js";
import { signedIn, stillSignedIn } from "./auth.js";
import { visible, visibleTo, type Roster } from "./bot-access.js";
import type { BotDirectory } from "./bot-routes.js";
import { roomAccessible } from "./collaboration.js";
import type { Config } from "./config.js";
import { eventStreamConnection, type EventStream } from "./event-stream.js";
import type { GroupCatalogWatch } from "./group-catalog-watch.js";
import type { GroupWatch } from "./group-watch.js";
import { routePattern } from "./route-path.js";
import { changesRoster, type RuntimeSnapshots } from "./runtime-snapshot.js";
import { id } from "./schemas.js";
import type { Store } from "./store.js";

/**
 * The household change stream, `GET /api/events`: a roster notice when this person's visible
 * assistants change, a groups notice when their visible group catalog changes, and with
 * `?group=<roomId>` a notice for each change to that group chat.
 */
export function installEventRoutes(app: FastifyInstance, collaborators: {
  config: Config;
  runtime: Runtime;
  store: Store;
  roster: Roster;
  directory: BotDirectory;
  snapshot: RuntimeSnapshots;
  /** Reads one group chat this person may open, or answers 404. */
  room: (userId: string, roomId: string) => Promise<GroupState>;
  groups: GroupWatch;
  /** Watches the group catalog for open streams; absent when Hermes cannot host group chats. */
  catalogs?: GroupCatalogWatch;
  /** Open event streams, which the app ends on shutdown. */
  streams: Set<() => void>;
}) {
  const { config, runtime, store, roster, directory, snapshot, room, groups, catalogs, streams } = collaborators;
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
      const began = snapshot.begin();
      void Promise.all([runtime.listBots(), runtime.capabilities(), runtime.status().catch(() => undefined)]).then(([bots, capabilities, status]) => {
        roster.note(bots);
        // The bootstrap each client sends on the notice below reuses this read.
        if (status) snapshot.keep({ bots, capabilities, connection: status }, began);
        for (const changed of rosterListeners) changed(bots, capabilities.avatarMetadata.supported);
      }).catch(() => { /* The fallback bootstrap retries unavailable runtime reads. */ })
        .finally(() => {
          rosterEvaluating = false;
          if (rosterAgain) { rosterAgain = false; evaluateRoster(); }
        });
    }, Math.max(0, rosterLast + 1000 - Date.now()));
  };
  app.addHook("onResponse", async (req, reply) => {
    if (req.method === "GET" || reply.statusCode >= 400) return;
    const path = routePattern(req);
    if (changesRoster(path)) evaluateRoster();
    // Rooms change with group writes, and with assistant changes such as sharing or deletion, which change who may open them.
    if (changesRoster(path) || path.startsWith("/api/groups")) catalogs?.changed();
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
    if (group !== undefined) await room(userId, group);
    if (connection.closed) return connection.abandon();
    const initial = await snapshot.read();
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
    let unwatchCatalog: (() => void) | undefined;
    const teardown = () => {
      unwatchGroup?.();
      unwatchCatalog?.();
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
        unwatchCatalog = catalogs?.watch(userId, () => {
          if (!stillSignedIn(store, config, req)) { stream?.end(); return; }
          stream?.send("event: groups\ndata: groups\n\n");
        });
      },
      allowed: () => stillSignedIn(store, config, req),
      teardown,
    });
  });
}
