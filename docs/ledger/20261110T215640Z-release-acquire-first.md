# November 10 the guarded release takes Hermes's maintenance lease before it stops the app

Branch `t3/release-acquire-first` over `origin/main` at `caeeb7f`, on NicolasLaptop (Fedora 44, Linux x64, 32 cores),
Python 3.14.10, Node 24.22.2, ruff 0.17.3. Source fingerprint
`sha256:3d25f2d925cad62ec0e583296b6511ba0061f430a9c5ba1843b2bec132ae9040` (1733 source files). No Hermes process ran, nothing was
deployed and the production host was not touched. Line numbers are `caeeb7f`'s unless marked.

## Defect

`.agents/tools/deploy-guarded-app-release.py` fenced maintenance `status` idle (line 71), checked the gateway, ran the
Google check (up to 90 s, `deploy_common.py:114`) and `app_ready`, wrote the blocked update status (line 81), stopped
`agent-interface.service` (line 82, up to 120 s), and only then called `acquire` (line 89). A send that reached Hermes
between the status check and the blocked status write was admitted. When its turn was still running at `acquire`, the
add-on refused (`src/hermes/extension.py:773-774`), the RPC script raised on the error (`scripts/hermes-upgrade-linux.py:112`),
and the failure path (line 131) journaled `maintenance-held-needs-review` and exited 2. The app stayed stopped with the
blocked status and no lease; the dashboard and gateway kept running. The turn itself finished, since a running turn
survives an app restart (`docs/HermesCapabilityMatrix.md:75`), but the sender saw the app drop mid-reply and stay down
until an operator restarted it, and the restarted app still refused sends under the blocked status.

The old order existed for the app's own writes to the status file, not for the lease. The app can still be finishing an
update install or check whose own checks ran before the tool took the update worker's lock (`src/server/upgrades.ts:281-304`,
`:273-278`). Stopping the app ends those, so the pending-requests fence after the stop is final, and rewriting the blocked
status after the stop removes one such request's write. Both need the app stopped before the destructive steps. Neither
needs the lease taken after the stop.

## Change

The ordered steps moved into `Deployment.acquire_then_stop_app` in `deploy_common.py`, which takes the maintenance RPC as
an argument, so they can be tested without the hard-coded `/usr/bin/systemctl` and `127.0.0.1:9119` the inline script
also uses. The order is now: write the blocked status, journal `maintenance-acquiring`, acquire, journal
`owned-maintenance-acquired`, stop the app, fence that every update request is complete, rewrite the blocked status.

When acquire answers with the add-on's busy refusal, or its answer fails a fence, the step calls `release`, which removes
this operation's lease if acquire wrote one (`extension.py:779-781`), and requires no lease to remain, the status file to
hold exactly its blocked status and no update request to be pending. It then restores the saved status, journals
`maintenance-refused` and raises `Refused`. The tool prints the busy list the release reported and exits 75;
`release-app.py activate` leaves the stage `prepared` for that exit only. A failed release or any failed refusal fence
falls through to the old review path with the blocked status kept. An acquire with no answer is not a refusal; see
"Review fixes" below, which replaced this commit's first version of that path.

## Red proof

A scratch runner applied each replacement, deleted every `__pycache__`, ran the test file with `python3 -B` and
`PYTHONDONTWRITEBYTECODE=1`, and restored the file. All went red; the restored tree then passed.

| Broken | File run | Red |
| --- | --- | --- |
| App stopped before acquire (the old order) | `tests/deploy_common_test.py` | 6 failures, including the order test and the busy test |
| Blocked status written after acquire | `tests/deploy_common_test.py` | 9 failures, including the order test |
| No release on refusal | `tests/deploy_common_test.py` | 4 failures and 3 errors, including the lost-answer test |
| Fence "refused: maintenance released" removed | `tests/deploy_common_test.py` | the uncertain-refusal test |
| Fence "refused: no maintenance lease remains" removed | `tests/deploy_common_test.py` | the uncertain-refusal test |
| Fence "refused: update status is still this operation's blocked status" removed | `tests/deploy_common_test.py` | the uncertain-refusal test |
| Fence "refused: pending update requests are complete" removed | `tests/deploy_common_test.py` | the uncertain-refusal test |
| Saved status not restored on refusal | `tests/deploy_common_test.py` | 4 failures: busy, lost answer, unexpected answers |
| `maintenance-refused` not journaled | `tests/deploy_common_test.py` | the busy test |
| Refusal raised as a plain error | `tests/deploy_common_test.py` | 4 errors: busy, lost answer, unexpected answers |
| Fence "pending update requests complete after the app stopped" removed | `tests/deploy_common_test.py` | the request-during-stop test |
| Blocked status not rewritten after the stop | `tests/deploy_common_test.py` | the status-during-stop test |
| A journal write placed before the `--check` exit | `tests/deploy_common_test.py` | the `--check` structure test |
| Wrapper treats exit 75 as a failure | `tests/release_app_test.py` | the refusal test |
| Wrapper treats a preflight's exit 75 as a refusal | `tests/release_app_test.py` | the refusal test |
| Wrapper leaves a refused stage `activating` | `tests/release_app_test.py` | the refusal test |

## Checks

| Check | Result |
| --- | --- |
| `npm run test:py` | 44 files passed, 0 skipped, 0 failed (206.7 s) |
| `tests/deploy_common_test.py` | 26 tests, 9 new: 8 for the ordered steps, 1 for `--check` |
| `tests/release_app_test.py` | 50 tests, 1 new: exit 75 keeps the stage prepared, a preflight's 75 is a failure |
| `ruff check .` (0.17.3) | all checks passed |
| `npm run typecheck` | passed |
| `npm run lint` | passed |
| `npm test` | 192 files, 3202 tests passed |

## Not exercised

The inline tool itself was not run end to end. `--check` is covered by a structural test that everything before its exit
only reads; the tool's `--check` code did not change. Whether the app's own reads (`agent-interface.open`,
`agent-interface.discover`) hold a reservation often enough to make `acquire` refuse while the app runs
(`extension.py:773`, `active_count() > 1`) needs a real release to show. A refusal costs one rerun.

## Review fixes

The Grok 4.7 review of `f03b7ed` found two defects. Line numbers below are this fix's.

**P1. A lost acquire answer was a finished refusal.** The add-on preempts each canonical session's idle compaction for
up to 30 s (`src/hermes/compaction.py:30`) before it takes `maintenance_lock` and writes the lease
(`src/hermes/extension.py:754-778`). `NATIVE` read each WebSocket message for 15 s and failed the same way for a 409 and for
silence, so a slow acquire went through release, the four fences and the restore, exited 75, and could then write its
lease: app running, status idle, opens refused, stage `prepared`.

- `NATIVE` (`scripts/hermes-upgrade-linux.py:93-120`) prints `{"answeredError": ERROR}` as its last stdout line before it
  raises the same `RuntimeError` as before, and reads `wait` from its payload, default 15. Its other callers send no `wait`
  and never read a failed child's stdout, so their behavior is unchanged: the update worker's `native`
  (`hermes-upgrade-linux.py:255`, through `rpc` in `quiescence`, `verify`, `recovery_guard` and `finish`), `recover-app-after-native-update.py:328`,
  `deploy-app-release.py:66-75` and `scripts/spike/service_probe.py:193`. None of them was edited.
- `Deployment.maintenance_rpc` (`deploy_common.py`) runs it and raises `Answered(error)` only when the last stdout line is
  exactly that shape. Any other failure stays a plain `RuntimeError`. Acquire waits 120 s per message, enough for four
  canonical sessions' preempts, and 145 s in all; other actions keep 15 s and 40 s. The guarded tool's `rpc` uses it.
- `acquire_then_stop_app` refuses only for `Answered(BUSY_REFUSAL)`, the add-on's exact busy answer, which
  `tests/hermes_send_lanes_test.py` now pins against the real handler. Any other error answer propagates for review. With
  no answer it tries one release, ignores that release's failure, and raises `Fence("Hermes answered maintenance acquire")`,
  so the tool exits 2 with the blocked status kept and `release-app.py activate` marks the stage `needs-review`.
- The tool does not wait out the handler and then refuse. The handler's worst case depends on how many canonical
  sessions it walks and on Hermes's dispatch, neither of which the tool can read, so no wait proves the lease can no
  longer appear. `docs/HermesUpgradeLinux.md` gives the operator's steps instead: wait five minutes, delete a lease that
  names this operation, restore the saved status only if the file still holds this operation's blocked status, and
  prepare again.

**P2.** `docs/HermesUpgradeLinux.md` said a status the app rewrote kept the blocked status. The fence fires before the
restore, so the file keeps the app's bytes; the runbook now says to leave them in place.

### Red proof

A scratch runner applied each replacement, deleted every `__pycache__`, ran the test file with `python3 -B` and
`PYTHONDONTWRITEBYTECODE=1` from `tests/`, and restored the file. All went red; the restored tree then passed.

| Broken | File run | Red |
| --- | --- | --- |
| Unanswered acquire refused like a finished one (`f03b7ed`'s behavior) | `tests/deploy_common_test.py` | the unanswered-acquire test, 1 failure and 2 errors |
| No release after an unanswered acquire | `tests/deploy_common_test.py` | the unanswered-acquire test, 3 subtests |
| A failed release after an unanswered acquire propagates | `tests/deploy_common_test.py` | the unanswered-acquire test, release unreachable |
| Any error answer treated as the busy refusal | `tests/deploy_common_test.py` | the other-error-answer test |
| `maintenance_rpc` never raises `Answered` | `tests/deploy_common_test.py` | the error-answer test |
| `Answered` without the one-key shape check | `tests/deploy_common_test.py` | the failed-child test |
| `Answered` without the error-object check | `tests/deploy_common_test.py` | the failed-child test |
| A non-JSON last line not caught | `tests/deploy_common_test.py` | the failed-child test |
| Acquire keeps the 15 s wait | `tests/deploy_common_test.py` | the acquire-wait test |
| `NATIVE` ignores `wait` | `tests/deploy_common_test.py` | the acquire-wait test |
| `NATIVE` prints no answered error | `tests/deploy_common_test.py` | the error-answer test |
| The guarded tool's `rpc` uses plain `run` | `tests/deploy_common_test.py` | the wiring test |
| The add-on's busy message differs from `BUSY_REFUSAL` | `tests/hermes_send_lanes_test.py` | the maintenance active-work test |

### Tests

`tests/deploy_common_test.py` replaces the lost-answer test with three cases: the answer lost after the lease (the release
still runs while the lease is held and removes it), the lease written after the release returned, and an unreachable
release. Each keeps the blocked status and raises the fence, not `Refused`. The busy test now raises the add-on's exact
error, and a new test holds another error answer for review without a release. `MaintenanceRpcTests` runs the helper's
real `NATIVE` against a local ticket server and a fake WebSocket client module that fails on any unscripted receive.


### Checks

| Check | Result |
| --- | --- |
| `npm run test:py` | 44 files passed, 0 skipped, 0 failed (262.3 s) |
| `tests/deploy_common_test.py` | 32 tests, 6 new: 4 for `NATIVE` through `maintenance_rpc`, 1 for another error answer, 1 for the tool's wiring; the lost-answer test replaced |
| `ruff check .` (0.17.3) | all checks passed |
| `npm run typecheck` | passed |
| `npm run lint` | passed |
| `npm test` | 192 files, 3202 tests passed on three runs. The first run, right after `npm ci`, failed 6 tests in 2 files; its output was not kept and the failure did not recur. This fix changed no TypeScript |

The guarded tool was not run, and `NATIVE` did not reach a real Hermes. The 120 s acquire wait is sized from the add-on's
source, not from a measured acquire during a compaction.

## Second review: Grok 4.7 on `84e0e8b`

Ready, no findings. The reviewer walked seven ways an acquire can end and found none that exits 75 while a lease can
still appear. It confirmed that only the add-on's exact busy answer, or a success object that fails the tool's two
checks, is a refusal; that every other answer exits 2 without a release; and that no other caller of `NATIVE` passes
`wait` or reads a failed child's output. Eight breaks went red.

Two notes it did not raise as findings are applied here by the orchestrator (Claude Fable 5.2), in a comment and the
runbook only:

- The comment on `MAINTENANCE_WAIT` said 120 s was enough for four compactions. Nothing caps the chain of preempts,
  and four full waits do not fit. The comment now says three, and that a longer chain is held for review.
- The runbook's step 3 now says the temporary file goes in the same directory as `status.json`, and step 1 says why
  the wait must not be skipped.

After merging `main` at `145104f`: `npm run typecheck`, `npm run lint`, `ruff check .` passed; `npm run test:py`:
44 files passed in 212.1 s on Python 3.14.10; `npm test`: 195 files, 3,271 tests passed. The guarded tool was not run,
and `NATIVE` has not reached a real Hermes.
