# November 10 the send-lane tests read a test clock

Branch `t3/lane-test-clock` over `origin/main` at `4b8fdc2`, on NicolasLaptop (Fedora 44, Linux x64, 32 cores),
Python 3.14.10, Node 24.22.2. Tests only: no product code changed.

## Fault

`test_a_send_waiting_for_a_compaction_holds_up_no_other_assistant` in `tests/hermes_send_lanes_test.py` held a
background compaction, slept 200 ms, released it, and asserted the send's `app_timing`: `preempt >= 150` and
`wait < 100`. `wait` is the real time from the add-on's mark before `submission_lock` to the lock taken
(`src/hermes/extension.py:1735-1737`). Nothing holds the lock then, so the time is the scheduler's. The reviewer read
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
| the clock alone | the same, run later under heavier outside load | 88 | 12 |
| `main`, beside the next row | PAIRED | B_PASSED | B_FAILED |
| this branch, beside the row above | PAIRED | A_PASSED | A_FAILED |

The last two rows ran at the same time, each with its own copies and busy loops on the same two cores, so both saw the
same load. This machine never reproduced the reviewer's `wait` failures on `main`. The fix does not rest on the counts:
with the clock, `wait` is 0 whatever the scheduler does.

## Other real-time limits and ordering sleeps

Read at `4b8fdc2`; line numbers are `main`'s. Left as they are unless marked.

Real-time upper limits:

- `tests/hermes_send_lanes_test.py:211`, `wait < 100`: fixed here.
- `tests/hermes_send_lanes_test.py:322`, `preempt < 900` with `PREEMPT_WAIT` at 0.5 s. The bound is the compactor's own
  `monotonic` deadline polled every 20 ms (`src/hermes/compaction.py:261-267`), so a test clock would have to tick
  inside that loop. Not mechanical; 400 ms of headroom.
- `tests/hermes_send_lanes_test.py:123` (`free()`, a 1 s lock timeout) and `:152` (`within()`, 2 s): blocked-or-not
  limits, generous, and no clock can replace them.
- `tests/hermes_extension_journal_test.py:1279`, `running["queued"] < 100` after a real 200 ms sleep at `:1270`: the
  same pattern as the fixed test, and the same `Clock` would fix it.
- `tests/hermes_compaction_test.py:382` and `:616`, `time.monotonic() - started < 1`.
- `tests/hermes_computer_test.py:786`, under 2 s: a deliberate guard against a quadratic scan.

Sleeps used for ordering, or to give a thread time before a negative check:

- `tests/hermes_send_lanes_test.py:236`, `assertFalse(delivered.wait(0.3))`: a negative check that can only pass
  falsely under load, never flake.
- `tests/hermes_send_lanes_test.py:204`, `:237`, `:260`: 200 ms sleeps for elapsed time, replaced here.
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

CHECKS

Not run: real Hermes, the qualification run, `npm test`, iOS and production.
