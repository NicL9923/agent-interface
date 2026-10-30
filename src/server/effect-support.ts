import { Cause, Effect, Exit, Fiber } from 'effect';

export const fromPromise = <A>(run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({try: run, catch: error => error});

export async function toPromise<A, E>(effect: Effect.Effect<A, E>, onInterrupt: () => Error): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.hasInterruptsOnly(exit.cause) ? onInterrupt() : Cause.squash(exit.cause);
}

export const cappedBackoff = (failures: number, base = 1000, cap = 30000): number =>
  Math.min(cap, base * 2 ** Math.min(Math.max(0, failures - 1), 30));

export interface Jobs<K extends string> {
  run(key: K, work: Effect.Effect<void, unknown>, rerun?: () => boolean): Promise<void>;
  interrupt(key: K): Promise<void>;
  drain(): Promise<void>;
  readonly size: number;
}

export function makeJobs<K extends string>(onFailure: (error: unknown) => void): Jobs<K> {
  const jobs = new Map<K, {fiber: Promise<Fiber.Fiber<void, unknown>>; done: Promise<void>}>();
  return {
    run(key, work, rerun) {
      const existing = jobs.get(key);
      if (existing) return existing.done;
      let started!: (fiber: Fiber.Fiber<void, unknown>) => void;
      let finished!: () => void;
      const entry = {
        fiber: new Promise<Fiber.Fiber<void, unknown>>(resolve => { started = resolve; }),
        done: new Promise<void>(resolve => { finished = resolve; }),
      };
      jobs.set(key, entry);
      const loop = Effect.gen(function* () {
        do { yield* work; } while (rerun?.());
      }).pipe(Effect.ensuring(Effect.sync(() => {
        // Remove the job before its exit is observed, so a new request cannot
        // join a finished fiber and lose a requested outbox pass.
        if (jobs.get(key) === entry) jobs.delete(key);
      })));
      const fiber = Effect.runFork(loop);
      started(fiber);
      fiber.addObserver(exit => queueMicrotask(() => {
        try {
          if (!Exit.isSuccess(exit) && !Cause.hasInterruptsOnly(exit.cause)) onFailure(Cause.squash(exit.cause));
        } finally { finished(); }
      }));
      return entry.done;
    },
    async interrupt(key) {
      const job = jobs.get(key);
      if (job) { await Effect.runPromise(Fiber.interrupt(await job.fiber)); await job.done; }
    },
    async drain() {
      while (jobs.size) await Promise.all([...jobs.values()].map(job => job.done));
    },
    get size() { return jobs.size; },
  };
}
