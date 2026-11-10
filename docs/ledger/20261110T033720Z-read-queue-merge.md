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
`agent-interface.discover` requests ran in a test; its safety rests on the reading above.
