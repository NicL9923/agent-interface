import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Conflict, InvalidInput } from "../src/shared/errors.js";
import {
  isHeartbeatQuiet,
  isInQuietHours,
  NativeScheduler,
  nextCronTime,
} from "../src/server/scheduler.js";
import { ManagedBotRepository } from "../src/server/store-bots.js";
import { schemaVersion, StoreDatabase } from "../src/server/store-database.js";
import {
  NativeRoutineRepository,
  type CreateNativeRoutine,
} from "../src/server/store-native-routines.js";

const epoch = Date.parse;
const start = epoch("2026-11-23T12:00:00Z");

function pendingOutput() {
  let resolve!: (output: string) => void;
  const promise = new Promise<string>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("cron time", () => {
  it("uses five fields, lists, inclusive ranges, steps, and named months", () => {
    expect(nextCronTime("5,10-20/5 8-9 * NOV MON-FRI", "UTC", start)).toBe(
      epoch("2026-11-24T08:05:00Z"),
    );
    expect(
      nextCronTime("5,10-20/5 8-9 * NOV MON-FRI", "UTC", epoch("2026-11-24T08:10:00.001Z")),
    ).toBe(epoch("2026-11-24T08:15:00Z"));
    expect(nextCronTime("*/15 * * * *", "UTC", start)).toBe(start + 900_000);
  });

  it("uses either restricted day field and recognizes 7 as Sunday", () => {
    const expression = "0 12 15 * 7";
    expect(nextCronTime(expression, "UTC", epoch("2026-11-10T00:00:00Z"))).toBe(
      epoch("2026-11-15T12:00:00Z"),
    );
    expect(nextCronTime(expression, "UTC", epoch("2026-11-15T12:00:00Z"))).toBe(
      epoch("2026-11-22T12:00:00Z"),
    );
    expect(nextCronTime(expression, "UTC", epoch("2026-12-13T12:00:00Z"))).toBe(
      epoch("2026-12-15T12:00:00Z"),
    );
    expect(nextCronTime("0 12 */5 * MON", "UTC", start)).toBe(epoch("2026-12-21T12:00:00Z"));
  });

  it.each([
    ["0 1 * *", "five fields"],
    ["60 * * * *", "minute field"],
    ["* 20-10 * * *", "hour field"],
    ["* * 0 * *", "day of month field"],
    ["* * * JAM *", "month field"],
    ["* * * * 8", "day of week field"],
    ["*/0 * * * *", "minute field"],
    ["1/2 * * * *", "minute field"],
    ["1,,2 * * * *", "minute field"],
    ["0 0 31 2 *", "no matching date"],
  ])("rejects %s and names the invalid field or date", (expression, reason) => {
    const next = () => nextCronTime(expression, "UTC", start);
    expect(next).toThrow(InvalidInput);
    expect(next).toThrow(reason);
  });

  it.each(["America/Nowhere", "+01:00"])("requires a named IANA zone (%s)", (timezone) => {
    expect(() => nextCronTime("0 9 * * *", timezone, start)).toThrow(
      new InvalidInput("Choose a valid IANA time zone."),
    );
  });

  it("skips nonexistent Chicago wall times and returns both instants when clocks fall back", () => {
    expect(nextCronTime("30 2 * * *", "America/Chicago", epoch("2026-03-08T06:00:00Z"))).toBe(
      epoch("2026-03-09T07:30:00Z"),
    );
    const first = nextCronTime("30 1 * * *", "America/Chicago", epoch("2026-11-01T05:00:00Z"));
    expect(first).toBe(epoch("2026-11-01T06:30:00Z"));
    const second = nextCronTime("30 1 * * *", "America/Chicago", first);
    expect(second).toBe(epoch("2026-11-01T07:30:00Z"));
    expect(nextCronTime("30 1 * * *", "America/Chicago", second)).toBe(
      epoch("2026-11-02T07:30:00Z"),
    );
  });

  it("handles a half-hour fall-back and retains UTC's continuous minutes", () => {
    const first = nextCronTime("45 1 * * *", "Australia/Lord_Howe", epoch("2026-04-04T12:00:00Z"));
    expect(first).toBe(epoch("2026-04-04T14:45:00Z"));
    expect(nextCronTime("45 1 * * *", "Australia/Lord_Howe", first)).toBe(
      epoch("2026-04-04T15:15:00Z"),
    );
    expect(nextCronTime("30 2 * * *", "UTC", epoch("2026-03-08T01:00:00Z"))).toBe(
      epoch("2026-03-08T02:30:00Z"),
    );
  });

  it("finds leap day across a non-leap century", () => {
    expect(nextCronTime("0 0 29 FEB *", "UTC", epoch("2096-02-29T00:00:00Z"))).toBe(
      epoch("2104-02-29T00:00:00Z"),
    );
  });

  it("rejects an invalid starting instant", () => {
    expect(() => nextCronTime("* * * * *", "UTC", NaN)).toThrow("valid cron search time");
  });

  it("rejects missing cron input instead of falling back to the server time zone", () => {
    const missing = undefined as unknown as string;
    expect(() => nextCronTime("* * * * *", missing, start)).toThrow("valid IANA time zone");
    expect(() => nextCronTime(missing, "UTC", start)).toThrow("five fields");
  });
});

describe("heartbeat quiet checks", () => {
  it("accepts punctuation around the exact marker and preserves text or symbols that carry an alert", () => {
    expect(isHeartbeatQuiet("HEARTBEAT_OK")).toBe(true);
    expect(isHeartbeatQuiet(" \n**HEARTBEAT_OK.** \n")).toBe(true);
    expect(isHeartbeatQuiet("`HEARTBEAT_OK`")).toBe(true);
    expect(isHeartbeatQuiet("HEARTBEAT_OK. The gate is open.")).toBe(false);
    expect(isHeartbeatQuiet("HEARTBEAT_OK ⚠️")).toBe(false);
    expect(isHeartbeatQuiet("heartbeat_ok")).toBe(false);
    expect(isHeartbeatQuiet("")).toBe(false);
  });

  it("checks local quiet hours across midnight with an inclusive start and exclusive end", () => {
    const quietHours = { start: "22:00", end: "07:00" };
    const quiet = (time: string) => isInQuietHours(quietHours, "America/Chicago", epoch(time));
    expect(quiet("2026-11-23T03:59:59Z")).toBe(false);
    expect(quiet("2026-11-23T04:00:00Z")).toBe(true);
    expect(quiet("2026-11-23T06:00:00Z")).toBe(true);
    expect(quiet("2026-11-23T12:59:59Z")).toBe(true);
    expect(quiet("2026-11-23T13:00:00Z")).toBe(false);
    expect(isInQuietHours({ start: "12:00", end: "13:00" }, "UTC", start)).toBe(true);
    expect(isInQuietHours({ start: "12:00", end: "12:00" }, "UTC", start)).toBe(false);
  });
});

describe("durable native scheduler", () => {
  let database: StoreDatabase;
  let repository: NativeRoutineRepository;
  let now: number;
  const create = (id: string, options: Partial<CreateNativeRoutine> = {}) =>
    repository.create(
      {
        id,
        botId: "bot",
        name: id,
        kind: "interval",
        scheduleExpr: "1000",
        prompt: "Check the gate.",
        ...options,
      },
      now,
    );

  beforeEach(() => {
    database = new StoreDatabase(":memory:");
    repository = new NativeRoutineRepository(database);
    now = start;
  });

  afterEach(() => {
    vi.useRealTimers();
    database.close();
  });

  it("prevents overlapping scheduled and manual runs and lets another routine proceed", async () => {
    const slow = create("slow");
    const fast = create("fast", { scheduleExpr: "2000" });
    const response = pendingOutput();
    const executeRun = vi.fn((routine: { id: string }) =>
      routine.id === slow.id ? response.promise : "fast output",
    );
    const onDeliver = vi.fn();
    const scheduler = new NativeScheduler(repository, { now: () => now, executeRun, onDeliver });

    now += 1000;
    const firstTick = scheduler.tick();
    await expect(scheduler.runNow(slow.id)).rejects.toThrow(
      new Conflict("This routine already has a running execution."),
    );
    now += 1000;
    await scheduler.tick();
    expect(repository.listRuns(slow.id)).toMatchObject([
      { status: "running", startedAt: start + 1000 },
    ]);
    expect(repository.listRuns(fast.id)).toMatchObject([
      { status: "completed", startedAt: start + 2000 },
    ]);

    response.resolve("slow output");
    await firstTick;
    const second = await scheduler.runNow(slow.id);
    expect(second).toMatchObject({ trigger: "manual", status: "completed" });
    expect(onDeliver).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: slow.id }),
      expect.objectContaining({ id: second?.id }),
      "slow output",
      expect.any(AbortSignal),
    );
    expect(repository.get(slow.id)?.nextRunAt).toBe(start + 2000);
  });

  it("skips stale work or catches up once and keeps the original interval cadence", async () => {
    const skip = create("skip");
    const catchup = create("catchup", { missedPolicy: "run_once" });
    const executeRun = vi.fn(() => "done");
    const scheduler = new NativeScheduler(repository, {
      now: () => now,
      executeRun,
      onDeliver: vi.fn(),
    });

    now += 3500;
    await scheduler.tick(0);
    await scheduler.tick(0);
    expect(repository.listRuns(skip.id)).toEqual([]);
    expect(repository.listRuns(catchup.id)).toMatchObject([{ trigger: "catchup", startedAt: now }]);
    expect(repository.get(skip.id)?.nextRunAt).toBe(start + 4000);
    expect(repository.get(catchup.id)?.nextRunAt).toBe(start + 4000);

    now = start + 4050;
    await scheduler.tick(100);
    expect(repository.listRuns(skip.id)).toMatchObject([{ trigger: "scheduled", startedAt: now }]);
    expect(repository.listRuns(catchup.id).map((run) => run.trigger)).toEqual([
      "scheduled",
      "catchup",
    ]);
  });

  it("runs an on-time occurrence even when an older occurrence expired", () => {
    const interval = create("interval");
    const cron = create("cron", { kind: "cron", scheduleExpr: "* * * * *" });
    expect(repository.claimDue(start + 120_000)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run: expect.objectContaining({ routineId: interval.id, trigger: "scheduled" }),
        }),
        expect.objectContaining({
          run: expect.objectContaining({ routineId: cron.id, trigger: "scheduled" }),
        }),
      ]),
    );
  });

  it("disables scheduled once and try-once jobs as part of the claim", () => {
    const once = create("once", { kind: "once", scheduleExpr: "2026-11-23T06:00:01-06:00" });
    const tryOnce = create("try", { tryOnce: true });
    expect(repository.claimDue(start + 1000).map(({ routine }) => routine)).toMatchObject([
      { id: once.id, enabled: false, nextRunAt: null, lastStatus: "running" },
      { id: tryOnce.id, enabled: false, nextRunAt: null, lastStatus: "running" },
    ]);
    for (const routine of [once, tryOnce]) {
      const [run] = repository.listRuns(routine.id);
      repository.recordCompletion(run.id, start + 1100, "done", false);
      expect(repository.get(routine.id)).toMatchObject({
        enabled: false,
        nextRunAt: null,
        lastStatus: "completed",
      });
    }
    expect(repository.claimDue(start + 2000)).toEqual([]);
  });

  it("expires a missed once job, preserves an unattempted try-once job, and consumes it on a manual attempt", async () => {
    const once = create("expired", { kind: "once", scheduleExpr: "2026-11-23T12:00:01Z" });
    const tryOnce = create("try", { tryOnce: true });
    now += 1500;
    expect(repository.claimDue(now)).toEqual([]);
    expect(repository.get(once.id)).toMatchObject({
      enabled: false,
      nextRunAt: null,
      lastStatus: null,
    });
    expect(repository.get(tryOnce.id)).toMatchObject({ enabled: true, nextRunAt: start + 2000 });

    const scheduler = new NativeScheduler(repository, {
      now: () => now,
      executeRun: () => {
        throw new Error("Turn failed");
      },
      onDeliver: vi.fn(),
    });
    await expect(scheduler.runNow(tryOnce.id)).resolves.toMatchObject({
      trigger: "manual",
      status: "failed",
      error: "Turn failed",
    });
    expect(repository.get(tryOnce.id)).toMatchObject({
      enabled: false,
      nextRunAt: null,
      lastStatus: "failed",
    });
  });

  it("passes script-only jobs through the executor and records delivery failures with their output", async () => {
    const routine = create("script", {
      prompt: "",
      scriptCommand: "./check-gate",
      modelOverride: "configured-model",
    });
    const executeRun = vi.fn(() => "The gate is open.");
    const onDeliver = vi.fn(() => {
      throw new Error("Delivery unavailable");
    });
    const scheduler = new NativeScheduler(repository, { now: () => now, executeRun, onDeliver });

    await expect(scheduler.runNow(routine.id)).resolves.toMatchObject({
      status: "failed",
      outputText: "The gate is open.",
      error: "Delivery unavailable",
      delivered: false,
    });
    expect(executeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: routine.id,
        scriptCommand: "./check-gate",
        modelOverride: "configured-model",
      }),
      expect.objectContaining({ routineId: routine.id, trigger: "manual" }),
      expect.any(AbortSignal),
    );
  });

  it("suppresses quiet hours before execution and suppresses a quiet reply before delivery", async () => {
    now = epoch("2026-11-23T12:59:58Z");
    const routine = create("heartbeat", {
      kind: "heartbeat",
      timezone: "America/Chicago",
      quietHours: { start: "22:00", end: "07:00" },
    });
    const executeRun = vi
      .fn()
      .mockReturnValueOnce(" **HEARTBEAT_OK!** ")
      .mockReturnValueOnce("HEARTBEAT_OK. The gate is open.");
    const onDeliver = vi.fn();
    const scheduler = new NativeScheduler(repository, { now: () => now, executeRun, onDeliver });
    now += 1000;
    await scheduler.tick();
    expect(executeRun).not.toHaveBeenCalled();
    expect(repository.listRuns(routine.id)).toMatchObject([
      { status: "suppressed", outputText: null, delivered: false },
    ]);
    now += 1000;
    await scheduler.tick();
    expect(repository.listRuns(routine.id)[0]).toMatchObject({
      status: "suppressed",
      outputText: " **HEARTBEAT_OK!** ",
      delivered: false,
    });
    expect(onDeliver).not.toHaveBeenCalled();

    now += 1000;
    await scheduler.tick();
    const [alert] = repository.listRuns(routine.id);
    expect(alert).toMatchObject({ status: "completed", delivered: true });
    expect(onDeliver).toHaveBeenCalledWith(
      expect.objectContaining({ id: routine.id }),
      expect.objectContaining({ id: alert.id }),
      "HEARTBEAT_OK. The gate is open.",
      expect.any(AbortSignal),
    );
  });

  it("delivers the marker unchanged for a non-heartbeat routine", async () => {
    const routine = create("regular");
    const onDeliver = vi.fn();
    const scheduler = new NativeScheduler(repository, {
      now: () => now,
      executeRun: () => "HEARTBEAT_OK",
      onDeliver,
    });
    await expect(scheduler.runNow(routine.id)).resolves.toMatchObject({
      status: "completed",
      delivered: true,
    });
    expect(onDeliver).toHaveBeenCalledWith(
      expect.objectContaining({ id: routine.id }),
      expect.anything(),
      "HEARTBEAT_OK",
      expect.any(AbortSignal),
    );
  });

  it("honors quiet hours on a regular check-in that configures them", async () => {
    const routine = create("check-in", { quietHours: { start: "12:00", end: "13:00" } });
    const executeRun = vi.fn(() => "unexpected");
    const onDeliver = vi.fn();
    const scheduler = new NativeScheduler(repository, { now: () => now, executeRun, onDeliver });
    await expect(scheduler.runNow(routine.id)).resolves.toMatchObject({ status: "suppressed" });
    expect(executeRun).not.toHaveBeenCalled();
    expect(onDeliver).not.toHaveBeenCalled();
  });

  it("suppresses delivery when a run finishes inside quiet hours", async () => {
    now = epoch("2026-11-23T03:59:59Z");
    const routine = create("heartbeat", {
      kind: "heartbeat",
      timezone: "America/Chicago",
      quietHours: { start: "22:00", end: "07:00" },
    });
    const response = pendingOutput();
    const executeRun = vi.fn(() => response.promise);
    const onDeliver = vi.fn();
    const scheduler = new NativeScheduler(repository, { now: () => now, executeRun, onDeliver });
    const running = scheduler.runNow(routine.id);
    await Promise.resolve();
    now += 1000;
    response.resolve("The gate is open.");
    await expect(running).resolves.toMatchObject({
      status: "suppressed",
      outputText: "The gate is open.",
      delivered: false,
    });
    expect(onDeliver).not.toHaveBeenCalled();
  });

  it("validates routine inputs before writing a schedule", () => {
    expect(() => create("empty", { prompt: " " })).toThrow(
      "Enter a routine prompt or script command.",
    );
    expect(() => create("interval", { scheduleExpr: "0" })).toThrow("positive, whole interval");
    expect(() => create("once", { kind: "once", scheduleExpr: "2026-02-30T00:00Z" })).toThrow(
      "ISO timestamp",
    );
    expect(() => create("local", { kind: "once", scheduleExpr: "2026-02-28T00:00" })).toThrow(
      "ISO timestamp",
    );
    expect(() => create("quiet", { quietHours: { start: "24:00", end: "07:00" } })).toThrow(
      "HH:MM",
    );
    expect(repository.list("bot")).toEqual([]);
  });

  it("aborts a run without releasing its lock until the executor stops", async () => {
    const routine = create("slow");
    const response = pendingOutput();
    const executeRun = vi.fn(() => response.promise);
    const onDeliver = vi.fn();
    const scheduler = new NativeScheduler(repository, { now: () => now, executeRun, onDeliver });

    const running = scheduler.runNow(routine.id);
    await Promise.resolve();
    expect(scheduler.stopRun(routine.id)).toBe(true);
    expect(executeRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ aborted: true }),
    );
    expect(scheduler.stopRun(routine.id)).toBe(false);
    await expect(scheduler.runNow(routine.id)).rejects.toThrow("already has a running execution");
    response.resolve("late reply");
    await expect(running).resolves.toMatchObject({ status: "interrupted", delivered: false });
    expect(onDeliver).not.toHaveBeenCalled();
  });

  it("stops polling and waits for the abort-aware executor to settle", async () => {
    vi.useFakeTimers();
    const routine = create("timer");
    const executeRun = vi.fn(
      (_routine, _run, signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const onDeliver = vi.fn();
    const scheduler = new NativeScheduler(repository, {
      now: () => now,
      executeRun,
      onDeliver,
      tickIntervalMs: 100,
    });
    scheduler.start();
    now += 1000;
    await vi.advanceTimersByTimeAsync(100);
    await scheduler.stop();
    expect(repository.listRuns(routine.id)).toMatchObject([
      { status: "interrupted", error: "Routine stopped." },
    ]);
    now += 1000;
    await vi.advanceTimersByTimeAsync(100);
    expect(executeRun).toHaveBeenCalledTimes(1);
    expect(onDeliver).not.toHaveBeenCalled();
    await expect(scheduler.runNow(routine.id)).rejects.toThrow("scheduler is stopped");
  });

  it("refuses an invalid poll interval and refuses to recover over its own manual run", async () => {
    const routine = create("active");
    const response = pendingOutput();
    const options = { now: () => now, executeRun: () => response.promise, onDeliver: vi.fn() };
    expect(() => new NativeScheduler(repository, { ...options, tickIntervalMs: 0 })).toThrow(
      "valid scheduler polling interval",
    );
    const scheduler = new NativeScheduler(repository, options);
    await expect(scheduler.runNow("missing")).rejects.toThrow("Routine not found.");
    const running = scheduler.runNow(routine.id);
    expect(() => scheduler.start()).toThrow("Wait for active routine runs");
    response.resolve("finished");
    await expect(running).resolves.toMatchObject({ status: "completed" });
  });

  it("recovers abandoned runs on reopening SQLite while preserving the schedule and schema version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wildbots-native-routines-"));
    try {
      const file = join(dir, "routines.db");
      const before = new StoreDatabase(file);
      const first = new NativeRoutineRepository(before);
      const routine = first.create(
        {
          botId: "bot",
          name: "once",
          prompt: "Check the gate.",
          kind: "once",
          scheduleExpr: "2026-11-23T12:00:00Z",
          missedPolicy: "run_once",
        },
        start,
      );
      const [claimed] = first.claimDue(start);
      const concurrent = new StoreDatabase(file);
      try {
        const second = new NativeRoutineRepository(concurrent);
        expect(() => second.claimManual(routine.id, start)).toThrow(
          "already has a running execution",
        );
        expect(() =>
          concurrent.db
            .prepare(`INSERT INTO native_routine_runs(id,routine_id,bot_id,trigger,status,started_at)
              VALUES(?,?,?,'manual','running',?)`)
            .run("overlap", routine.id, routine.botId, start),
        ).toThrow("UNIQUE constraint failed: native_routine_runs.routine_id");
      } finally {
        concurrent.close();
      }
      before.close();

      const after = new StoreDatabase(file);
      try {
        const restarted = new NativeRoutineRepository(after);
        const executeRun = vi.fn(() => "replayed");
        const scheduler = new NativeScheduler(restarted, {
          now: () => start + 1000,
          executeRun,
          onDeliver: vi.fn(),
        });
        scheduler.start();
        await scheduler.stop();

        expect(after.db.prepare("PRAGMA user_version").get()).toMatchObject({
          user_version: schemaVersion,
        });
        expect(restarted.listRuns(routine.id)).toMatchObject([
          {
            id: claimed.run.id,
            status: "interrupted",
            finishedAt: start + 1000,
            error: "Scheduler restarted during execution.",
          },
        ]);
        expect(restarted.get(routine.id)).toMatchObject({
          nextRunAt: null,
          enabled: false,
          lastRunAt: start,
          lastStatus: "interrupted",
        });
        expect(restarted.recoverInterruptedRuns(start + 2000)).toBe(0);
        expect(
          restarted.recordCompletion(claimed.run.id, start + 2000, "late", true),
        ).toBeUndefined();
        expect(executeRun).not.toHaveBeenCalled();
      } finally {
        after.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forgets a bot's routines and history and drops output from its in-flight run", async () => {
    const routine = create("delete");
    const other = create("keep", { botId: "other" });
    const response = pendingOutput();
    const executeRun = vi.fn(() => response.promise);
    const onDeliver = vi.fn();
    const scheduler = new NativeScheduler(repository, { now: () => now, executeRun, onDeliver });
    const running = scheduler.runNow(routine.id);
    await Promise.resolve();
    repository.forgetBot(routine.botId);
    response.resolve("late reply");
    await running;

    expect(repository.get(routine.id)).toBeUndefined();
    expect(repository.listRuns(routine.id)).toEqual([]);
    expect(repository.list(other.botId).map(({ id }) => id)).toEqual([other.id]);
    expect(onDeliver).not.toHaveBeenCalled();
  });

  describe("credential policy", () => {
    const group = { deliverToGroupId: "group" };
    function bot() {
      const bots = new ManagedBotRepository(database);
      const subscription = bots.upsertCredential({
        id: "subscription",
        label: "Subscription",
        vendor: "openai",
        kind: "subscription",
        ownerId: "owner",
        allowedHarnesses: ["codex"],
      });
      const apiKey = bots.upsertCredential({
        id: "api-key",
        label: "API key",
        vendor: "openai",
        kind: "api_key",
        allowedHarnesses: ["codex"],
        envVar: "OPENAI_API_KEY",
      });
      const record = bots.upsertManagedBot({
        id: "bot",
        name: "Bot",
        description: "",
        instructions: "",
        harness: "codex",
        model: "model",
        provider: "openai",
        reasoning: "",
        speed: "",
        ownerId: "owner",
        ownerOsUser: "unix-owner",
        shared: false,
        credentialId: apiKey.id,
        enabledTools: [],
        enabledSkills: [],
        enabledMcpServers: [],
      });
      return { bots, record, subscription };
    }

    it("rejects group routines for absent, archived, or credentialless bots", () => {
      expect(() => create("absent", group)).toThrow("Routine assistant not found.");
      const { bots, record } = bot();
      bots.upsertManagedBot({ ...record, archivedAt: start });
      expect(() => create("archived", group)).toThrow("Routine assistant not found.");
      bots.upsertManagedBot({ ...record, harness: "hermes", credentialId: null });
      expect(() => create("no-credential", group)).toThrow(
        "Choose a credential for this routine assistant.",
      );
    });

    it("refuses group jobs for a subscription after a previously valid credential changes", async () => {
      const { bots, record, subscription } = bot();
      const routine = create("group", group);
      bots.upsertManagedBot({ ...record, credentialId: subscription.id });
      const reason = "Use a bot with an API key credential for routines that post to group chats.";
      expect(() => create("refused", group)).toThrow(new Conflict(reason));
      const personal = create("personal");
      const executeRun = vi.fn(() => "finished");
      const onDeliver = vi.fn();
      const scheduler = new NativeScheduler(repository, { now: () => now, executeRun, onDeliver });
      await expect(scheduler.runNow(routine.id)).rejects.toThrow(new Conflict(reason));
      now += 1000;
      await scheduler.tick();

      expect(repository.listRuns(routine.id)).toMatchObject([
        { status: "failed", error: reason, delivered: false },
      ]);
      expect(executeRun).toHaveBeenCalledTimes(1);
      expect(onDeliver).toHaveBeenCalledWith(
        expect.objectContaining({ id: personal.id }),
        expect.anything(),
        "finished",
        expect.any(AbortSignal),
      );
    });

    it("checks the credential again before delivering an already running group result", async () => {
      const { bots, record, subscription } = bot();
      const routine = create("group", group);
      const response = pendingOutput();
      const executeRun = vi.fn(() => response.promise);
      const onDeliver = vi.fn(() => undefined);
      const scheduler = new NativeScheduler(repository, { now: () => now, executeRun, onDeliver });
      const running = scheduler.runNow(routine.id);
      await Promise.resolve();
      expect(executeRun).toHaveBeenCalledWith(
        expect.objectContaining({ deliverToGroupId: "group" }),
        expect.anything(),
        expect.any(AbortSignal),
      );
      bots.upsertManagedBot({ ...record, credentialId: subscription.id });
      response.resolve("finished");
      await expect(running).resolves.toMatchObject({
        status: "failed",
        error: "Use a bot with an API key credential for routines that post to group chats.",
        delivered: false,
      });
      expect(onDeliver).not.toHaveBeenCalled();
      bots.upsertManagedBot(record);
      await expect(scheduler.runNow(routine.id)).resolves.toMatchObject({
        status: "completed",
        delivered: true,
      });
      expect(onDeliver).toHaveBeenCalledWith(
        expect.objectContaining({ deliverToGroupId: "group" }),
        expect.anything(),
        "finished",
        expect.any(AbortSignal),
      );
    });
  });
});
