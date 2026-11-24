import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { NATIVE_HARNESS_KINDS, type ManagedBotRecord } from "../shared/harness.js";
import { isActivityMessage } from "../shared/message-origin.js";
import type { Bot, Conversation, Routine } from "../shared/types.js";
import { assertCredentialPolicy } from "./credential-policy.js";
import { importHermesMemoryAndSkills } from "./memory-learning.js";
import { firstRoutineTime } from "./native-routine-schedule.js";
import { AccountRepository } from "./store-accounts.js";
import { ManagedBotRepository } from "./store-bots.js";
import type { StoreDatabase } from "./store-database.js";
import { FileKeyRepository } from "./store-files.js";
import { MemorySkillsRepository } from "./store-memory.js";
import { NativeRoutineRepository, type CreateNativeRoutine } from "./store-native-routines.js";
import { PresentationRepository } from "./store-presentation.js";
import { TranscriptRepository, type TranscriptMessageInput } from "./store-transcripts.js";
import { persistedHermesMessages } from "./transcript-sync.js";

type HermesRoutine = Routine & {
  timezone?: string;
  nativeSchedule?: { kind: "cron" | "once" | "interval"; expression: string };
  tryOnce?: boolean;
  catchUp?: boolean;
  unsupported?: string[];
};
type RoutineSwitch = (botId: string, routineId: string) => void | Promise<void>;

export interface BotMigrationInput {
  /** Use a connection dedicated to this operation. Live cutover holds the SQLite write lock. */
  db: DatabaseSync;
  botId: string;
  harness: string;
  model: string;
  ownerId?: string;
  shared?: boolean;
  credentialId?: string;
  profileDir: string;
  rollbackDir: string;
  dryRun?: boolean;
  bot: Bot;
  messages?: readonly TranscriptMessageInput[];
  readConversation?: (botId: string) => Promise<Conversation>;
  readRoutines: (botId: string) => Promise<HermesRoutine[]>;
  disableHermesRoutine: RoutineSwitch;
}

/** These repositories only use the connection and transaction methods of StoreDatabase. */
function repositoryDatabase(db: DatabaseSync): StoreDatabase {
  const database: Pick<StoreDatabase, "db" | "transaction"> = {
    db,
    transaction<T>(operation: () => T): T {
      return db.isTransaction ? operation() : transaction(db, operation);
    },
  };
  return database as StoreDatabase;
}

function begin(db: DatabaseSync) {
  if (db.isTransaction) throw new Error("Migration requires a dedicated SQLite connection.");
  db.exec("BEGIN IMMEDIATE");
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  begin(db);
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
  }
}

export function migrationFileKeys(db: DatabaseSync) {
  return new FileKeyRepository(repositoryDatabase(db)).fileKeys();
}

const safeBotId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const nativeHarness = z.enum(NATIVE_HARNESS_KINDS);
const message = z.looseObject({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "tool", "system"]),
  text: z.string(),
});
const originalRegistry = z.object({
  id: safeBotId,
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  harness: z.literal("hermes"),
  model: z.string(),
  provider: z.string(),
  reasoning: z.string(),
  speed: z.string(),
  ownerId: z.string(),
  ownerOsUser: z.string(),
  shared: z.boolean(),
  credentialId: z.null(),
  enabledTools: z.array(z.string()),
  enabledSkills: z.array(z.string()),
  enabledMcpServers: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const switchAttempt = z.object({
  state: z.enum(["pending", "attempting", "confirmed", "failed"]),
  error: z.string().optional(),
});
const snapshotSchema = z.object({
  version: z.literal(1),
  botId: safeBotId,
  originalBot: z.looseObject({ id: safeBotId }),
  originalRegistry: originalRegistry.optional(),
  originalPresentation: z.object({
    shared: z.boolean().optional(),
    ownerId: z.string().optional(),
  }),
  transcript: z.array(message),
  memory: z.object({
    imported: z.array(z.string()),
    skipped: z.array(z.string()),
    refused: z.array(z.object({ path: z.string(), reason: z.string() })),
    notImported: z.array(z.string()),
  }),
  routines: z.array(
    z.object({
      original: z.looseObject({ id: z.string().min(1), enabled: z.boolean() }),
      native: z.looseObject({ id: z.string().min(1) }),
      pause: switchAttempt,
      resume: switchAttempt,
    }),
  ),
  receipt: z.object({
    id: z.uuid(),
    startedAt: z.number(),
    harness: nativeHarness,
    model: z.string(),
    ownerId: z.string(),
    shared: z.boolean(),
    credentialId: z.string(),
    status: z.enum(["prepared", "migrated", "needs_rollback", "rolled_back"]),
    error: z.string().optional(),
  }),
  rollback: z.object({ summary: z.string(), messages: z.array(message) }).optional(),
});
type Snapshot = z.infer<typeof snapshotSchema>;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function syncDirectory(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeSnapshot(path: string, snapshot: Snapshot, create = false) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify(snapshot, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Publish complete bytes atomically. The initial publish must never replace another snapshot.
    if (create) linkSync(temporary, path);
    else renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readSnapshot(path: string): Snapshot {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.())
      throw new Error("The rollback snapshot must be an owner-only file with mode 0600.");
    const snapshot = snapshotSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
    if (
      snapshot.originalBot.id !== snapshot.botId ||
      (snapshot.originalRegistry && snapshot.originalRegistry.id !== snapshot.botId)
    )
      throw new Error("The rollback snapshot contains conflicting bot IDs.");
    return snapshot;
  } finally {
    closeSync(fd);
  }
}

const migrationKey = (botId: string) => `hermes_migration:${botId}`;
function currentMigration(db: DatabaseSync, botId: string) {
  return db.prepare("SELECT value FROM metadata WHERE key=?").get(migrationKey(botId))?.value;
}

function routineSchedule(routine: HermesRoutine) {
  if (routine.nativeSchedule) return routine.nativeSchedule;
  const display = routine.schedule.trim();
  if (/^(?:once\b|\d{4}-\d{2}-\d{2}T)/i.test(display))
    return { kind: "once" as const, expression: routine.nextRunAt ?? display };
  const interval = /^(?:every\s+)?(\d+)\s*([mhd])$/i.exec(display);
  if (interval) {
    const multiplier: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
    return {
      kind: "interval" as const,
      expression: String(Number(interval[1]) * multiplier[interval[2].toLowerCase()]),
    };
  }
  return { kind: "cron" as const, expression: display };
}

function convertRoutine(routine: HermesRoutine, now: number) {
  if (!routine.id.trim()) throw new Error("Hermes did not provide a routine ID.");
  if (routine.running || routine.inFlight) throw new Error("Wait for the Hermes run to finish.");
  if (routine.unsupported?.length)
    throw new Error(`Unsupported Hermes settings: ${routine.unsupported.join(", ")}.`);
  const scriptCommand = routine.script?.trim() || null;
  if (!routine.prompt.trim() && !scriptCommand) throw new Error("Enter a routine prompt.");
  const schedule = routineSchedule(routine);
  const native = {
    id: randomUUID(),
    botId: routine.botId,
    name: routine.name,
    kind: schedule.kind,
    scheduleExpr: schedule.expression.trim(),
    timezone: routine.timezone ?? "UTC",
    prompt: routine.noAgent ? "" : routine.prompt,
    scriptCommand,
    enabled: routine.enabled,
    tryOnce: routine.tryOnce ?? false,
    missedPolicy: routine.catchUp ? "run_once" : "skip",
  } satisfies CreateNativeRoutine;
  firstRoutineTime(native.kind, native.scheduleExpr, native.timezone, now);
  return native;
}

function isActive(state: Bot["activity"]) {
  return ["thinking", "working", "waiting", "blocked"].includes(state);
}

async function readTranscript(input: BotMigrationInput) {
  if (isActive(input.bot.activity)) throw new Error("Wait for the active Hermes turn to finish.");
  if (input.messages) return input.messages;
  if (!input.readConversation) throw new Error("Supply the canonical Hermes transcript.");
  const conversation = await input.readConversation(input.botId);
  if (conversation.botId !== input.botId || conversation.window)
    throw new Error("Read the complete canonical transcript for this Hermes bot.");
  if (conversation.activity.state === "disconnected")
    throw new Error("Hermes is disconnected. Canonical history is unavailable.");
  if (isActive(conversation.activity.state))
    throw new Error("Wait for the active Hermes turn to finish.");
  return persistedHermesMessages(conversation);
}

function targetBot(input: BotMigrationInput, database: StoreDatabase, now: number) {
  const { botId, bot } = input;
  if (!safeBotId.safeParse(botId).success || botId !== bot.id)
    throw new Error("Choose a valid matching Hermes bot ID.");
  if (bot.harness && bot.harness !== "hermes") throw new Error("Choose a Hermes bot.");
  const harness = nativeHarness.safeParse(input.harness);
  if (!harness.success) throw new Error(`Choose ${NATIVE_HARNESS_KINDS.join(", ")}.`);
  const model = input.model.trim();
  // oxlint-disable-next-line no-control-regex -- Model names must not contain control characters.
  if (!model || model.length > 200 || /[\x00-\x1f\x7f]/.test(model) || model === "Inherited")
    throw new Error("Choose an explicit native model of up to 200 characters.");
  const bots = new ManagedBotRepository(database);
  const original = bots.getManagedBot(botId);
  if (original && (original.harness !== "hermes" || original.archivedAt !== undefined))
    throw new Error("This bot already has a native or archived managed record.");
  if (currentMigration(input.db, botId))
    throw new Error("This bot already has a migration receipt. Roll back that migration first.");
  if (new TranscriptRepository(database).syncState(botId)?.canonicalSource === "local")
    throw new Error("This bot already has a local canonical transcript.");
  if (new NativeRoutineRepository(database).list(botId).length)
    throw new Error("This bot already has native routines.");

  const presentation = new PresentationRepository(database).presentation(botId);
  const shared = input.shared ?? presentation.shared ?? original?.shared ?? bot.shared;
  const ownerId = input.ownerId ?? presentation.ownerId ?? original?.ownerId ?? bot.ownerId ?? "";
  if ((!shared || input.ownerId !== undefined) && !ownerId.trim())
    throw new Error("Choose an owner for this bot.");
  if (ownerId && !new AccountRepository(database).getUser(ownerId))
    throw new Error("Choose an owner who exists in this WildBots database.");
  const credential = input.credentialId
    ? bots.getCredential(input.credentialId)
    : (() => {
        const candidates = bots
          .listCredentials()
          .filter(
            (item) =>
              item.kind === "api_key" &&
              item.ownerId === undefined &&
              item.allowedHarnesses.includes(harness.data),
          );
        return candidates.length === 1 ? candidates[0] : undefined;
      })();
  if (!credential)
    throw new Error(
      input.credentialId
        ? "Choose a credential that still exists."
        : "Choose a credential with --credential or configure one unowned API key for this harness.",
    );

  const target = {
    id: botId,
    name: original?.name ?? bot.name,
    description: original?.description ?? bot.description ?? "",
    instructions: original?.instructions ?? bot.instructions ?? "",
    harness: harness.data,
    model,
    provider: credential.vendor,
    reasoning: "none",
    speed: "normal",
    ownerId,
    ownerOsUser: credential.osUser ?? original?.ownerOsUser ?? "",
    shared,
    credentialId: credential.id,
    enabledTools: original?.enabledTools ?? bot.enabledTools ?? [],
    enabledSkills: original?.enabledSkills ?? bot.enabledSkills ?? [],
    enabledMcpServers: [
      ...new Set([...(original?.enabledMcpServers ?? bot.enabledMcpServers ?? []), "wildbots"]),
    ],
    createdAt: original?.createdAt ?? now,
    updatedAt: now,
  } satisfies ManagedBotRecord;
  assertCredentialPolicy(target, credential, { kind: "configure" });
  const { avatar: _, ...originalPresentation } = presentation;
  return { target, original, originalPresentation };
}

export async function migrateHermesBot(input: BotMigrationInput) {
  const { botId, db } = input;
  const database = repositoryDatabase(db);
  const now = Date.now();
  const policyErrors: string[] = [];
  let configuration: ReturnType<typeof targetBot> | undefined;
  try {
    configuration = targetBot(input, database, now);
  } catch (error) {
    if (!input.dryRun) throw error;
    policyErrors.push(errorMessage(error));
  }

  const memoryRepo = new MemorySkillsRepository(database);
  type Items = Parameters<MemorySkillsRepository["importItems"]>[1];
  let items: Items = { entries: [], skills: [] };
  // The importer performs all filesystem parsing before calling importItems once.
  const collect: Pick<MemorySkillsRepository, "importItems"> = {
    importItems(id, batch) {
      items = batch;
      const imported: string[] = [];
      const skipped: string[] = [];
      for (const entry of batch.entries)
        (memoryRepo.entry(id, entry.key) ? skipped : imported).push(entry.key);
      for (const skill of batch.skills)
        (memoryRepo.skill(id, skill.slug) ? skipped : imported).push(`skills/${skill.slug}`);
      return { imported, skipped };
    },
  };
  const [transcript, allRoutines, memory] = await Promise.all([
    readTranscript(input),
    input.readRoutines(botId),
    importHermesMemoryAndSkills(collect as MemorySkillsRepository, botId, input.profileDir),
  ]);
  const uniqueTranscript = [...new Map(transcript.map((row) => [row.id, row])).values()];
  const routines = allRoutines.filter((routine) => routine.botId === botId);
  const converted: { original: HermesRoutine; native: ReturnType<typeof convertRoutine> }[] = [];
  const routineErrors: { routineId: string; error: string }[] = [];
  const seen = new Set<string>();
  for (const routine of routines) {
    try {
      if (seen.has(routine.id)) throw new Error("Duplicate Hermes routine ID.");
      seen.add(routine.id);
      converted.push({ original: routine, native: convertRoutine(routine, now) });
    } catch (error) {
      routineErrors.push({ routineId: routine.id, error: errorMessage(error) });
    }
  }
  const plan = {
    botId,
    harness: input.harness,
    model: input.model.trim(),
    messageCount: uniqueTranscript.length,
    memoryEntries: memory.imported.filter((key) => !key.startsWith("skills/")).length,
    skills: memory.imported.filter((key) => key.startsWith("skills/")).length,
    memory,
    notImported: memory.notImported,
    notImportedCount: memory.notImported.length,
    routineCount: routines.length,
    policyErrors,
    routineErrors,
  };
  if (input.dryRun) return { ...plan, status: "dry_run" as const };
  if (routineErrors.length)
    throw new Error(
      routineErrors.map(({ routineId, error }) => `${routineId}: ${error}`).join("\n"),
    );
  const ready = configuration!;
  const snapshot: Snapshot = {
    version: 1,
    botId,
    originalBot: { ...input.bot },
    originalRegistry: ready.original ? originalRegistry.parse(ready.original) : undefined,
    originalPresentation: ready.originalPresentation,
    transcript: uniqueTranscript.map((row) => ({ ...row })),
    memory,
    routines: converted.map((row) => ({
      original: { ...row.original },
      native: row.native,
      pause: { state: "pending" },
      resume: { state: "pending" },
    })),
    receipt: {
      id: randomUUID(),
      startedAt: now,
      harness: ready.target.harness,
      model: ready.target.model,
      ownerId: ready.target.ownerId,
      shared: ready.target.shared,
      credentialId: ready.target.credentialId,
      status: "prepared",
    },
  };
  const directory = resolve(input.rollbackDir);
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const snapshotPath = join(directory, `migrate-${botId}-${stamp}.json`);

  let status: "migrated" | "needs_rollback" = "migrated";
  begin(db);
  try {
    // The source was read without a write lock. Recheck the configuration before the first write.
    if (!isDeepStrictEqual(targetBot(input, database, now), ready))
      throw new Error("The bot configuration changed. Review and run the migration again.");
    const createdDirectory = mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (createdDirectory) {
      for (let parent = dirname(directory); ; parent = dirname(parent)) {
        syncDirectory(parent);
        if (parent === dirname(createdDirectory)) break;
      }
    }
    writeSnapshot(snapshotPath, snapshot, true);
    // Keep ownership of the snapshot even if publishing the native records fails.
    db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)").run(
      migrationKey(botId),
      snapshot.receipt.id,
    );
    db.exec("SAVEPOINT publish_migration");
    try {
      const transcripts = new TranscriptRepository(database);
      transcripts.replaceFromSnapshot(botId, uniqueTranscript, "hermes");
      transcripts.markCanonicalLocal(botId);
      const applied = memoryRepo.importItems(botId, items);
      snapshot.memory = { ...memory, ...applied };
      const nativeRoutines = new NativeRoutineRepository(database);
      for (const { original, native } of converted) {
        nativeRoutines.create(native);
        const next = Date.parse(original.nextRunAt ?? "");
        if (native.enabled && native.kind === "interval" && next > Date.now())
          db.prepare("UPDATE native_routines SET next_run_at=? WHERE id=?").run(next, native.id);
      }
      new ManagedBotRepository(database).upsertManagedBot(ready.target);
      const presentation = new PresentationRepository(database);
      if (
        ready.originalPresentation.shared !== ready.target.shared ||
        (ready.originalPresentation.ownerId ?? "") !== ready.target.ownerId
      )
        presentation.savePresentation(botId, {
          shared: ready.target.shared,
          ownerId: ready.target.ownerId || undefined,
          avatar: ready.originalPresentation.shared === undefined ? input.bot.avatar : undefined,
        });

      // The scheduler and router cannot see the staged rows until each Hermes pause confirms.
      for (const routine of snapshot.routines) {
        routine.pause = { state: "attempting" };
        writeSnapshot(snapshotPath, snapshot);
        try {
          await input.disableHermesRoutine(botId, routine.original.id);
          routine.pause = { state: "confirmed" };
        } catch (error) {
          routine.pause = { state: "failed", error: errorMessage(error) };
          throw new Error(
            `Could not pause Hermes routine ${routine.original.id}: ${routine.pause.error}`,
          );
        }
        writeSnapshot(snapshotPath, snapshot);
      }

      snapshot.receipt.status = status;
      writeSnapshot(snapshotPath, snapshot);
    } catch (error) {
      db.exec("ROLLBACK TO publish_migration");
      snapshot.memory = memory;
      status = "needs_rollback";
      snapshot.receipt.status = status;
      snapshot.receipt.error = errorMessage(error);
      writeSnapshot(snapshotPath, snapshot);
    }
    db.exec("RELEASE publish_migration");
    db.exec("COMMIT");
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
  }

  return {
    ...plan,
    memory: snapshot.memory,
    status,
    error: snapshot.receipt.error,
    snapshotPath,
    pausedRoutines: snapshot.routines.filter((routine) => routine.pause.state === "confirmed")
      .length,
  };
}

function summarize(messages: readonly TranscriptMessageInput[]) {
  const turns = messages.filter(
    (row) =>
      (row.role === "user" || row.role === "assistant") && !row.interim && !isActivityMessage(row),
  );
  if (!turns.length) return "No new native turns.";
  const lines = ["## Turns recorded on the native harness", ""];
  for (const row of turns.slice(-30)) {
    const speaker = row.role === "user" ? "User" : "Assistant";
    const text = row.text.replace(/\s+/g, " ").trim();
    lines.push(
      `- **${speaker}${row.createdAt ? ` (${row.createdAt})` : ""}:** ${text.length > 400 ? text.slice(0, 399) + "…" : text || "(attachment or empty message)"}`,
    );
  }
  if (turns.length > 30)
    lines.push("", `${turns.length - 30} earlier messages are in the rollback snapshot.`);
  return lines.join("\n");
}

export async function rollbackMigratedBot(input: {
  db: DatabaseSync;
  snapshotPath: string;
  reenableHermesRoutine: RoutineSwitch;
}) {
  const { db, snapshotPath } = input;
  const database = repositoryDatabase(db);
  const snapshot = transaction(db, () => {
    const saved = readSnapshot(snapshotPath);
    const { botId, receipt } = saved;
    const marker = currentMigration(db, botId);
    const bots = new ManagedBotRepository(database);
    const current = bots.getManagedBot(botId);
    if (receipt.status === "rolled_back" && !marker) return saved;
    if ((marker && marker !== receipt.id) || (!marker && current && current.harness !== "hermes"))
      throw new Error("This snapshot does not own the bot's current migration.");
    const transcripts = new TranscriptRepository(database);
    if (marker === receipt.id && transcripts.syncState(botId)?.canonicalSource === "local") {
      if (
        db
          .prepare("SELECT 1 FROM native_routine_runs WHERE bot_id=? AND status='running'")
          .get(botId) ||
        db
          .prepare("SELECT 1 FROM bot_queue WHERE bot_id=? AND status IN ('running','queued')")
          .get(botId)
      )
        throw new Error("Wait for native runs and queued turns to finish before rolling back.");
      const history = transcripts.listPage(botId, {
        limit: Math.max(1, transcripts.syncState(botId)?.messageCount ?? 0),
      }).messages;
      const messages = history.filter((row) => row.sourceRuntime === "harness");
      saved.rollback = {
        messages: messages.map((row) => ({ ...row })),
        summary: summarize(messages),
      };
      writeSnapshot(snapshotPath, saved);
      db.prepare("DELETE FROM native_routines WHERE bot_id=?").run(botId);
      if (saved.originalRegistry) bots.upsertManagedBot(saved.originalRegistry);
      else bots.deleteManagedBot(botId);
      const currentPresentation = new PresentationRepository(database);
      const { shared, ownerId } = saved.originalPresentation;
      if (shared !== undefined) currentPresentation.savePresentation(botId, { shared, ownerId });
      else {
        currentPresentation.savePresentation(botId, { shared: true });
        db.prepare("DELETE FROM bot_presentation WHERE bot_id=?").run(botId);
      }
      transcripts.replaceFromSnapshot(botId, saved.transcript, "hermes");
      db.prepare("UPDATE transcript_sync SET canonical_source='hermes' WHERE bot_id=?").run(botId);
    } else if (!saved.rollback) {
      saved.rollback = { messages: [], summary: "No new native turns." };
      writeSnapshot(snapshotPath, saved);
    }
    if (!marker)
      db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)").run(
        migrationKey(botId),
        receipt.id,
      );
    return saved;
  });

  const failures: { routineId: string; error: string }[] = [];
  const { botId } = snapshot;
  begin(db);
  try {
    // A second operator may have finished recovery between the two transactions.
    const saved = readSnapshot(snapshotPath);
    if (saved.receipt.status !== "rolled_back") {
      if (currentMigration(db, botId) !== saved.receipt.id)
        throw new Error("This snapshot does not own the bot's current migration.");
      for (const routine of saved.routines) {
        const { original } = routine;
        if (
          !original.enabled ||
          routine.pause.state === "pending" ||
          routine.resume.state === "confirmed"
        )
          continue;
        routine.resume = { state: "attempting" };
        writeSnapshot(snapshotPath, saved);
        try {
          await input.reenableHermesRoutine(botId, original.id);
          routine.resume = { state: "confirmed" };
        } catch (error) {
          routine.resume = { state: "failed", error: errorMessage(error) };
          failures.push({ routineId: original.id, error: routine.resume.error! });
        }
        writeSnapshot(snapshotPath, saved);
      }
      if (!failures.length) {
        saved.receipt.status = "rolled_back";
        writeSnapshot(snapshotPath, saved);
      }
    }
    if (saved.receipt.status === "rolled_back")
      db.prepare("DELETE FROM metadata WHERE key=? AND value=?").run(
        migrationKey(botId),
        saved.receipt.id,
      );
    db.exec("COMMIT");
    return {
      status: failures.length ? ("needs_rollback" as const) : ("rolled_back" as const),
      botId,
      summary: saved.rollback?.summary ?? "No new native turns.",
      resumedRoutines: saved.routines.filter((routine) => routine.resume.state === "confirmed")
        .length,
      failures,
    };
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
  }
}
