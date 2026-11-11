# November 10 a busy or unreachable Hermes no longer leaves the guarded release needing review

Branch `t3/guarded-release-busy`, from `origin/main` at `16c96a8`, merged with `origin/main` at `41bfa49` (check-all, #339), on
NicolasLaptop (Fedora 44, Linux x64, 32 cores), Python 3.14.10, Node 24.22.2, ruff 0.17.3. Source fingerprint
`sha256:430c3c9021bb5fbcd2c76acca7f92db5ba103ffd75c865fdb64cc8f5e89521f5` (1765 source files) with this entry's change set. No Hermes
process ran, nothing was deployed and the production host was not touched. Line numbers are this branch's. No file of
`src/shared/qualification-inputs.json` changed.

## Defects

The guarded tool's gaps from #328's ledger (`20261110T215640Z-release-acquire-first.md`):

- **B2e-2.** The preflight's busy guards (`gate["active"] is False and gate["busy"] == []`, the gateway's agent count, the dashboard's
  `active_agents` and `active_sessions`) were `fence` calls outside the cutover `try`. A busy Hermes raised an uncaught `Fence`, exit 1,
  and `release-app.py activate` marked the stage `needs-review` although the tool had changed nothing.
- **B2e-1.** A Discord turn runs in the gateway runner, not in the add-on's `server._sessions`, so the add-on's busy list omits it. The
  acquire succeeded, the app stopped, and the 30 s drain wait could then fail with the app down.
- **B2e-6.** The app's own 5 s poll holds an add-on reservation (`src/hermes/extension.py`, `active_count() > 1`), so an idle app could draw the
  busy answer once and the whole activation refused.
- **Before-send failures.** `NATIVE` prints `{"unsent": true}` when the service ticket or the connection fails before the request is sent
  (#334). `maintenance_rpc` treated that as no answer, so the acquire went to the held-for-review path (exit 2) although the add-on never saw
  it and no lease can appear.

## Change

- `deploy-guarded-app-release.py:60-67`: `idle(condition, why, detail)` replaces `fence` for the three preflight busy guards. Under
  activation it prints `Release not started: Hermes has active work (<guard>)...` and exits 75 with nothing changed. Under `--check` it raises
  the same `Fence`, so the exit code and the `Fence: <guard>` text that `prepare-when-idle.py` reads are unchanged. A status request that fails
  before it is sent (`NotSent`) exits 75 the same way, and still raises under `--check` (lines 80-82).
- `deploy_common.py:177-181` `Deployment.gateway_reports_idle`, used by `acquire_then_stop_app` after the acquire answered with this
  operation's lease and before the journal and the app stop (line 234). The gateway rewrites its record at every turn boundary
  (`gateway/run_agent_cache.py` `_persist_active_agents`, read at `ed1afb0`), and the held lease admits no new turn, so a count read now is the last
  one to wait for. A count above zero, listed work, a count that is not an integer or an unreadable record releases and exits 75.
- `deploy_common.py:205-214`: the exact busy answer is asked again, `ACQUIRE_ATTEMPTS = 3` attempts `ACQUIRE_RETRY_SECONDS = 2` apart. A busy
  answer writes no lease, so no release goes between attempts. Any other error answer is still held for review without a retry.
- `deploy_common.py:215-218`, `:140-142`: `maintenance_rpc` raises `NotSent` for exactly `{"unsent": true}` as the last stdout line (the key set and
  `is True`, so `{"unsent": 1}` is not it). An unsent acquire goes through `refuse`, as the worker does; a release that is unsent too raises
  `NotSent`, exit 2, blocked status kept.
- `Refused` messages now say why and what to do (busy, not reached, not this operation's lease, gateway active); the tool prints them as is.
- `docs/HermesUpgradeLinux.md`: the preflight paragraph, steps 2 to 5, an exit table, and the held-for-review list. `.agents/tools/README.md`: the
  tool's line.

## Tests

`tests/deploy_guarded_release_test.py` (new, 11 tests) runs the real tool in this process through `runpy` against a fake host. systemctl and the
managed Python that carries the RPC are executables that record their calls and answer from a script, and fail on any call a test did not
script; git is real, against a temp repository; `urllib.request.urlopen` answers the app and dashboard; the update claim is a stand-in for
Hermes's lock. It asserts exit codes, printed text, the RPC order, the status file, the journal phase, the lease and every systemctl call.
Bad inputs: each of six preflight busy conditions exits 75 and, under `--check`, raises `Fence` with that guard's name; an unreachable status
request exits 75 and raises `NotSent` under `--check`; a status that fails with no marker, an answered error, a stale gateway heartbeat and
a gateway not running stay failures in both modes; a busy acquire three times refuses with two 2 s pauses; busy then granted reaches the app stop;
a gateway agent counted by the time the acquire returns refuses before the stop; unsent refuses; unsent plus an unsent release and an acquire
with no answer both exit 2.

`tests/deploy_common_test.py` (32 to 42 tests): the same cases at `acquire_then_stop_app`, with the gateway's record varied (agent, named work, a
string count, a boolean count, no count, unreadable) and every reason asserted; a refusal whose release does not prove the lease gone stays a fence;
`maintenance_rpc` through the real `NATIVE` against a local ticket server for a refused service key, a closed port, a refused connection and a
failed `send` (which may have been delivered, so it is not unsent); the unsent marker's exact shape. The wiring tests now read `idle` calls as well
as `fence` calls for unique constant guard names and for what `prepare-when-idle.py` matches.

## Red proof

A scratch runner applied each replacement, deleted every `__pycache__`, ran `tests/deploy_common_test.py` and
`tests/deploy_guarded_release_test.py` with `python3 -B` and `PYTHONDONTWRITEBYTECODE=1`, and restored the file. All 19 went red; the restored
tree then passed both files.

| Broken | Red |
| --- | --- |
| A busy acquire never asked again | 2 + 2 failures: both retry tests |
| Retry without the 2 s pause | 2 + 1: both retry tests, the refusal pauses |
| 2 attempts, not 3 | 2 + 1 |
| An unsent acquire not handled | 2 + 1: the refusal and the unsent-release test |
| `maintenance_rpc` never raises `NotSent` | 4 errors in `deploy_common_test`, 2 in the tool test |
| `NotSent` accepts extra keys | the exact-marker test |
| `NotSent` accepts an equal value (`1`) | the exact-marker test |
| The gateway refusal does nothing (the app stops) | 7 + 1 |
| The gateway check removed | 7 + 1 |
| The gateway count accepts a boolean | the gateway cases |
| The gateway count accepts any non-negative number | 2 |
| Listed gateway work ignored | the gateway cases |
| The preflight busy exit is 1 | 7 failures in the tool test |
| Busy under `--check` no longer a `Fence` | 6 |
| An unsent status is not a refusal | the unreachable test |
| An unsent status refused under `--check` | the unreachable test |
| The dashboard's session count ignored | 2 |
| The gateway guard's name changed | the `prepare-when-idle` wiring test and 4 in the tool test |
| The gateway preflight is `fence` again | the wiring test and 17 errors |

## Checks

`.agents/tools/check-all --keep-going` on the merged branch: all 7 passed in 5m46s, none of it queued.

| Check | Result |
| --- | --- |
| typecheck, lint, `ruff check .` (0.17.3) | passed |
| `npm test` | 204 files, 3,588 tests passed |
| `npm run build` | 891 modules |
| `npm run test:e2e` | 39 tests passed (ports 24754, 24755) |
| `npm run test:py` | 46 files passed in 4m17s |

## Not exercised

The tool did not run on the host, and `NATIVE` did not reach a real Hermes; the tool test replaces systemctl, the update claim, the managed
Python and the HTTP answers. Whether the gateway's `active_agents` already counts a Discord turn by the time the acquire returns rests on
`_persist_active_agents` running at the turn's claim (`gateway/run_inbound.py`, read at `ed1afb0`), not on a measured Discord turn. The 2 s
retry pause is sized from the app's 5 s poll, not measured. A `--check` is unchanged in exit code and output text, but its traceback now names
the same `Fence` from `idle` rather than from `fence`, a line `prepare-when-idle.py` does not read.

## Review round 1: four P3s

Claude Opus 5.5 reviewed `61f176a` as ready with four P3s. All four are fixed on top of it, as Claude Sonnet 5.5 (same provider as the author;
`independent-review-owed`), after merging `origin/main` (`acec071`) into the branch. Source fingerprint
`sha256:95b0283be43bd6f7bc2ddbe3acbfda7c83e6e95e767bf0f8286fb04256ebf584` (1767 source files) with this round's change set. None of the
changed files is in `src/shared/qualification-inputs.json`. Line numbers are this branch's.

1. **A gate another operation holds is a fence again.** The preflight had made `gate["active"] is True` busy work (exit 75). Line 29 had
   already found no lease at the configured path, so a held gate is a concurrent or misconfigured operation that needs a person.
   `.agents/tools/deploy-guarded-app-release.py:84-85`: `fence(gate["active"] is False, "no other operation holds the maintenance gate")`,
   then `idle(gate["busy"]==[], "maintenance gate inactive with no busy work", ...)`, whose name `prepare-when-idle.py` matches, unchanged.
   The new fence's name does not match that pattern, so the idle wait never retries it. The check runs first, so a held gate that also lists
   work is still a fence. `tests/deploy_guarded_release_test.py:279-282`: the case left the busy table and joined "other preflight failures are
   not a refusal", twice (no work listed, work listed), each with and without `--check`, expecting the fence and nothing changed.
   `tests/deploy_common_test.py` `test_idle_wait_recognizes_the_guarded_preflights_busy_fence` now finds the busy `idle` by `gate['busy'] == []`
   and requires exactly one fence on `gate['active'] is False` that the idle wait's pattern does not match.
2. **The unsent marker must be the last line.** `tests/deploy_common_test.py:617`: a child that prints the marker and then another line fails
   with the plain error, not `NotSent`.
3. **`docs/HermesUpgradeLinux.md`**: a row in the exit table for the preflight failures that are not busy work (a lease held by another
   operation, a stale heartbeat, the gateway not running, a git or repair mismatch, a status request that failed with no marker or answered
   an error): exit `1`, nothing changed, and `release-app.py` marks the stage `needs-review`, which is what `guarded()` returning `None` does.
   A sentence before the table says a held gate is not busy work and is not retried.
4. **`gateway_reports_idle` requires `active_work`.** `.agents/tools/deploy_common.py:183`, as the preflight does. `tests/deploy_common_test.py:341`:
   a gateway record that never lists its work refuses after the acquire and before the app stops (`ABSENT` leaves a key out of the fake
   record).

### Red proof

Each break was made by a scratch runner that applied the replacement, ran the named file with `python3 -B -m unittest`, and restored the file.
The restored tree passed all three files.

| Broken | File run | Red |
| --- | --- | --- |
| The held gate is `idle(gate["active"] is False and gate["busy"]==[], ...)` again | `deploy_guarded_release_test` | the other-failures test, for both held-gate cases, with and without `--check` (4 failures) |
| Same | `deploy_common_test` | the idle-wait wiring test |
| The unsent marker found on any line | `deploy_common_test` | the last-line test (and an unrelated answered-error test, since the break was crude) |
| `gateway_reports_idle` without the `active_work` key requirement | `deploy_common_test` | the gateway test, case "no work list" |

### Checks

`.agents/tools/check-all --keep-going --py always`: all 7 passed in 18m16s, 12m06s of it queued for the machine's heavy slot.

| Check | Result |
| --- | --- |
| typecheck, lint, `ruff check .` | passed |
| `npm test` | 205 files, 3,645 tests passed |
| `npm run build` | 891 modules |
| `npm run test:e2e` | 40 tests passed |
| `npm run test:py` | 46 files passed in 4m29s |

Not exercised: no host ran the guarded tool; every test drives it against fakes, as before this round.
