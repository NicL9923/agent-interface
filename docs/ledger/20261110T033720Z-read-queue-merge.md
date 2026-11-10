# November 10 merged waiting reads and queue time

Branch `t3/read-queue-merge`, stacked on `t3/open-row-memo` at `4a2de4e` (over `ec24b94`) because both edit
the same capability-matrix paragraph. On NicolasLaptop (Linux x86_64, Python 3.14.10, Node 24.22.2).
Source fingerprint `sha256:13201619809576536b14e36b3ad5b5e01c781336efdb40e6f918e7ef617fbf4f` (1666 files);
`src/hermes` alone `sha256:ffd7f7b3919849405667831c68ec0ad8f3fabf2c9ef3c859c00203168f4d8727`.
No Hermes process ran and the production host was not touched.

## What makes merging safe

- Merging needs the same lane (method and profile), the same JSON parameters and the same connection.
  Native `session.activate` rebinds the session to the transport bound on its thread
  (`tui_gateway/methods_session.py:1162` at `ed1afb082eb3`), so requests from two connections never share one.
- A job leaves its lane before it runs, so only waiting jobs take requests, and each answer comes from
  a computation that started after its request arrived.
- `agent-interface.open`: the answer depends only on its parameters and state read during the run. Its
  effects converge: activation, the keeper, the manual-recovery flag and receipt binding, which only
  fills a NULL `row_id`.
- `agent-interface.discover`: the answer depends only on `cursor` and `full` and the journal read
  during the run. Its effect is the routine scan, which records each run once under a unique
  `event_key` (`INSERT OR IGNORE`, and `has_event` first), so one scan for two requests leaves the same
  journal as two. Both are in `MERGED_READS`; a queued read outside it never merges.

## Queue time

`route()` stamps each request on arrival. Its answer reports `queued`, the time until its job started,
first in `app_timing`, and adds it to `total`. The app server's `transit` metric is Hermes's round trip
less the add-on's `total` (`readTimingHeader` in `src/server/conversation-routes.ts`), so it stays the
time outside the add-on. Node accepts any lowercase phase name (`src/server/hermes.ts:259`), so Node is
unchanged. Direct `handle_request` opens have no queue and report no `queued`.

## Checks

- `npm run test:py` on the stacked state: 42 files passed, 0 skipped (Python 3.14.10).
  `tests/hermes_extension_journal_test.py`: 59 tests, 6 of them new in `ReadMergeTests`. The first
  stacked run failed `tests/system_terminal_test.py` once (tmux output timing: `RAW_READY` arrived
  wrapped in an escape sequence); that file passed three runs alone and the full rerun. Before
  stacking, the same commit over `6799274` passed 41 of 41 files.
- The merge and queue tests ran 20 times in a row: 0 failures.
- `npm run lint:py` with ruff 0.17.3 from `.github/requirements-ci.txt`: passed.
- `npm ci`, then `npm run typecheck`: passed. `npx vitest run tests/hermes-adapter.test.ts
  tests/hermes-qualification.test.ts`: 2 files, 220 tests passed.

## Red proof

Each line was broken by hand with a scripted text replacement, `tests/hermes_extension_journal_test.py`
run, and the source restored. Every one went red:

- A started job still taking later requests: four tests, including
  `test_a_request_arriving_after_its_twin_started_gets_its_own_computation`.
- The merge key without parameters, or without the connection, and merging every queued read
  regardless of `MERGED_READS`: `test_waiting_opens_merge_only_with_the_same_parameters_connection_and_method`.
- Merging turned off: `test_identical_opens_waiting_behind_a_running_one_share_one_computation` and the failure test.
- Queue time left out of `total`, or not measured: `test_an_open_reports_the_time_it_waited_in_the_queue_within_its_total`.
- Every answer keeping the first request's ID, only the first request answered, and one admission
  release per job instead of per request: the identical-opens and failure tests and
  `test_one_slow_assistants_reads_never_take_hermes_native_workers`.

Not run: real Hermes, the qualification run, `npm test`, iOS and production. No merge of two
`agent-interface.discover` requests ran in a test; its safety rests on the reading above. Review round 1
below adds that test.

## Review round 1 (GPT-6.1 Sol), November 9

The reviewer found nothing in this branch's own diff. Its scratch reproduction merged two
`agent-interface.discover` requests with the real discovery and routine-scan code and fake cron I/O and
passed; the suite had no such case. `t3/open-row-memo` changed under it (its review round 1, `0110552`),
so this branch merges it with a normal merge commit. The only conflict was the capability-matrix
paragraph both branches edit; the resolution keeps both additions. Source fingerprint
`sha256:b39ed66e26dfe3595d7dc15f2ce258fc5e49a70431624ae2f8f6844b13108329` (1666 files); `src/hermes`
`sha256:f51d02760201a1343e26db6319cde6505789b5446cae6517fa045564a42a744a`.

A merged reply shares its result with its twin, but each is serialized to the same connection and
nothing in the process keeps it. The row cache's rule, that no response shares an object with a
cache, still holds: the shared result is the copy the open made on its way out.

### New test

`test_identical_discovers_waiting_behind_a_running_one_share_one_routine_scan` in `ReadMergeTests`
(`tests/hermes_extension_journal_test.py`, now 60 tests). A forced discovery holds the lane inside the
fake cron ledger read; two identical discoveries from the same connection queue behind it. Once it is
released, one more scan of both profiles answers both, each under its own request ID with the same
events, each profile's run is in the journal once, and every admission reservation is released. Only
the cron module and its ledger are fakes; discovery, the routine scan, the read queue and the journal
are the real code.

Red proof: with `agent-interface.discover` removed from `MERGED_READS`, the test failed on three scans
(`['slow', 'fast', 'slow', 'fast', 'slow', 'fast']`). `ReadMergeTests` then ran 20 times in a row with no
failure.

### Checks on the merged state

- `npm run test:py`: 42 files passed, 0 skipped (Python 3.14.10). `tests/system_terminal_test.py`
  passed this time.
- `npm run lint:py` with ruff 0.17.3 from `.github/requirements-ci.txt`: passed.
- `npm run typecheck`: passed, after the `npm ci` run for `t3/open-row-memo` (same lockfile).
  `npx vitest run tests/hermes-adapter.test.ts tests/hermes-qualification.test.ts`: 2 files, 220 tests
  passed.

### Measurement

`python3 .agents/tools/benchmark-open-during-turn.py --repo CHECKOUT`, now on Hermes's exact `messages`
schema (see the `t3/open-row-memo` ledger), five interleaved rounds, each cell the median across rounds
of one run's median. The benchmark calls the open handler directly, so the read queue is not in it.

| Code | Open median | Open p90 | Activate median | Decorate median | Window median |
| --- | --- | --- | --- | --- | --- |
| `ec24b94` | 81.3 ms | 88.8 ms | 20.2 ms | 59.3 ms | 0.8 ms |
| `t3/open-row-memo` at `0110552` | 21.6 ms | 26.1 ms | 5.2 ms | 15.1 ms | 1.0 ms |
| This branch at `989a4de` | 22.7 ms | 29.2 ms | 5.6 ms | 15.4 ms | 1.1 ms |

The 1 ms between the two branches is inside the run-to-run spread on this machine (minimums 21.3 and
21.5 ms).

Not run: real Hermes, the qualification run, `npm test`, iOS and production.

## Merge of `t3/open-row-memo` review round 2, November 9

`t3/open-row-memo` changed under this branch again (`50feeb7`): its review round 2 removed the
`originals` table, so `original_rows()` asks state.db about every visible row on every open, as
`origin/main` does. This branch merges it with a normal merge commit. The only conflict was the same
capability-matrix paragraph; the resolution keeps the read queue's text and takes the row cache's new
sentence about compaction copies. Source fingerprint
`sha256:a24edfa8f2dc47b00d266a19dc74071ba83428a06ec3edaefdbe97df036db1c2` (1666 files); `src/hermes`
`sha256:f1e6f143cea23b906e552e1ba7bfab5a9ada55cbb398a3d37394e38cf685e1fc`.

The table above measured `0110552`. The row cache now saves less; see that branch's ledger.

### Checks on the merged state

- `npm run test:py`: 42 files passed, 0 skipped, 0 failed (Python 3.14.10).
- `npm run lint:py` with ruff 0.17.3 from `.github/requirements-ci.txt`: passed.
- `npm run typecheck`: passed, after `npm ci` on `t3/open-row-memo` (same lockfile).
  `npx vitest run tests/hermes-adapter.test.ts tests/hermes-qualification.test.ts`: 2 files, 220 tests
  passed.

### Measurement

The same benchmark, now in WAL mode and timing `original_rows`, seven interleaved rounds against
`git archive` of `origin/main` (`0d205eb`) and `50feeb7`. Each cell is the median across rounds of one
run's median, or of its p90. The load average was about 10 throughout, so every build ran about 10%
slower than in `t3/open-row-memo`'s own nine rounds; compare rows within this table.

| Code | Open median | Open p90 | Decorate median | Decorate p90 | `original_rows` median |
| --- | --- | --- | --- | --- | --- |
| `origin/main` | 91.9 ms | 131.2 ms | 64.5 ms | 99.8 ms | 13.4 ms |
| `t3/open-row-memo` at `50feeb7` | 36.1 ms | 48.2 ms | 27.1 ms | 38.6 ms | 13.1 ms |
| This branch at the merge | 35.9 ms | 51.2 ms | 27.8 ms | 41.4 ms | 13.4 ms |

The two branches are within run-to-run spread of each other; the benchmark does not go through the read
queue.

Not run: real Hermes, the qualification run, `npm test`, iOS and production.
