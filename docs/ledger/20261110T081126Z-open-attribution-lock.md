# November 10 journal lock held by an open's attribution pass

Branch `t3/open-attribution-lock` over `origin/main` at `3bfd79d`, measured over `f436f66`, on NicolasLaptop (Linux x86_64, Python
3.14.10, SQLite 3.51.2, Node 24.22.2). Source fingerprint
`sha256:838adac2f856df207c9872ba05c2f6bae57d51111763655af5886aaf88a3bb0b` (1686 files); `src/hermes` alone
`sha256:f1e6f143cea23b906e552e1ba7bfab5a9ada55cbb398a3d37394e38cf685e1fc`, unchanged from `origin/main`.
No Hermes process ran and the production host was not touched.

## Question

`open_locked` holds `journal.lock` around `attribute`. Every other taker waits for the whole pass:
`record_live_tool` on each `tool.start` and `tool.complete`, the `tool.complete` insert, `submit`, and
`app_prompt` at turn start. The plan was to measure the hold first and change nothing if it was already
negligible.

## Measurement

`benchmark-open-during-turn.py` gained `--contend`. It wraps `journal.lock` to record each thread's outermost
hold, times `attribute`, and runs a frame thread beside the opens that calls the add-on's own
`record_live_tool` every millisecond. Each frame call is classed by whether it began during an attribution
pass or during the rest of an open. Outside a pass the two threads share only the interpreter lock.

`python3 .agents/tools/benchmark-open-during-turn.py --contend [--rows N]`, 30 opens during a running turn,
load average about 4 on 32 cores. Each cell is median, p90 and max. The 5,000-row line is three runs.

| Rows (tool rows) | Attribution pass | Cold first pass | Frame lock wait during a pass | Frame call outside a pass |
| --- | --- | --- | --- | --- |
| 101 (60) | 0.4, 0.5 ms | 1.0 ms | 0.8 ms (1 call) | not sampled |
| 1,001 (600) | 2.5, 3.1 ms | 10.7 ms | 2.2, 2.5, 3.6 ms | 0.2, 0.3, 0.3 ms |
| 5,001 (3,000) | 13.1, 13.4 ms | 44.5 to 52.2 ms | 13.1, 13.5, 20.7 ms | 0.4, 0.6, 4.9 ms |

A frame that arrives during a pass waits for the rest of it, so the wait equals the pass. The cold first pass
parses every tool row and journal record once per process.

A scratch profile of `attribute` at 5,000 rows, with the journal connection timed per statement: 13.2 ms in
all, 5.9 ms of it the journal reads and their fetches. Those reads would stay under the lock in the proposed
split, because the rebind writes must be checked against them.

## Decision: no change to the add-on

The hold is negligible at every size measured.

- Production's busiest Bot Chat has 106 visible rows (HermesCapabilityMatrix, "Idle compaction"). There the
  pass holds the lock for 0.4 ms, under 1 ms when cold.
- At the 5,000-row stress size, 47 times production, a tool frame, a send or a turn start waits at most one
  pass: 13 ms at the median, 21 ms at worst. A turn's model calls take 8 to 13 seconds each in production,
  and each admission already makes a FULL-synchronous journal commit.
- The split would release at most the Python part, about 7 ms at 5,000 rows and 0.2 ms at production size.
  The frame thread would still share the interpreter lock with that work: outside a pass its whole call
  already reached 4.9 ms.
- The split opens a gap the steering rebind relies on not existing. The comment on `attribute` says the lock
  is what keeps a receipt from landing mid-poll, and the rebind pairs a correction with the oldest unbound
  steering receipt that has the same text. Proving a receipt admitted in the gap is neither lost nor bound
  twice would add a second hold, a re-check and a concurrency test, all to save under a millisecond at
  production size.

Only the benchmark changed. `--contend` stays so the measurement can be repeated when transcripts grow.

## Checks

On this branch over `3bfd79d`, the `origin/main` tip when it was committed. The two commits after `f436f66` change
no Python, add-on or tool file.

- `npm run test:py`: 42 files passed, 0 skipped, 0 failed (Python 3.14.10). It also passed on `f436f66`.
- `npm run lint:py` with ruff 0.17.3 from `.github/requirements-ci.txt`: passed.
- `npm ci`, then `npm run typecheck`: passed. `npx vitest run tests/hermes-adapter.test.ts
  tests/hermes-qualification.test.ts`: 2 files, 233 tests passed.

No test was added: only the benchmark changed, and it is a measuring tool, not behavior.

Not run: real Hermes, the qualification run, `npm test`, iOS and production.
