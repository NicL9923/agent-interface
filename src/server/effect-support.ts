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
  const jobs = new Map<K, {fiber: Fiber.Fiber<void, unknown>; done: Promise<void>}>();
  return {
    run(key, work, rerun) {
      const existing = jobs.get(key);
      if (existing) return existing.done;
      const loop = Effect.gen(function* () {
        do { yield* work; } while (rerun?.());
      });
      const fiber = Effect.runFork(loop);
      const done = new Promise<void>(resolve => fiber.addObserver(exit => queueMicrotask(() => {
        if (jobs.get(key)?.fiber === fiber) jobs.delete(key);
        try {
          if (!Exit.isSuccess(exit) && !Cause.hasInterruptsOnly(exit.cause)) onFailure(Cause.squash(exit.cause));
        } finally { resolve(); }
      })));
      jobs.set(key, {fiber, done});
      return done;
    },
    async interrupt(key) {
      const job = jobs.get(key);
      if (job) { await Effect.runPromise(Fiber.interrupt(job.fiber)); await job.done; }
    },
    async drain() {
      while (jobs.size) await Promise.all([...jobs.values()].map(job => job.done));
    },
    get size() { return jobs.size; },
  };
}
