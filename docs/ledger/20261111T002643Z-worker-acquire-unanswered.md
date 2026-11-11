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
  `LATE_LEASE_SECONDS` (300, a module constant). This operation's lease there means the handler returned, so the old release path runs
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

The child timeout of wait plus 30 s is covered in the review round below: patching `DEFAULT_MAINTENANCE_WAIT` to 0
and `MAINTENANCE_OVERHEAD` to 1 gives a 1 s child timeout, so its test takes about 1 s, not 45 s.

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

## Review round: a failure before the request is sent, and the guards around it

A review ran the real `rpc` and `NATIVE` against the fixture's ticket server. A wrong service key (ticket 403) and a
closed dashboard port both exited 76 after the 300 s watch with no add-on request made, because `rpc` raised
`Unanswered` for any failed child without the answered-error line, and `NATIVE` fails before `ws.send` in the ticket
request and the connect. The app then said Hermes may still pause itself, which was false, no lease ever appeared so
Cancel never showed, and the runbook made it worse: a hand-written lease made Cancel's `recovery_guard` call
`rpc("status")`, which fails on the same ticket, so recovery failed and the lease blocked every chat and Discord message.

Changes, in `scripts/hermes-upgrade-linux.py` unless named:

- `NATIVE` wraps the imports, the ticket request and the connect. A failure there prints `{"unsent": true}` as the last
  stdout line and fails as before. Output of a successful run is unchanged.
- `rpc` raises a new `NotSent` for exactly that line. `quiescence` sends `NotSent` through the release path: 75 when the
  release confirms, and the release's own `NotSent` (exit 1, phase `acquiring`) when it fails too.
- `baseline` reads the service key and checks for an existing drain marker before phase `acquiring`, so both exit 75.
- The `lateLeaseSeconds` config key is gone. Nothing set it outside the tests, which now patch `LATE_LEASE_SECONDS`.
  No operator need turned up: the watch exists to outlast a handler that already ran, and the runbook states the wait.
- `docs/HermesUpgradeLinux.md`: the three-way answer, the `NotSent` row, a table row that says another operation's or an
  unreadable lease also ends in 76, a corrected key-mismatch paragraph, a step 3 wait with its arithmetic, and how to tell
  whose lease it is.

Other callers of `NATIVE` read only the exit status and stdout of a success, or the last line of a failure, so the new
line changes nothing for them: `.agents/tools/deploy_common.py` `maintenance_rpc` (its last-line check wants the single
key `answeredError`, so it raises its generic failure as before), `.agents/tools/recover-app-after-native-update.py`,
`.agents/tools/deploy-app-release.py` and `scripts/spike/service_probe.py` (all fail on a nonzero exit; the spike's
wrong-key and wrong-route checks only assert a nonzero exit and keep the `/api/ws?ticket=` text it rewrites),
`scripts/hermes-upgrade-linux.py` `native()` (parses stdout on success only), and `.agents/tools/deploy-guarded-app-release.py`
(through `maintenance_rpc`). Not changed: the guarded release tool still treats a failure before the send as no answer.

### Red proof

Same method as above: each replacement applied, every `__pycache__` deleted, the test file run with `python3 -B` and
`PYTHONDONTWRITEBYTECODE=1`, and the line restored. All ten went red; the restored tree passed.

| Broken | Class run | Red |
| --- | --- | --- |
| `NATIVE` prints no unsent line | `MaintenanceRpcTests` | the before-send test, the release-confirms test |
| `rpc` never raises `NotSent` | `MaintenanceRpcTests` | the before-send test, the release-confirms test |
| `unsent` accepts any JSON object | `MaintenanceRpcTests` | the unsent-line test, the answered-line test |
| `unsent` accepts extra keys | `MaintenanceRpcTests` | the unsent-line test |
| `quiescence` has no `NotSent` release path | `MaintenanceRpcTests` | the before-send test, the release-confirms test |
| `baseline` does not read the key | `PlatformTests` | the missing-key-or-drain test |
| `baseline` does not check the drain marker | `PlatformTests` | the missing-key-or-drain test |
| `late_lease` treats an unreadable lease as this operation's | `MaintenanceRpcTests` | the unreadable-lease test, all three cases |
| `rpc` lets a child timeout escape | `MaintenanceRpcTests` | the timed-out-child test |
| Child timeout uses 30 instead of `MAINTENANCE_OVERHEAD` | `MaintenanceRpcTests` | the timed-out-child test |

New tests: a wrong key, a closed port and a refused connection each raise `NotSent`, reach no add-on, and fail the
release at once with no watch; an acquire refused once before it is sent exits 75 when the release confirms; the exact
unsent line; a stalled add-on hits the real child timeout; a malformed, a group-readable and an unreadable lease each end
the watch with exit 76 and are left alone; a missing key and an existing drain each exit 75 from the baseline.

### Checks after the review round

On `59a1b49` (the branch merged with `origin/main` at `785f4f2`) plus these changes, same machine and tool versions.

| Check | Result |
| --- | --- |
| `npm run test:py` | 44 files passed, 0 skipped, 0 failed (245.1 s) |
| `tests/hermes_upgrade_linux_test.py` | 64 tests, 6 new since the first round |
| `ruff check .` (0.17.3) | all checks passed |
| `npm run typecheck` | passed |
| `npm run lint` | passed |
| `tests/upgrades.test.ts`, `tests/hermes-upgrade-ui.test.ts`, `tests/hermes-update-tool.test.ts` | 47 tests passed |

`NATIVE` still has not reached a real Hermes; the wrong-key, closed-port and refused-connection cases run the real
`NATIVE` against the local ticket server and the fake WebSocket client. A failure of the interpreter's own
`hermes_bootstrap` import still prints no marker, so it still counts as no answer; the baseline's launcher and runtime
checks run that interpreter first.
