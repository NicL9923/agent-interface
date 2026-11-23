import { InvalidInput } from "../shared/errors.js";
import { isInQuietHours } from "./native-routine-schedule.js";
import type {
  NativeRoutine,
  NativeRoutineClaim,
  NativeRoutineRepository,
  NativeRoutineRun,
} from "./store-native-routines.js";

export { isInQuietHours, nextCronTime } from "./native-routine-schedule.js";

/** Punctuation and whitespace may wrap the marker. Any other text is an alert. */
export function isHeartbeatQuiet(outputText: string): boolean {
  return /^[\p{P}\s`]*HEARTBEAT_OK[\p{P}\s`]*$/u.test(outputText);
}

type MaybePromise<T> = T | Promise<T>;

export interface NativeSchedulerOptions {
  now?: () => number;
  tickIntervalMs?: number;
  /** Maximum runtime for one routine execution before it is aborted to free the lock. Default 15 minutes. */
  maxRunMs?: number;
  /** Dispatch routine.prompt or routine.scriptCommand through the configured runner. */
  executeRun(
    routine: NativeRoutine,
    run: NativeRoutineRun,
    signal: AbortSignal,
  ): MaybePromise<string>;
  /** Return false if nothing was delivered. Both chat and push go through this callback. */
  onDeliver(
    routine: NativeRoutine,
    run: NativeRoutineRun,
    outputText: string,
    signal: AbortSignal,
  ): MaybePromise<boolean | void>;
  onError?: (error: unknown) => void;
}

type ActiveRun = {
  controller: AbortController;
  finished: Promise<NativeRoutineRun | undefined>;
};

export class NativeScheduler {
  private readonly active = new Map<string, ActiveRun>();
  private readonly now: () => number;
  private readonly tickIntervalMs: number;
  private readonly maxRunMs: number;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly repository: NativeRoutineRepository,
    private readonly options: NativeSchedulerOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.tickIntervalMs = options.tickIntervalMs ?? 1000;
    this.maxRunMs = options.maxRunMs ?? 15 * 60_000;
    if (
      !Number.isInteger(this.tickIntervalMs) ||
      this.tickIntervalMs < 1 ||
      this.tickIntervalMs > 2_147_483_647
    )
      throw new InvalidInput("Choose a valid scheduler polling interval.");
    if (!Number.isInteger(this.maxRunMs) || this.maxRunMs < 1 || this.maxRunMs > 2_147_483_647)
      throw new InvalidInput("Choose a valid maximum routine runtime.");
  }

  /** Start one scheduler owner per database. Recovery runs before the first polling tick. */
  start(): void {
    if (this.timer) return;
    if (this.active.size)
      throw new InvalidInput("Wait for active routine runs before starting the scheduler.");
    this.repository.recoverInterruptedRuns(this.now());
    this.stopped = false;
    const poll = (graceMs: number) => {
      void this.tick(graceMs).catch(
        this.options.onError ??
          ((error: unknown) => {
            console.error("Native routine scheduler tick failed", error);
          }),
      );
    };
    this.timer = setInterval(() => poll(this.tickIntervalMs), this.tickIntervalMs);
    this.timer.unref();
    // At startup, only an occurrence due now is on time. Later ticks allow one poll interval.
    poll(0);
  }

  async tick(graceMs = this.tickIntervalMs): Promise<void> {
    if (this.stopped) return;
    const claims = this.repository.claimDue(this.now(), graceMs);
    await Promise.all(claims.map((claim) => this.launch(claim)));
  }

  async runNow(routineId: string): Promise<NativeRoutineRun | undefined> {
    if (this.stopped) throw new InvalidInput("The native routine scheduler is stopped.");
    return this.launch(this.repository.claimManual(routineId, this.now()));
  }

  stopRun(routineId: string): boolean {
    const active = this.active.get(routineId);
    if (!active || active.controller.signal.aborted) return false;
    active.controller.abort();
    return true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    const runs = [...this.active.values()];
    for (const { controller } of runs) controller.abort();
    const settled = await Promise.allSettled(runs.map(({ finished }) => finished));
    const failure = settled.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private launch(claim: NativeRoutineClaim): Promise<NativeRoutineRun | undefined> {
    const controller = new AbortController();
    const finished = Promise.resolve()
      .then(() => this.execute(claim, controller.signal))
      .finally(() => {
        if (this.active.get(claim.routine.id)?.controller === controller)
          this.active.delete(claim.routine.id);
      });
    this.active.set(claim.routine.id, { controller, finished });
    return finished;
  }

  private async execute(
    { routine, run }: NativeRoutineClaim,
    stopSignal: AbortSignal,
  ): Promise<NativeRoutineRun | undefined> {
    let output: string | null = null;
    let status: "completed" | "suppressed" = "completed";
    let delivered = false;
    const timeoutSignal = AbortSignal.timeout(this.maxRunMs);
    const signal = AbortSignal.any([stopSignal, timeoutSignal]);
    const isQuietNow = () =>
      routine.quietHours !== null &&
      isInQuietHours(routine.quietHours, routine.timezone, this.now());
    try {
      signal.throwIfAborted();
      if (!this.repository.isRunRunning(run.id)) return;
      this.repository.assertRoutineGroupDeliveryAllowed(routine);
      if (isQuietNow()) {
        status = "suppressed";
      } else {
        output = await this.options.executeRun(routine, run, signal);
        signal.throwIfAborted();
        if (isQuietNow() || (routine.kind === "heartbeat" && isHeartbeatQuiet(output))) {
          status = "suppressed";
        } else {
          // A bot deleted during execution no longer owns a running row or a delivery destination.
          if (!this.repository.isRunRunning(run.id)) return;
          this.repository.assertRoutineGroupDeliveryAllowed(routine);
          delivered = (await this.options.onDeliver(routine, run, output, signal)) !== false;
          if (!delivered) signal.throwIfAborted();
        }
      }
    } catch (error) {
      if (stopSignal.aborted)
        return this.repository.recordInterrupted(run.id, this.now(), "Routine stopped.");
      if (timeoutSignal.aborted)
        return this.repository.recordFailure(run.id, this.now(), "Routine run timed out.", output);
      return this.repository.recordFailure(
        run.id,
        this.now(),
        error instanceof Error ? error.message : String(error),
        output,
      );
    }
    if (status === "suppressed")
      return this.repository.recordSuppressed(run.id, this.now(), output);
    return this.repository.recordCompletion(run.id, this.now(), output!, delivered);
  }
}
