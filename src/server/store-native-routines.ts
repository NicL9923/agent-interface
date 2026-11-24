import { randomUUID } from "node:crypto";
import { Conflict, InvalidInput, NotFound } from "../shared/errors.js";
import { assertRoutineGroupDeliveryAllowed } from "./credential-policy.js";
import {
  firstRoutineTime,
  nextRecurringRoutineTime,
  validateQuietHours,
  type NativeRoutineKind,
  type QuietHours,
} from "./native-routine-schedule.js";
import { ManagedBotRepository } from "./store-bots.js";
import type { StoreDatabase } from "./store-database.js";

export type { NativeRoutineKind, QuietHours } from "./native-routine-schedule.js";

export type NativeRoutineStatus = "running" | "completed" | "suppressed" | "failed" | "interrupted";
export type NativeRoutineTrigger = "scheduled" | "manual" | "catchup";
export type NativeRoutineMissedPolicy = "skip" | "run_once";

export interface NativeRoutine {
  id: string;
  botId: string;
  name: string;
  kind: NativeRoutineKind;
  scheduleExpr: string;
  timezone: string;
  prompt: string;
  scriptCommand: string | null;
  modelOverride: string | null;
  enabled: boolean;
  tryOnce: boolean;
  missedPolicy: NativeRoutineMissedPolicy;
  quietHours: QuietHours | null;
  deliverToGroupId: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: NativeRoutineStatus | null;
  createdAt: number;
  updatedAt: number;
}

export interface NativeRoutineRun {
  id: string;
  routineId: string;
  botId: string;
  trigger: NativeRoutineTrigger;
  status: NativeRoutineStatus;
  startedAt: number;
  finishedAt: number | null;
  outputText: string | null;
  error: string | null;
  delivered: boolean;
}

type RoutineDefaults =
  | "id"
  | "timezone"
  | "prompt"
  | "scriptCommand"
  | "modelOverride"
  | "enabled"
  | "tryOnce"
  | "missedPolicy"
  | "quietHours"
  | "deliverToGroupId";
export type CreateNativeRoutine = Omit<
  NativeRoutine,
  RoutineDefaults | "nextRunAt" | "lastRunAt" | "lastStatus" | "createdAt" | "updatedAt"
> &
  Partial<Pick<NativeRoutine, RoutineDefaults>>;

export type NativeRoutineClaim = { routine: NativeRoutine; run: NativeRoutineRun };
type RoutineRow = Omit<NativeRoutine, "enabled" | "tryOnce" | "quietHours"> & {
  enabled: number;
  tryOnce: number;
  quietHours: string | null;
};
type RunRow = Omit<NativeRoutineRun, "delivered"> & { delivered: number };

const routineColumns = `id,bot_id AS botId,name,kind,schedule_expr AS scheduleExpr,timezone,
  prompt,script_command AS scriptCommand,model_override AS modelOverride,enabled,try_once AS tryOnce,
  missed_policy AS missedPolicy,quiet_hours_json AS quietHours,deliver_to_group_id AS deliverToGroupId,
  next_run_at AS nextRunAt,last_run_at AS lastRunAt,last_status AS lastStatus,
  created_at AS createdAt,updated_at AS updatedAt`;
const runColumns = `id,routine_id AS routineId,bot_id AS botId,trigger,status,started_at AS startedAt,
  finished_at AS finishedAt,output_text AS outputText,error,delivered`;

function readRoutine({ enabled, tryOnce, quietHours, ...row }: RoutineRow): NativeRoutine {
  return {
    ...row,
    enabled: enabled === 1,
    tryOnce: tryOnce === 1,
    quietHours: quietHours === null ? null : (JSON.parse(quietHours) as QuietHours),
  };
}

function readRun(row: RunRow): NativeRoutineRun {
  return { ...row, delivered: row.delivered === 1 };
}

export class NativeRoutineRepository {
  private readonly bots: ManagedBotRepository;

  constructor(private readonly database: StoreDatabase) {
    this.bots = new ManagedBotRepository(database);
  }

  private get db() {
    return this.database.db;
  }

  create(input: CreateNativeRoutine, now = Date.now()): NativeRoutine {
    const {
      id = randomUUID(),
      botId,
      name,
      kind,
      scheduleExpr,
      timezone = "UTC",
      prompt = "",
      scriptCommand = null,
      modelOverride = null,
      enabled = true,
      tryOnce = false,
      missedPolicy = "skip",
      quietHours = null,
      deliverToGroupId = null,
    } = input;
    if (!prompt.trim() && !scriptCommand?.trim())
      throw new InvalidInput("Enter a routine prompt or script command.");
    if (quietHours) validateQuietHours(quietHours);
    const firstRun = firstRoutineTime(kind, scheduleExpr.trim(), timezone, now);
    return this.database.transaction(() => {
      this.assertRoutineGroupDeliveryAllowed({ botId, deliverToGroupId });
      const row = this.db
        .prepare(`INSERT INTO native_routines(id,bot_id,name,kind,schedule_expr,timezone,prompt,script_command,
          model_override,enabled,try_once,missed_policy,quiet_hours_json,deliver_to_group_id,next_run_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING ${routineColumns}`)
        .get(
          id,
          botId,
          name,
          kind,
          scheduleExpr.trim(),
          timezone,
          prompt,
          scriptCommand,
          modelOverride,
          Number(enabled),
          Number(tryOnce),
          missedPolicy,
          quietHours === null ? null : JSON.stringify(quietHours),
          deliverToGroupId,
          enabled ? firstRun : null,
          now,
          now,
        ) as RoutineRow;
      return readRoutine(row);
    });
  }

  get(id: string): NativeRoutine | undefined {
    const row = this.db
      .prepare(`SELECT ${routineColumns} FROM native_routines WHERE id=?`)
      .get(id) as RoutineRow | undefined;
    return row && readRoutine(row);
  }

  list(botId: string): NativeRoutine[] {
    return (
      this.db
        .prepare(
          `SELECT ${routineColumns} FROM native_routines WHERE bot_id=? ORDER BY created_at,id`,
        )
        .all(botId) as RoutineRow[]
    ).map(readRoutine);
  }

  assertRoutineGroupDeliveryAllowed(
    routine: Pick<NativeRoutine, "botId" | "deliverToGroupId">,
  ): void {
    if (routine.deliverToGroupId === null) return;
    const bot = this.bots.getManagedBot(routine.botId);
    const credential = bot?.credentialId ? this.bots.getCredential(bot.credentialId) : undefined;
    assertRoutineGroupDeliveryAllowed(bot, credential);
  }

  /** A tick can accept a short polling delay. Earlier occurrences apply their missed policy. */
  claimDue(now: number, graceMs = 0): NativeRoutineClaim[] {
    return this.database.transaction(() => {
      const due = this.db
        .prepare(`SELECT ${routineColumns} FROM native_routines r
        WHERE enabled=1 AND next_run_at<=? AND NOT EXISTS (
          SELECT 1 FROM native_routine_runs WHERE routine_id=r.id AND status='running'
        ) ORDER BY next_run_at,id`)
        .all(now) as RoutineRow[];
      const claims: NativeRoutineClaim[] = [];
      for (const row of due) {
        const routine = readRoutine(row);
        const dueAt = routine.nextRunAt!;
        const earliest = now - graceMs;
        const { kind, scheduleExpr, timezone } = routine;
        const next =
          kind === "once"
            ? null
            : nextRecurringRoutineTime(kind, scheduleExpr, timezone, now, dueAt);
        const scheduled =
          dueAt >= earliest ||
          (kind !== "once" &&
            nextRecurringRoutineTime(kind, scheduleExpr, timezone, earliest - 1, dueAt) <= now);
        if (!scheduled && routine.missedPolicy === "skip") {
          this.setSchedule(routine.id, next, now);
          continue;
        }

        const nextRunAt = routine.tryOnce ? null : next;
        this.setSchedule(routine.id, nextRunAt, now);
        claims.push(
          this.claim(
            { ...routine, enabled: nextRunAt !== null, nextRunAt },
            scheduled ? "scheduled" : "catchup",
            now,
          ),
        );
      }
      return claims;
    });
  }

  claimManual(id: string, now: number): NativeRoutineClaim {
    return this.database.transaction(() => {
      const routine = this.get(id);
      if (!routine) throw new NotFound("Routine not found.");
      if (
        this.db
          .prepare("SELECT 1 FROM native_routine_runs WHERE routine_id=? AND status='running'")
          .get(id)
      )
        throw new Conflict("This routine already has a running execution.");
      this.assertRoutineGroupDeliveryAllowed(routine);
      if (routine.kind === "once" || routine.tryOnce) {
        this.setSchedule(id, null, now);
        routine.enabled = false;
        routine.nextRunAt = null;
      }
      return this.claim(routine, "manual", now);
    });
  }

  private setSchedule(id: string, next: number | null, now: number): void {
    this.db
      .prepare("UPDATE native_routines SET enabled=?,next_run_at=?,updated_at=? WHERE id=?")
      .run(Number(next !== null), next, now, id);
  }

  private claim(
    routine: NativeRoutine,
    trigger: NativeRoutineTrigger,
    now: number,
  ): NativeRoutineClaim {
    const row = this.db
      .prepare(`INSERT INTO native_routine_runs(id,routine_id,bot_id,trigger,status,started_at)
      VALUES(?,?,?,?,'running',?) RETURNING ${runColumns}`)
      .get(randomUUID(), routine.id, routine.botId, trigger, now) as RunRow;
    this.db
      .prepare(
        "UPDATE native_routines SET last_run_at=?,last_status='running',updated_at=? WHERE id=?",
      )
      .run(now, now, routine.id);
    return {
      routine: { ...routine, lastRunAt: now, lastStatus: "running", updatedAt: now },
      run: readRun(row),
    };
  }

  /** Only the scheduler owner should call this, once on startup before it launches work. */
  recoverInterruptedRuns(now = Date.now()): number {
    return this.database.transaction(() => {
      this.db
        .prepare(`UPDATE native_routines SET last_status='interrupted',updated_at=?
        WHERE id IN (SELECT routine_id FROM native_routine_runs WHERE status='running')`)
        .run(now);
      return Number(
        this.db
          .prepare(`UPDATE native_routine_runs SET status='interrupted',finished_at=?,
        error='Scheduler restarted during execution.' WHERE status='running'`)
          .run(now).changes,
      );
    });
  }

  recordCompletion(runId: string, now: number, outputText: string, delivered: boolean) {
    return this.settle(runId, "completed", now, outputText, null, delivered);
  }

  recordSuppressed(runId: string, now: number, outputText: string | null = null) {
    return this.settle(runId, "suppressed", now, outputText, null, false);
  }

  recordFailure(runId: string, now: number, error: string, outputText: string | null = null) {
    return this.settle(runId, "failed", now, outputText, error, false);
  }

  recordInterrupted(runId: string, now: number, error: string) {
    return this.settle(runId, "interrupted", now, null, error, false);
  }

  private settle(
    runId: string,
    status: Exclude<NativeRoutineStatus, "running">,
    now: number,
    outputText: string | null,
    error: string | null,
    delivered: boolean,
  ): NativeRoutineRun | undefined {
    return this.database.transaction(() => {
      const row = this.db
        .prepare(`UPDATE native_routine_runs SET status=?,finished_at=?,output_text=?,error=?,delivered=?
        WHERE id=? AND status='running' RETURNING ${runColumns}`)
        .get(status, now, outputText, error, Number(delivered), runId) as RunRow | undefined;
      if (!row) return;
      this.db
        .prepare("UPDATE native_routines SET last_status=?,updated_at=? WHERE id=?")
        .run(status, now, row.routineId);
      return readRun(row);
    });
  }

  isRunRunning(runId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM native_routine_runs WHERE id=? AND status='running'")
        .get(runId) !== undefined
    );
  }

  listRuns(routineId: string): NativeRoutineRun[] {
    return (
      this.db
        .prepare(`SELECT ${runColumns} FROM native_routine_runs WHERE routine_id=?
      ORDER BY started_at DESC,rowid DESC`)
        .all(routineId) as RunRow[]
    ).map(readRun);
  }

  forgetBot(botId: string): void {
    this.db.prepare("DELETE FROM native_routines WHERE bot_id=?").run(botId);
  }
}
