import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { cappedBackoff, fromPromise, makeJobs, toPromise } from '../src/server/effect-support.js';

describe('effect support', () => {
  it('preserves promise failures and maps interruption', async () => {
    const error = new Error('original');
    await expect(toPromise(fromPromise(() => Promise.reject(error)), () => new Error('interrupted'))).rejects.toBe(error);
    const interrupted = new Error('interrupted');
    await expect(toPromise(Effect.interrupt, () => interrupted)).rejects.toBe(interrupted);
  });
  it('caps the deterministic backoff', () => {
    expect([1, 2, 3, 6, 20].map(n => cappedBackoff(n))).toEqual([1000, 2000, 4000, 30000, 30000]);
  });
  it('coalesces work, reruns, and drains jobs started during drain', async () => {
    const jobs = makeJobs<string>(() => { throw new Error('unexpected'); });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const work = fromPromise(async () => { calls++; if (calls === 1) await gate; });
    const first = jobs.run('a', work, () => calls < 2);
    expect(jobs.run('a', work)).toBe(first);
    const drain = jobs.drain();
    jobs.run('b', Effect.void);
    release();
    await drain;
    expect(calls).toBe(2);
    expect(jobs.size).toBe(0);
  });
  it('interrupts a job without reporting interruption as failure', async () => {
    const failures: unknown[] = [];
    const jobs = makeJobs<string>(error => failures.push(error));
    jobs.run('a', Effect.never);
    await jobs.interrupt('a');
    expect(jobs.size).toBe(0);
    expect(failures).toEqual([]);
  });
});
