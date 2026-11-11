# November 11 no test passes or fails on how fast the machine is

Branch `t3/no-wall-clock-tests`, rebased onto `origin/main` at `589f542`, on NicolasLaptop (Fedora 44, Linux x64, 32 cores), Node 24.22.2,
Python 3.14.10. Only files under `tests/` changed, plus the new helper `tests/helpers/cpu-time.ts`. No product code changed.

## How load was made

`loaded.sh CPUS SPINNERS -- COMMAND` pins the command with `taskset -c CPUS` and starts SPINNERS pinned busy loops
(`python3 -c 'while True: pass'`) on the same cores, so the command takes a share of those cores with them and a core is shared 1 to 41 ways.
Cores 8 to 31 only, so other worktrees' jobs on cores 0 to 7 were not disturbed. `stalled.sh STOP_MS GO_MS -- COMMAND` freezes the command
with SIGSTOP for STOP_MS, lets it run GO_MS and repeats, which is a scheduler that takes the CPU away for stretches. Neither is a model of
every slow machine; each is a way to make this one slow in a stated amount. Two scripts, kept outside the repository.

## Red first, and what each fix does

A red run is a failure of the test as it stood on `origin/main`, under the stated load.

| Test | Red under load | How the fix removes the cause |
| --- | --- | --- |
| `plain-text` "reads adversarial text in one pass" | 1 of 6 on 2 cores with 8 loops (2,058 ms against 2,000); 5 of 5 on 1 core with 20 loops (about 8.2 s) | CPU time of the full 50,000-character input against its first 2,000 characters, the window the parser reads, best of 3, limit 4 times. Linear work in the window costs the same either way. Removing the window gives 587 ms against 68 ms, a failure |
| `plain-text` "titles a saved reply... table divider" | not run alone (a 200 ms budget) | the same ratio over 40 titles of 5,000 dashes |
| `hermes_computer_test` megabyte scan | 4 of 4 on 1 core with 40 loops (11.3 to 13.1 s against 2.0) | CPU time of 58,252 schemes against a quarter of them, best of 3, limit 8 times (linear 4, quadratic 16). A quadratic mutation gives 1.13 s against a 0.79 s limit |
| `send-timing` growth notice (1 s throttle) | not red in 14 runs on 2 cores with 8 and 24 loops. Red when the process is paused 1.1 s between the two sends: the stream sent 0 deltas, not 1 | the stream's throttle runs on `setTimeout`, `clearTimeout` and `Date` virtual time (as `live-turn-stream.test.ts`), the fake Hermes's 20 ms uses Node's own timer, and the test waits for the delta on the socket, which the old test only reached because it was slow. A 1.1 s real pause between sends now passes. With `Math.max(0, last + 1000 - Date.now())` replaced by 0 the test fails |
| `group-watch` abandon and settle | not red in 8 runs on 2 cores with 24 loops, nor in 18 runs paused 80 ms after each 12 ms or 120 ms after each 40 ms. Red 4 of 5 with the sleeps shrunk to 0 (time out, 15 s) | the abandon waits until the server's lookup is reached, the post-release settle is ten event-loop turns, and the unwatch is waited for. With `closed` forced to false two tests fail |
| `hermes_compaction_test` held session lock | not red in 6 runs on 1 core with 40 loops. Red 4 of 4 when the process is paused 1.3 s every 0.3 s (1.42 to 1.45 s against 1) | a clock that moves 0.1 s per look and a lock the test holds until `preempt` returns: the assertion is that it returned while the lock was held. With `lock.acquire()` and no timeout the test fails at its 10 s release |
| `hermes_compaction_test` maintenance | same runs, never red | the clock moves 0.01 s per look, so `PREEMPT_WAIT` is 200 polls, and the test asserts the bound's warning never logs. Moving `preempt` under `maintenance_lock` logs it and fails |
| `badge` 250 ms budget | not run: it guards nothing | the indexed query takes 0.7 ms, the same query without its index 1.7 ms, three runs each |
| `discovery` 200 ms budget | not run alone | CPU time of 500 `snippetParts` on 100,000 characters against 1,200 of them, limit 4 times and half a millisecond. Removing the `limit * 4` slice gives 5.57 against 1.28, a failure |
| `ops` `silent.ms < 1000` | not run: a limit that a machine 20 times slower still met | virtual timers and clock, `{ outcome: "timeout", ms: 50 }` exactly. A timer that ignores `timeoutMs` gives 1500 and fails |
| `native-api` three 5 s windows | not run | Date frozen, exact equality. `NATIVE_SESSION_MS` off by one fails by 1 ms |
| `event-stream-ping`, `account-usage`, `hermes-adapter` waits | not red: with the 30 ms `settle` at 0 the old ping file still passed 3 of 3 | each waits for what it needs: the ping bytes, ten event-loop turns, the cancel. Not shown red; they close a window rather than a failure I saw |

## 20 runs of each fixed file under the same load

| File or test | Load | Result |
| --- | --- | --- |
| `tests/send-timing.test.ts` | 1 core, 20 loops | 20 of 20 passed |
| `tests/plain-text.test.ts` | 1 core, 20 loops (the load that failed the old test 5 of 5) | 20 of 20 passed |
| `tests/group-watch.test.ts` | 1 core, 20 loops | 20 of 20 passed |
| `tests/hermes_compaction_test.py`, whole file | 1 core, 20 loops | 20 of 20 passed |
| its held-lock and maintenance tests | paused 1.3 s every 0.3 s | 20 of 20 passed (the old held-lock test failed 4 of 4 here) |
| `tests/hermes_computer_test.py -k megabyte` | 1 core, 40 loops (the load that failed the old test 4 of 4) | 20 of 20 passed |
| `discovery`, `ops`, `native-api`, `badge` together | 1 core, 20 loops | 20 of 20 passed |
| `event-stream-ping`, `account-usage-api`, `hermes-adapter` | 1 core, 8 loops | 20 of 20 passed (a lighter load: these were not shown red) |

`tests/check_all_test.py` and `tests/hermes_upgrade_linux_test.py` ran once, unloaded: both passed. They were not repeated under load.

## Every wall-clock assertion in `tests/`, `scripts/*test*.py` and `e2e/`

Found with `performance.now`, `Date.now`, `hrtime`, `time.time`, `time.monotonic`, `time.perf_counter`, `time.sleep`, `setTimeout(resolve, n)` and `realDelay` over every test file, then read where an assertion or an ordering followed. Sites in the same file with the same reason are grouped.

| Site | What it does | Verdict |
| --- | --- | --- |
| `tests/plain-text.test.ts` adversarial text, titles of dashes | 2 s and 200 ms `performance.now` budgets | fixed: CPU-time ratio of the full input to the window the parser reads |
| `tests/hermes_computer_test.py` megabyte of schemes | 2.0 s `perf_counter` budget | fixed: CPU-time ratio of 4 times the input to 1 times it, limit 8 (linear 4, quadratic 16) |
| `tests/discovery.test.ts` `snippetParts` on 100,000 characters | 200 ms budget | fixed: CPU-time ratio against the 1,200-character window it reads |
| `tests/badge.test.ts` pending decisions over 30,000 events | 250 ms budget | removed: the indexed query takes 0.7 ms and the same query without its index 1.7 ms, so the budget could not catch a lost index; the `EXPLAIN` plan assertion above it does |
| `tests/ops.test.ts` metadata probe to a socket that never answers | `silent.ms < 1000` with a 50 ms limit | fixed: virtual timers and clock, `{ outcome: "timeout", ms: 50 }` exactly |
| `tests/native-api.test.ts` three times | `Date.now()` within 5 s of a stored time | fixed: Date frozen, exact equality |
| `tests/send-timing.test.ts` growth notice | a 1 s throttle assumed to hold between two sends | fixed: virtual clock for the throttle, wait for the delta on the socket |
| `tests/send-timing.test.ts` hermes floor | `>= 19` after a real 20 ms delay | kept: a lower bound; a slow machine only makes it larger |
| `tests/send-timing.test.ts` 50, 300, 400 ms waits | wait, then assert nothing was logged or sent | kept: can only pass vacuously on a slow machine, never fail |
| `tests/group-watch.test.ts` abandon and settle | fixed 50 ms and 20 ms sleeps | fixed: wait for the server to reach the lookup; event-loop turns instead of 20 ms; `unwatch` waited for |
| `tests/hermes_compaction_test.py` held lock | `time.monotonic()` under 1 s with a 0.3 s bound | fixed: a clock that moves 0.1 s per look, lock held until the test releases it, assert `preempt` returned while it was held |
| `tests/hermes_compaction_test.py` maintenance | `time.monotonic()` under 1 s with `PREEMPT_WAIT` 2 | fixed: clock moving 0.01 s per look, assert the bound's warning is absent |
| `tests/hermes_compaction_test.py` 0.05 to 0.1 s sleeps | wait, then assert nothing happened yet | kept: vacuous on a slow machine, never failing |
| `tests/event-stream-ping.test.ts` `settle()` | 30 ms for the socket to deliver a ping | fixed for the three positive checks: wait for the expected bytes; the negative checks keep the sleep |
| `tests/account-usage-api.test.ts` 20 ms | lets the second request reach a held read | fixed: ten event-loop turns |
| `tests/hermes-adapter.test.ts` 10 ms after `stream.destroy()` | waits for the cancel | fixed: `vi.waitFor` the cancel |
| `tests/check_all_test.py` two `took` bounds, `tests/hermes_upgrade_linux_test.py` one | upper bounds of 5, 3 and 5 s on code that otherwise waits 60, 60 and 300 s | loosened to half of the wait they separate from (30, 30, 150 s): a hang detector, not a speed limit; the lower bounds stay |
| `tests/linked-chat-ui.test.ts:434`, `tests/prefetch-after-action-ui.test.ts:141` | `Date.now() - NOW < 5000` | kept: Date is pinned by `vi.useFakeTimers({ now: NOW })`, so it is virtual time |
| `tests/live-turn-timing.test.ts:190` gap budget | `gap.ms <= HERMES_MS + 3 * STEP_MS` | kept: measured on the virtual clock |
| `tests/conversation-events.test.ts` `until` (3 s) and the other poll loops with a real deadline | give up when a stream never delivers | kept: hang detectors; the loop moves virtual time, and a count of turns cannot stand in for socket delivery |
| `tests/main-assistant-api.test.ts` seven 100 ms waits, `tests/bot-access.test.ts` two 20 ms, `tests/direct-routes.test.ts`, `tests/live-turn-runtime.test.ts` five 20 ms, `tests/service-worker.test.ts`, `tests/sidebar-ui.test.ts` 520 ms | hold a request or an event, wait, then assert it did not get ahead | kept: on a slow machine the wait is too short to prove the point, so the test can pass without proving it, but it cannot fail |
| `tests/hermes_chat_reply_test.py` 0.8 and 1.2 s sleeps, `tests/hermes_experience_test.py` 3 s poll, `tests/hermes_turn_binding_test.py` 5 s poll, `tests/hermes_send_lanes_test.py` 3 s poll, `scripts/hermes-upgrade-worker-test.py` 10 s poll | hold, or give up on a poll | kept: same reasons as above |
| `e2e/smoke.spec.ts` growth steps against chat reads | counts text steps in a real browser against reads in the same window, `steps > reads + 3` | not changed, not reproduced: a stalled browser could merge steps; it needs a real browser, which this batch did not load |
| `scripts/run-python-tests.py` | reports `time.monotonic()` durations | not an assertion |

## Hand-break runs

Each protecting line broken, the file run, the source restored:

| Break | Result |
| --- | --- |
| `plain-text.ts` parse skips its read cuts and parses the whole input | failed: 3 tests (the two ratio tests and the first-1,000 test). The review found that removing only the outer `slice(0, READ_CHARS * 2)` fails nothing, because the inner `READ_CHARS` cut still bounds the read; the break has to bypass both, and that fails 5 tests |
| `conversation-routes.ts` throttle `last + 1000 - Date.now()` replaced by 0 | failed: the growth-notice test |
| `event-stream.ts` `closed` always false | failed: 2 `group-watch` tests |
| `compaction.py` `lock.acquire(timeout=...)` without the timeout | failed: the held-lock test, at its 10 s release |
| `extension.py` preempt moved under `maintenance_lock` | failed: the maintenance test, on the warning |
| `computer.py` scan made quadratic | failed: the megabyte test, 1.13 s against a 0.79 s limit |
| `discovery.ts` `limit * 4` slice removed | failed: the `snippetParts` test, 5.57 against 1.28 |
| `health.ts` timeout ignores `timeoutMs` | failed: the probe test, 1500 against 50 |
| `native-auth.ts` `NATIVE_SESSION_MS` minus 1 | failed: the renew test, off by 1 ms |

## Checks

`.agents/tools/check-all --py always --keep-going` on this branch:

check      result  queued  run    counts
typecheck  pass    -       1.1s   -
lint       pass    -       0.3s   -
ruff       pass    -       0.0s   -
test       pass    6m20s   27.5s  205 files, 3668 tests
build      pass    -       1.8s   892 modules
e2e        pass    15m46s  1m16s  40 tests
py         pass    -       4m33s  46 files

All 7 checks passed (28m27s total, 22m07s of it queued for heavy slots)

## Not done

No production code changed, so nothing here proves a product timing is right; only that the tests do not depend on the machine's speed. The
e2e `growth steps` check still depends on a real browser's pacing. The ledger entries `20261110T150036Z-flaky-digest-ui-tests.md` and
`20261111T075000Z-form-test-digest.md` list the tests that still fail under heavy starvation (`account-transitions-ui`, `live-updates-ui`,
`message-markdown`, `reply-keys`, `streaming-hold-back`) and that this change leaves alone.

## Review fixes

The Opus review found three P3s. Each fix and its red run:

| Change | Break | Result |
| --- | --- | --- |
| `plain-text` gets "parses a list nested as deep as the read window holds without stalling": one 498-deep list, one parse, under 3 s of CPU. The ratio test can't see a slowdown inside the window, and the old 2 s wall-clock budget could | `parse` burns 3.5 s when the text starts with a list marker | failed: 3,579 ms against 3,000. Unbroken, 3 of 3 passed |
| The megabyte scan stops measuring the full size at the first run under the limit, or at one 1.5 times over it | `_Delimiters.next` scans positions linearly, so the whole scan is quadratic | failed: 129.1 s against 64.8 s, after 154 s. The same break took 419 s before this change, running the slow size three times. Unbroken, 0.53 s |
| The hand-break row for `plain-text.ts` says which break fails the tests | none, wording only | not applicable |

