import type { FastifyInstance } from "fastify";
import type { Bootstrap, Bot, Capabilities, Runtime } from "../shared/types.js";
import { isIncomplete, isUnknownRoster, sameMarks } from "./unknown-roster.js";
import { routePattern } from "./route-path.js";

/**
 * How long a resolved runtime read is reused. A roster notice sends every open client to bootstrap
 * within a few milliseconds, and polls and focus events arrive in clusters across household devices.
 * 1.5 s is longer than the roster stream's 1 s evaluation floor, so a read refreshed by one evaluation
 * outlives the bootstraps it triggers, and it is the longest a disconnect can go unreported to a
 * fresh bootstrap.
 */
export const SNAPSHOT_TTL_MS = 1500;
export type RuntimeSnapshot = Pick<Bootstrap, "bots" | "capabilities" | "connection"> & {
  rosterUnknown: boolean;
};
/** A read's start, from `begin`, which decides whether it may still publish. */
export type SnapshotRead = { startedAt: number; order: number };

// Every capability unsupported, for a runtime whose own set cannot be read. Typed by key, so a new capability
// fails to compile here until it is listed.
const unavailable = { supported: false, reason: "This assistant's runtime is unavailable." };
const runtimeUnavailable: Capabilities = {
  chat: unavailable,
  steering: unavailable,
  queueManagement: unavailable,
  approvals: unavailable,
  uploads: unavailable,
  generatedFiles: unavailable,
  botConfiguration: unavailable,
  tools: unavailable,
  skills: unavailable,
  routines: unavailable,
  durableEvents: unavailable,
  idempotency: unavailable,
  imageGeneration: unavailable,
  stop: unavailable,
  portraitGeneration: unavailable,
  avatarMetadata: unavailable,
  liveVoice: unavailable,
};

/**
 * The roster with each assistant's own runtime capabilities, read once per runtime, not once per assistant.
 * Only rows that name their runtime (`harness`, set by the runtime router) get them; clients use the top-level
 * capabilities for the rest. A runtime whose capabilities cannot be read reports every one unsupported, so no
 * client offers what it may not do. The list keeps its roster marks.
 */
export async function withBotCapabilities(
  runtime: Pick<Runtime, "capabilities">,
  bots: Bot[],
): Promise<Bot[]> {
  const first = new Map<string, string>();
  for (const bot of bots)
    if (bot.harness && !first.has(bot.harness)) first.set(bot.harness, bot.id);
  if (!first.size) return bots;
  const read = new Map(
    await Promise.all(
      [...first].map(
        async ([harness, botId]) =>
          [harness, await runtime.capabilities(botId).catch(() => runtimeUnavailable)] as const,
      ),
    ),
  );
  return sameMarks(
    bots,
    bots.map((bot) => (bot.harness ? { ...bot, capabilities: read.get(bot.harness) } : bot)),
  );
}
/** Runtime reads shared by every bootstrap and event stream. */
export function runtimeSnapshots(runtime: Pick<Runtime, "listBots" | "capabilities" | "status">) {
  let snapshotRead: Promise<RuntimeSnapshot> | undefined;
  let snapshotKept: { value: RuntimeSnapshot; at: number } | undefined;
  // Every read, from a bootstrap or a roster evaluation, takes the next number when it starts. Only
  // a read that started after the last publication may publish, so a slow read never overwrites
  // what a newer one saw. An invalidation counts as a publication: reads begun before it are dropped.
  let readsStarted = 0,
    readPublished = 0;
  const begin = (): SnapshotRead => ({ startedAt: Date.now(), order: ++readsStarted });
  /**
   * Keeps a read only while the runtime is connected and answering, so an outage is never served
   * from memory: Hermes reports a failed roster read as disconnected rows, a lost socket as a
   * disconnected status, and the router a failed runtime as a partial roster. Each replaces what
   * was kept, so the outage shows at once.
   */
  const keep = (value: RuntimeSnapshot, { startedAt, order }: SnapshotRead) => {
    if (order < readPublished) return;
    readPublished = order;
    snapshotKept =
      value.connection.connected &&
      !value.rosterUnknown &&
      !isIncomplete(value.bots) &&
      !value.bots.some((bot) => bot.activity === "disconnected")
        ? { value, at: startedAt }
        : undefined;
    // Callers that arrive now take this read, not an older one still in flight.
    snapshotRead = undefined;
  };
  /** Forgets the snapshot after this app changed runtime state, so the next read sees the change. */
  const invalidate = () => {
    readPublished = readsStarted + 1;
    snapshotKept = undefined;
    snapshotRead = undefined;
  };
  const read = (): Promise<RuntimeSnapshot> => {
    if (snapshotKept && Date.now() - snapshotKept.at < SNAPSHOT_TTL_MS)
      return Promise.resolve(snapshotKept.value);
    if (snapshotRead) return snapshotRead;
    const began = begin();
    // Share only runtime reads, undecorated: presentation, identity, preferences and CSRF stay request-scoped.
    const reading: Promise<RuntimeSnapshot> = (async () => {
      const [listed, capabilities] = await Promise.all([
        runtime.listBots(),
        runtime.capabilities(),
      ]);
      const bots = await withBotCapabilities(runtime, listed);
      return {
        bots,
        capabilities,
        connection: await runtime.status(),
        rosterUnknown: isUnknownRoster(bots),
      };
    })();
    snapshotRead = reading;
    // A rejected read is never kept: the next caller reads again.
    reading.then(
      (value) => {
        if (snapshotRead === reading) snapshotRead = undefined;
        keep(value, began);
      },
      () => {
        if (snapshotRead === reading) snapshotRead = undefined;
      },
    );
    return reading;
  };
  return { read, begin, keep, invalidate };
}
export type RuntimeSnapshots = ReturnType<typeof runtimeSnapshots>;

/**
 * Writes to assistants that can change the roster. Drafts, read positions, presence and uploads
 * touch only this app's own state.
 */
export const changesRoster = (path: string) =>
  path.startsWith("/api/bots") && !/\/(draft|read-position|presence|uploads)$/.test(path);

/**
 * The next bootstrap must show what this app just changed, whether or not the write succeeded:
 * a failed create or save may still have reached Hermes. Dropped before the response is sent,
 * so a client's very next read cannot find the old snapshot. Upgrades, connections, routines
 * and notification actions change runtime state too.
 */
export function installSnapshotInvalidation(app: FastifyInstance, snapshot: RuntimeSnapshots) {
  app.addHook("onSend", async (req, _reply, payload) => {
    const path = routePattern(req);
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      (changesRoster(path) ||
        /^\/api\/(hermes|integrations|routines|push\/actions)(\/|$)/.test(path))
    )
      snapshot.invalidate();
    return payload;
  });
}
