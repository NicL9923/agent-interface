import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  migrateHermesBot,
  migrationFileKeys,
  rollbackMigratedBot,
  type BotMigrationInput,
} from "../src/server/bot-migrator.js";
import { createHermesRuntime } from "../src/server/hermes.js";
import { fileSigner } from "../src/server/hermes-files.js";
import { nativeOverrides } from "../src/server/hermes-helpers.js";
import { createHermesTransport } from "../src/server/hermes-transport.js";
import { NATIVE_HARNESS_KINDS } from "../src/shared/harness.js";

const usage = `Usage
  tsx scripts/migrate-bot.ts --bot <id> --harness <${NATIVE_HARNESS_KINDS.join("|")}> --model <model>
    --db <path> --hermes-profile-dir <dir> --rollback-dir <dir>
    [--credential <id>] [--owner <userId>] [--shared] [--dry-run] [--json]
  tsx scripts/migrate-bot.ts --rollback <snapshot.json> --db <path> [--json]

Run with Bun by replacing "tsx" with "bun run".
Connect to Hermes via HERMES_URL, HERMES_TOKEN and HERMES_AUTH_MODE from the environment or .env.
Run live cutovers and rollbacks with the bot idle and submissions paused.
For routines that inherit the Hermes host's time zone, run on that host or set HERMES_TIMEZONE.`;

export function parseMigrationArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      bot: { type: "string" },
      harness: { type: "string" },
      model: { type: "string" },
      db: { type: "string" },
      "hermes-profile-dir": { type: "string" },
      "rollback-dir": { type: "string" },
      credential: { type: "string" },
      owner: { type: "string" },
      shared: { type: "boolean" },
      "dry-run": { type: "boolean" },
      rollback: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return { action: "help" as const };
  const required = (key: keyof typeof values) => {
    const value = values[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`Provide --${key}.`);
    return value;
  };
  const db = required("db");
  const json = values.json ?? false;
  if (values.rollback !== undefined) {
    const conflict = Object.keys(values).find((key) => !["rollback", "db", "json"].includes(key));
    if (conflict) throw new Error(`--${conflict} cannot be combined with --rollback.`);
    return { action: "rollback" as const, db, json, snapshotPath: required("rollback") };
  }
  return {
    action: "migrate" as const,
    db,
    json,
    botId: required("bot"),
    harness: required("harness"),
    model: required("model"),
    profileDir: required("hermes-profile-dir"),
    rollbackDir: required("rollback-dir"),
    credentialId: values.credential === undefined ? undefined : required("credential"),
    ownerId: values.owner === undefined ? undefined : required("owner"),
    shared: values.shared,
    dryRun: values["dry-run"] ?? false,
  };
}

const rawCronJob = z.looseObject({
  id: z.string().optional(),
  job_id: z.string().optional(),
  name: z.string(),
  prompt: z.string().nullish(),
  schedule_display: z.string().nullish(),
  schedule: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("cron"), expr: z.string() }),
    z.object({ kind: z.literal("once"), run_at: z.string() }),
    z.object({ kind: z.literal("interval"), minutes: z.number().int().positive() }),
  ]),
  timezone: z.string().nullish(),
  effective_timezone: z.string().nullish(),
  enabled: z.boolean().nullish(),
  state: z.string().nullish(),
  next_run_at: z.string().nullish(),
  script: z.string().nullish(),
  no_agent: z.boolean().nullish(),
  repeat: z
    .object({ times: z.number().int().nullish(), completed: z.number().int().nullish() })
    .nullish(),
});

async function profileTimezone(directory: string) {
  const config = await readFile(join(directory, "config.yaml"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  const raw = /^timezone:[ \t]*(.*)$/m.exec(config)?.[1]?.trim();
  const configured = raw
    ?.split(/\s+#/)[0]
    .replace(/^(['"])(.*)\1$/, "$2")
    .trim();
  return (
    process.env.HERMES_TIMEZONE?.trim() ||
    (configured && !["null", "~"].includes(configured) ? configured : undefined) ||
    Intl.DateTimeFormat().resolvedOptions().timeZone
  );
}

const IGNORED_HERMES_ROUTINE_FIELDS = new Set([
  "repeat",
  "timezone",
  "effective_timezone",
  "profile",
  "profile_name",
  "skill",
  "script",
  "no_agent",
  "hermes_home",
  "is_default_profile",
  "scheduler_heartbeat_age_s",
  "attach_to_session",
  "catch_up",
  "workdir",
  "monitor_script",
  "failure_deliver",
  "canonical_completions",
  "last_delivery_queued",
  "last_dispatch",
  "latest_execution",
  "live_execution",
  "fire_claim",
  "run_claim",
  "paused_at",
  "paused_reason",
]);

function resolveRoutineScript(
  script: string | null | undefined,
  profileDir: string,
): string | null {
  const trimmed = script?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) return trimmed;
  const scriptPath = resolve(join(profileDir, "scripts", trimmed));
  if (scriptPath.endsWith(".py")) return `/usr/bin/python3 ${scriptPath}`;
  if (scriptPath.endsWith(".sh")) return `/bin/bash ${scriptPath}`;
  return scriptPath;
}

function toRoutine(
  botId: string,
  job: z.infer<typeof rawCronJob>,
  fallbackTimezone: string,
  profileDir: string,
) {
  const { schedule } = job;
  const id = job.id ?? job.job_id ?? "";
  const expression =
    schedule.kind === "cron"
      ? schedule.expr
      : schedule.kind === "once"
        ? schedule.run_at.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/u, "$1")
        : String(schedule.minutes * 60_000);
  const enabled = job.enabled !== false && job.state !== "paused";
  const remaining =
    job.repeat?.times == null ? null : job.repeat.times - (job.repeat.completed ?? 0);
  const unsupported = nativeOverrides(job).filter(
    (field) => !IGNORED_HERMES_ROUTINE_FIELDS.has(field),
  );
  if (remaining !== null && remaining !== 1 && (enabled || remaining > 1))
    unsupported.push("repeat count");
  const name = job.name.replace(`[bot:${botId}] `, "");
  return {
    id,
    botId,
    name,
    prompt: job.prompt ?? "",
    schedule: job.schedule_display ?? expression,
    enabled,
    timezone: job.timezone || job.effective_timezone || fallbackTimezone,
    nativeSchedule: { kind: schedule.kind, expression },
    nextRunAt: job.next_run_at ?? undefined,
    tryOnce: remaining === 1,
    catchUp: job.catch_up === true,
    running: Boolean(job.live_execution),
    inFlight: Boolean(job.fire_claim || job.run_claim),
    script: resolveRoutineScript(job.script, profileDir),
    noAgent: job.no_agent === true,
    unsupported,
    // Keep the full Hermes record in the snapshot, including delivery and skill selections.
    hermesJob: job,
  };
}

function printResult(
  result: Awaited<ReturnType<typeof migrateHermesBot | typeof rollbackMigratedBot>>,
  json: boolean,
) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if ("summary" in result) {
    console.log(
      result.status === "rolled_back"
        ? `Restored ${result.botId} to Hermes. Resumed ${result.resumedRoutines} routines.`
        : `Restored local routing for ${result.botId}. Retry rollback to resume the remaining Hermes routines.`,
    );
    for (const failure of result.failures)
      console.log(`Routine ${failure.routineId}: ${failure.error}`);
    console.log(result.summary);
    return;
  }
  if (result.status === "migrated")
    console.log(`Migrated ${result.botId} to ${result.harness} with ${result.model}.`);
  else if (result.status === "dry_run")
    console.log(`Dry run for ${result.botId} on ${result.harness} with ${result.model}.`);
  else console.log(`Migration needs rollback. ${result.error}`);
  console.log(
    `${result.messageCount} messages, ${result.memoryEntries} memory entries, ${result.skills} skills, ${result.routineCount} routines.`,
  );
  if (result.notImportedCount) console.log(`Skipped ${result.notImportedCount} skill assets.`);
  for (const path of result.notImported) console.log(`  ${path}`);
  for (const file of result.memory.refused)
    console.log(`Profile file refused: ${file.path} (${file.reason})`);
  for (const error of result.policyErrors) console.log(error);
  for (const { routineId, error } of result.routineErrors)
    console.log(`Routine ${routineId}: ${error}`);
  if ("snapshotPath" in result) console.log(`Rollback snapshot: ${result.snapshotPath}`);
}

export async function runMigrationCli(args: string[]) {
  const flags = parseMigrationArgs(args);
  if (flags.action === "help") {
    console.log(usage);
    return 0;
  }
  if (existsSync(".env")) loadEnvFile(".env");
  const env = process.env;
  const authMode = env.HERMES_AUTH_MODE || "static";
  if (authMode !== "static" && authMode !== "service")
    throw new Error("Choose static or service for HERMES_AUTH_MODE.");
  const options = {
    url: env.HERMES_URL,
    token: env.HERMES_TOKEN,
    authMode,
    qualificationFile: env.HERMES_QUALIFICATION_FILE || undefined,
  } as const;
  if (!existsSync(flags.db)) throw new Error("Provide an existing WildBots database.");
  const db = new DatabaseSync(flags.db, { readOnly: flags.action === "migrate" && flags.dryRun });
  let runtime: ReturnType<typeof createHermesRuntime> | undefined;
  let transport: ReturnType<typeof createHermesTransport> | undefined;
  const hermes = () =>
    (runtime ??= createHermesRuntime({
      ...options,
      files: fileSigner(migrationFileKeys(db), options.token),
    }));
  async function jobs(botId: string) {
    transport ??= createHermesTransport(options, {
      frame() {},
      disconnected() {},
      connected() {},
      watching: () => false,
    });
    const response = await transport.http(`/api/cron/jobs?profile=${encodeURIComponent(botId)}`);
    return z.array(rawCronJob).parse(await response.json());
  }
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const inactiveOnRead = new Set<string>();
    const result =
      flags.action === "rollback"
        ? await rollbackMigratedBot({
            db,
            snapshotPath: flags.snapshotPath,
            reenableHermesRoutine: (botId, id) => hermes().setRoutineEnabled!(botId, id, true),
          })
        : await migrateHermesBot({
            ...flags,
            db,
            bot: await hermes().botDetail!(flags.botId),
            readConversation: (botId) => hermes().conversation(botId),
            readRoutines: async (botId) => {
              const [records, timezone] = await Promise.all([
                jobs(botId),
                profileTimezone(flags.profileDir),
              ]);
              for (const record of records) {
                const recordId = record.id ?? record.job_id;
                if (
                  recordId &&
                  (record.enabled === false ||
                    record.state === "paused" ||
                    record.state === "completed") &&
                  !record.live_execution &&
                  !record.fire_claim &&
                  !record.run_claim
                )
                  inactiveOnRead.add(recordId);
              }
              return records.map((record) => toRoutine(botId, record, timezone, flags.profileDir));
            },
            disableHermesRoutine: async (botId, id) => {
              if (!inactiveOnRead.has(id)) await hermes().setRoutineEnabled!(botId, id, false);
              const job = (await jobs(botId)).find((record) => (record.id ?? record.job_id) === id);
              if (
                !job ||
                (job.enabled !== false && job.state !== "paused" && job.state !== "completed") ||
                job.live_execution ||
                job.fire_claim ||
                job.run_claim
              )
                throw new Error("Hermes could not confirm that the paused routine is idle.");
            },
          } satisfies BotMigrationInput);
    printResult(result, flags.json);
    return result.status === "needs_rollback" ||
      ("policyErrors" in result && (result.policyErrors.length || result.routineErrors.length))
      ? 1
      : 0;
  } finally {
    try {
      await runtime?.close?.();
    } finally {
      transport?.close();
      db.close();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runMigrationCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes("--json")) console.log(JSON.stringify({ error: message }));
    else console.error(message);
    process.exitCode = 1;
  }
}
