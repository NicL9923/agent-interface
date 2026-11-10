# November 10 the send-lane tests read a test clock

Branch `t3/lane-test-clock` over `origin/main` at `c2ee202`, on NicolasLaptop (Fedora 44, Linux x64, 32 cores),
Python 3.14.10, Node 24.22.2. Tests only: no product code changed. The work started on `4b8fdc2`; `main` moved to
`c2ee202` during the runs, with #318 adding maintenance tests to the lane file, and the unpublished commit was rebased
onto it. Line numbers below are `c2ee202`'s.

## Fault

`test_a_send_waiting_for_a_compaction_holds_up_no_other_assistant` in `tests/hermes_send_lanes_test.py` held a
background compaction, slept 200 ms, released it, and asserted the send's `app_timing`: `preempt >= 150` and
`wait < 100`. `wait` is the real time from the add-on's mark before `submission_lock` to the lock taken
(`src/hermes/extension.py:1769-1771`). Nothing holds the lock then, so the time is the scheduler's. The reviewer read
101.6 and 345.9 on a loaded machine, 2 failures in 100 runs.

## Change

The add-on's timings read `time.perf_counter`. A `Clock` in the test file stands in for the add-on module's `time`
(`patch.object(extension, "time", Clock())`): `perf_counter` returns a value the test moves with `advance`, and every
other name is the real module's, so waits, deadlines and timestamps are unchanged. No private method of the add-on is
patched. The compaction test advances the clock by 200 ms while the compaction is held, then releases it. `preempt`
now reads exactly 200 and `wait` exactly 0, so the test still tells compaction time from lock-wait time, and the
scheduler cannot move either. The ordering checks and every timing assertion are unchanged.

The same mechanical change replaces the two other 200 ms sleeps in the file, which made elapsed time for lower-bound
checks: `staging >= 150` in the image-staging test, and `native >= 150` and the second send's `queued >= 150` in the
arrival-order test. Those bounds could not flake, since a sleep never returns early, but they now read exact values
and the file no longer sleeps.

## A second real-time limit the clock exposed

The first after run failed 12 of 100: ten of them the compaction test, eight reading `preempt` 0.0 and two finding
`slow-send` answered before the test released the compaction. The compaction fake, `Native` in
`tests/hermes_compaction_test.py`, finishes on its own after 500 polls of 10 ms, at least 5 s. That run was far more
loaded than the baseline (runs averaged 48 s against 17 s; the machine's load average was about 29 from other work), so
the compaction let go before the test advanced the clock. On `main` the same self-release reads as about 5000 ms of
`preempt` and passes `>= 150`, which hid it; the `assertNotIn("slow-send")` failure would have hit `main` too.

`Native` now takes its poll count from `polls`, still 500 by default, so the compaction tests are unchanged. The lane
helper `compacting()` sets 6000, a 60 s safety bound, so only the test's release or the helper's cleanup ends it.
Setting it to 0 by hand turned the compaction test red at `wait_for(native.events)` (`[] is not true`) and the
preempt-bound test red with no warning logged; restored, and `__pycache__` deleted.

## Red proof

Each line was broken with a scripted text replacement in `src/hermes/extension.py`, the lane file run with `-B` and
`PYTHONDONTWRITEBYTECODE=1`, and the source restored, checked by hash, and every `__pycache__` deleted:

| Broken | Red |
| --- | --- |
| Compaction time charged to `wait`: the mark before `submission_lock` removed | the compaction test: `200.0 not less than 100` |
| Staging time not charged | the staging test: `0.0 not greater than or equal to 150` |
| Hermes's admission time not charged | the arrival-order test: `0.0 not greater than or equal to 150` |
| Queue time not charged | the arrival-order test: `0.0 not greater than or equal to 150` |

## Counts

`loop.sh LABEL RUNS PARALLEL BUSY` (kept outside the repository) runs `python3 -B tests/hermes_send_lanes_test.py` in
fresh processes, PARALLEL at once, beside BUSY `while True: pass` processes; `CPUS` pins both to those cores with
`taskset`, and `NICE` runs the tests at that niceness.

| Source | Load | Passed | Failed |
| --- | --- | --- | --- |
| `main` | 8 at once, 32 busy loops, all cores | 100 | 0 |
| `main` | 16 at once, 64 busy loops, all cores | 100 | 0 |
| `main` | 4 at once, 4 busy loops, cores 0 and 1 | 100 | 0 |
| `main` | 4 at once, 4 busy loops, cores 0 and 1, tests at niceness 10 | 100 | 0 |
| the clock alone, on `4b8fdc2` | the same, run later under heavier outside load | 88 | 12 |
| `main` at `c2ee202` | paired with the next row | 89 | 11 |
| the clock and the held compaction, on `4b8fdc2` | paired with the row above | 96 | 4 |
| `main` at `c2ee202` | paired with the next row, fault handler on | 93 | 7 |
| the clock and the held compaction, on `c2ee202` | paired with the row above, fault handler on | 99 | 1 |
| `main` at `c2ee202` | paired with the next row, fault handler on | 95 | 5 |
| this branch: clock, held compaction, locked close | paired with the row above, fault handler on | 100 | 0 |

Paired rows ran at the same time, each with its own 4 copies and 4 busy loops at niceness 10 on cores 0 and 1, so both
saw the same load; runs then took 40 to 100 s against 8 s idle. The machine carried a load average near 29 from other
work through the later rows.

The first paired run reproduced the reviewer's fault on `main`: `wait` read 105.7, 130.7 and 184.2 ms. Its other
failures on `main`: 3 compactions that let go on their own (`slow-send` answered before the release), 3 timeouts of
`Replies.wait`'s 3 s default (`tests/hermes_extension_journal_test.py:236`), 2 in the compaction test and 1 in the
maintenance test, and 2 interpreter crashes. The branch's 4 were 1 `Replies.wait` timeout and 3 crashes; no `wait` or
self-release failure. The last pair: `main`'s 5 were 2 `wait` overruns (123.6 and 135.9 ms), 2 self-releases and 1
`Replies.wait` timeout in the staging test; the branch had none. The fix does not rest on the counts: with the clock, `wait` is 0 whatever the scheduler does.

## Interpreter crashes, on `main` too

Exit code 139, a segmentation fault, in 2 of `main`'s runs and 3 of the branch's in the first paired run, and 1 each in
the second. With `PYTHONFAULTHANDLER=1`, both crashes of the second run show the same thing: the main thread in the test
fake's teardown, `self.journal.db.close()` (`tests/hermes_extension_journal_test.py:85`, reached from `LaneHermes.__exit__`),
while a send-lane worker runs `journal.db.execute` in `admit_native` (`src/hermes/extension.py:1913`) on the same SQLite
connection. Closing a connection under another thread's statement frees what that statement is using. On `main` it hit
the compaction test, on the branch #318's `test_maintenance_sees_a_send_listed_whenever_its_reservation_is_held`: under
this load a send was still writing when its test ended.

It is a test defect. The add-on never closes the journal's connection; the only `close` in `src/hermes/extension.py` is
`Keeper.close`. The fake now closes the connection under `journal.lock`, which the add-on holds for each journal
transaction, so a worker still writing finishes first and a later statement raises `ProgrammingError` instead. The same
teardown serves every test built on `FakeGateway`, which is why it is fixed there and not in the lane file. No
deterministic red: the crash needs a worker mid-statement at teardown, which only load produces, so the last paired row
is its evidence.

## Other real-time limits and ordering sleeps

Read at `c2ee202`. Left as they are unless marked.

Real-time upper limits:

- `tests/hermes_send_lanes_test.py:248`, `wait < 100`: fixed here.
- `tests/hermes_compaction_test.py:96-100`, the compaction fake's own 5 s finish: held for the lane tests here.
- `tests/hermes_send_lanes_test.py:359`, `preempt < 900` with `PREEMPT_WAIT` at 0.5 s. The bound is the compactor's own
  `monotonic` deadline polled every 20 ms (`src/hermes/compaction.py:261-267`), so a test clock would have to tick
  inside that loop. Not mechanical; 400 ms of headroom.
- `tests/hermes_send_lanes_test.py:123` (`free()`, a 1 s lock timeout) and `:152` (`within()`, 2 s): blocked-or-not
  limits, generous, and no clock can replace them.
- `tests/hermes_extension_journal_test.py:236`, `Replies.wait`'s 3 s default, which every lane and journal test waits
  on. It timed out only at the heaviest load here, on `main` and the branch alike.
- `tests/hermes_extension_journal_test.py:1278`, `running["queued"] < 100` after a real 200 ms sleep at `:1270`: the
  same pattern as the fixed test, and the same `Clock` would fix it.
- `tests/hermes_compaction_test.py:382` and `:616`, `time.monotonic() - started < 1`.
- `tests/hermes_computer_test.py:786`, under 2 s: a deliberate guard against a quadratic scan.

Sleeps used for ordering, or to give a thread time before a negative check:

- `tests/hermes_send_lanes_test.py:273`, `assertFalse(delivered.wait(0.3))`: a negative check that can only pass
  falsely under load, never flake.
- `tests/hermes_send_lanes_test.py:241`, `:274`, `:297`: 200 ms sleeps for elapsed time, replaced here.
- `tests/hermes_extension_journal_test.py:691`: 200 ms, then the second open has not entered.
- `tests/hermes_compaction_test.py:350` and `:365`: 100 ms, then no events.
- `tests/hermes_compaction_test.py:379`: 50 ms for the holder thread to take `history_lock` before the preempt.
- `tests/hermes_compaction_test.py:438` and `:451`: 50 ms for the stopper thread to block on the lock before the test
  changes the session.
- `tests/hermes_chat_reply_test.py:214`, `:270`, `:321`: 100 ms, then the ask is still open.
- `tests/hermes_chat_reply_test.py:444`, `:458`, `:471`: 1.2 s, 1.2 s and 0.8 s of real time for the handoff watcher's
  polls and, at `:458`, for `HANDOFF_REGISTER` (0.2 s) to expire.

Deadline-bounded polls for a state, not ordering, are not listed: for example `settled()` in the lane file.

## Checks

Source fingerprint sha256:cd91f287f460485d546b7e0c36187c7a8d694cbc38ed18964b665c00cc07f39c (1733 source files);
`src/hermes` alone sha256:6ee032a194cd9433af9a2f3085720f874304814c11aa74b1ac826d1285c2ae6d (20 source files), the same
as `main`'s, since only tests changed.

- `npm ci` once, then `npm run test:py`: 44 files passed, 0 skipped, 0 failed (200 s). `tests/hermes_send_lanes_test.py`:
  16 tests; `tests/hermes_compaction_test.py`: 35; `tests/hermes_extension_journal_test.py`: 60.
- `ruff check .` with ruff 0.17.3, `npm run lint` and `npm run typecheck`: passed.
- `npx vitest run tests/hermes-adapter.test.ts tests/hermes-qualification.test.ts tests/sent-echo.test.ts`: 3 files,
  251 tests passed.
- The four timing mutants above, rerun on `c2ee202`: each red with the same message.

Not run: real Hermes, the qualification run, `npm test`, iOS and production.
