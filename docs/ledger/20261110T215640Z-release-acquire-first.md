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

When acquire raises or its answer fails a fence, the step calls `release`, which removes this operation's lease if a lost
answer hid one (`extension.py:779-781`), and requires no lease to remain, the status file to hold exactly its blocked
status and no update request to be pending. It then restores the saved status, journals `maintenance-refused` and raises
`Refused`. The tool prints the busy list the release reported and exits 75; `release-app.py activate` leaves the stage
`prepared` for that exit only. A failed release or any failed refusal fence falls through to the old review path with the
blocked status kept. This mirrors the Hermes update worker's quiescence, which acquires with the app running and
releases on any refusal (`hermes-upgrade-linux.py:464-479`).

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
