# November 10 the Hermes update worker no longer calls an unanswered maintenance acquire a harmless refusal

Branch `t3/worker-acquire-unanswered` over `origin/main` at `000f0de`, on NicolasLaptop (Fedora 44, Linux x64, 32 cores),
Python 3.14.10, Node 24.22.2, ruff 0.17.3. Source fingerprint
`sha256:91a8d0389a224d2948207bc9ab43b57fb2054fe8929d447823a9142b65cfe49d` (1742 source files) before this entry.
No Hermes process ran, nothing was deployed and the production host was not touched. Line numbers are `000f0de`'s
unless marked.

## Defect

`quiescence` in `scripts/hermes-upgrade-linux.py` saved phase `acquiring` and called `rpc("acquire")` (line 469)
inside one `try`. Every exception, a timeout included, went to the same `except`: clear the drain, `release`
(line 478), require `active` false, wait for the gateway, check host state, save `rejected` and exit 75 (line 484).
The RPC ran `NATIVE` with a 15 s wait per message and a 45 s child timeout (line 257).

The add-on's acquire handler (`src/hermes/extension.py:746`) preempts every canonical session's idle compaction
(line 758), each for up to 30 s (`src/hermes/compaction.py:30`), before it takes `maintenance_lock`, and writes the
lease last (line 777). An acquire made while a compaction ran could time out; the release found no lease and
answered inactive; the worker exited 75; and the handler then wrote the lease.

The worker read 75 as a finished refusal (`scripts/hermes-upgrade-worker.py:1192`, `:1198`): phase `blocked`,
`install_precondition_failed`, `maintenance` false, request complete. The person saw "The update was stopped before
installation. Check again after the installer resolves the failed check." The app accepted sends again, but Hermes
refused every one with 409 "Hermes is being upgraded" (`extension.py:797`), and the gateway reported draining and
answered Discord with its maintenance reply (`src/hermes/gateway_guard.py:65`, `:77`). The next update's baseline
then failed on the draining gateway and exited 75 again, with no hint. Only deleting the lease by hand cleared it.

Any other failure after phase `acquiring` exits 1. The worker then saves `failed`, `install_requires_review` and
keeps `maintenance` true (`hermes-upgrade-worker.py:1240`), so the app keeps refusing sends. The app offers Cancel or
Retry only when the lease exists and names the operation (`src/server/upgrades.ts:160-176`).

## Change

- `rpc` passes `wait` to `NATIVE` (acquire 120 s, others 15 s) with a child timeout of wait plus 30 s, so status and
  release keep their 45 s. It raises `Answered(error)` when `NATIVE`'s last stdout line is exactly
  `{"answeredError": {...}}`, `Unanswered` when the child ran and failed otherwise or timed out, and anything raised
  before the request is sent (the key, the interpreter) as itself.
- `quiescence`: the exact busy answer goes through the old release path to 75. Any other error answer raises without
  a release, exit 1. An unanswered acquire saves phase `acquire_unanswered` and watches `maintenanceFile` for
  `lateLeaseSeconds` (300). This operation's lease there means the handler returned, so the old release path runs
  and can exit 75. Otherwise, including another operation's lease, the hook exits 76 without a release.
- The worker turns exit 76 from quiescence into `MaintenanceUnanswered`: phase `failed`, `install_requires_review`,
  `maintenance` true, request pending, and a message that says to use Cancel if it appears, otherwise to ask the
  installer. A late lease makes the app offer Cancel, which restores Hermes through the verified recovery path.
- `docs/HermesUpgradeLinux.md`: a table of each way the acquire ends and a runbook for the held state.

## Red proof

A scratch runner applied each replacement, deleted every `__pycache__`, ran the file with `python3 -B` and
`PYTHONDONTWRITEBYTECODE=1`, and restored it. All 16 went red; the restored tree then passed.

| Broken | File run | Red |
| --- | --- | --- |
| Unanswered acquire released and refused at once (the old behavior) | `tests/hermes_upgrade_linux_test.py` | held test, another-lease test |
| No watch for a late lease | `tests/hermes_upgrade_linux_test.py` | late-lease test, another-lease test |
| Late-lease watch accepts any lease | `tests/hermes_upgrade_linux_test.py` | another-lease test |
| Unanswered acquire exits 75 | `tests/hermes_upgrade_linux_test.py` | held test, another-lease test |
| Phase `acquire_unanswered` not saved | `tests/hermes_upgrade_linux_test.py` | held test |
| Any error answer treated as the busy refusal | `tests/hermes_upgrade_linux_test.py` | other-error test |
| `rpc` never raises `Answered` | `tests/hermes_upgrade_linux_test.py` | busy, other-error and unanswered-release tests |
| `rpc` re-raises a failed child instead of `Unanswered` | `tests/hermes_upgrade_linux_test.py` | 7 errors in 5 tests |
| `answered_error` without the one-key check | `tests/hermes_upgrade_linux_test.py` | failed-child test |
| `answered_error` without the error-object check | `tests/hermes_upgrade_linux_test.py` | failed-child test |
| `answered_error` lets a non-JSON line raise | `tests/hermes_upgrade_linux_test.py` | failed-child test |
| Acquire keeps the 15 s wait | `tests/hermes_upgrade_linux_test.py` | 8 failures in 6 tests |
| `NATIVE` gets no `wait` | `tests/hermes_upgrade_linux_test.py` | 8 failures in 6 tests |
| The helper's busy text differs from the add-on's | `tests/hermes_send_lanes_test.py` | the maintenance active-work test |
| Worker treats exit 76 as a generic failure | `scripts/hermes-upgrade-worker-test.py` | the unanswered-acquire test |
| Worker shows the generic held message | `scripts/hermes-upgrade-worker-test.py` | the unanswered-acquire test |

## Tests

`MaintenanceRpcTests` runs the real `rpc` and `NATIVE` in the fixture's store interpreter against a local ticket
server and a fake add-on: the WebSocket client module in the fake Hermes source. It answers each request with the
step a test scripted and fails on any request it did not script. A late lease is written by a separate process once
the RPC child has exited. Eight tests: busy answer; no answer with the lease appearing later; no answer and no lease,
where recovery refuses at the missing lease and accepts once it exists; another operation's lease; another error
answer; a release with no answer; the failed-child line checks; and the paths after a successful acquire (active work,
an answer that is not this operation's lease, a setting changed while acquiring, and success). The worker test adds
the exit-76 outcome. `tests/hermes_send_lanes_test.py` pins the helper's `BUSY_REFUSAL` against the add-on's real
answer beside the release tool's.

Not covered by a red run: the child timeout of wait plus 30 s, since a test would wait at least 45 s for it to fire.

## Checks

| Check | Result |
| --- | --- |
| `npm run test:py` | 44 files passed, 0 skipped, 0 failed (252.7 s) |
| `tests/hermes_upgrade_linux_test.py` | 58 tests, 8 new |
| `scripts/hermes-upgrade-worker-test.py` | 81 tests, 1 new, 1 skipped (existing optional native source test) |
| `tests/deploy_common_test.py` | 32 tests, unchanged |
| `ruff check .` (0.17.3) | all checks passed |
| `npm run typecheck` | passed |
| `npm run lint` | passed |
| `npm test` | 195 files, 3,271 tests passed; the three Hermes update files (`tests/upgrades.test.ts`, `tests/hermes-upgrade-ui.test.ts`, `tests/hermes-update-tool.test.ts`) 47 tests passed. No TypeScript changed |

The worker was not run against a real system, and `NATIVE` has not reached a real Hermes. The 120 s acquire wait
and the 300 s watch are sized from the add-on's source, not measured.
