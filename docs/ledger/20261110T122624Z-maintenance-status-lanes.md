# November 10 maintenance status lists app sends that wait for or hold a lane

Branch `t3/maintenance-status-lanes` over `t3/send-lanes` at `a561fba`, on NicolasLaptop (Linux x86_64, Python 3.14.10,
Node 24.22.2). Source fingerprint `sha256:bb9dd9eb2ca21e68926aff7344a44102ec273d72f1ed5077562de10fcfe423ff` (1688 source files);
`src/hermes` alone `sha256:99b07f2179a6534641ad627c94f81acdea5f025e581b45fff2fb8c163a3dae5e` (20 source files). No Hermes process ran and the production host was not touched.

## Defect

GPT-6.1 Sol's review of `t3/send-lanes` reproduced maintenance `status` answering `active: false, busy: []` with one
send held in image staging and another waiting on its lane, and the `acquire` that followed answering 409 "Hermes still
has active work". `status` listed only sessions Hermes marks busy (`running`, a queued prompt, a pending steer, a
scheduled auto-continue). A send staging images or inside Hermes's admission call has not marked its session running yet,
and a send waiting on its lane has not reached Hermes, but each holds an admission reservation, which `acquire` counts.
The same gap existed on `main` for a send waiting for a compaction to stop; the lanes widened it.

The harm is in the caller. `.agents/tools/deploy-guarded-app-release.py` checks `status` (line 71), writes the blocked
upgrade state, stops `agent-interface.service`, and only then calls `acquire` (line 89). When `acquire` is refused its
failure path (line 130) keeps the blocked state, journals `maintenance-held-needs-review`, and does not restart the app.

## Change

`route` registers each queued app send while its admission reservation is held: from just after the reservation until
just before its release, `queued` while it waits on its lane and `admitting` once its job runs. `busy_sessions`, which
both `status` and `acquire` read, appends one entry per registered send in the shape callers already read:
`{"sessionId": <the assistant's canonical session or null>, "profile": <assistant>, "state": "queued" | "admitting"}`.
Because an entry exists only while its reservation does, `status` lists a send exactly when `acquire` would refuse for it.
A send whose lane submission raises is removed with its reservation.

## Callers of maintenance `status`

| Caller | When | What it checks | With a send listed |
| --- | --- | --- | --- |
| `.agents/tools/deploy-guarded-app-release.py:71` | preflight, no lease, before any state write or service stop; also under `--check` | `active is False and busy == []` | Fence "maintenance gate inactive with no busy work": exits before writing state or stopping anything |
| `.agents/tools/prepare-when-idle.py` (through `release-app.py prepare`, which runs the tool above with `--check`, `release-app.py:622-624`) | preflight | its `BUSY` pattern matches that fence (line 34) | discards the stage and retries as "app or routine session running" |
| `deploy-guarded-app-release.py:96`, `:119` | under this operation's lease | `busy == []` | cannot happen: under a lease a send is refused 409 before it reaches a lane |
| `.agents/tools/recover-app-after-native-update.py:348` | under this operation's lease | `busy == []` | cannot happen, as above |
| `recover-app-after-native-update.py:417` | after release | `active is False` only | unaffected |
| `scripts/hermes-upgrade-linux.py:666` | verification, under lease | `active` and `operationId` only | unaffected |
| `scripts/hermes-upgrade-linux.py:772` | recovery, under lease | `busy == []` | cannot happen, as above |
| `scripts/spike/service_probe.py:203`, `:208` | qualification probe, idle disposable gateway | `active` only | unaffected |

`src/server/upgrades.ts` sends no maintenance RPC; it reads the lease file. The upgrade helper (`hermes-upgrade-linux.py:464`)
and `scripts/spike/extension_probe.py:121` call `acquire` without a `status` preflight; `acquire` already refused for
these sends and still does, now also through `busy`.

## Decisions

- One entry per send, not per assistant, so two sends to one assistant show as two, and a caller can tell a send that
  runs from one that waits. No caller reads the entries' fields today; each compares `busy` with `[]`.
- The list lives where the reservation is taken, in `route`. A send that reaches `submit` without a connection transport
  runs on the reader under native dispatch, as before; it is not listed, as it was not before. Every app send arrives
  with a transport.
- The release tool's order is unchanged on this branch. Acquiring before stopping the app would be a worthwhile second
  guard: a send that arrives between the `status` check and the stop still makes `acquire` refuse after the app is
  stopped. With the lease taken first, such a send is refused at the gate with the upgrade message and its draft kept,
  and a refused `acquire` leaves nothing stopped. The tool stops the app first so no awaited request races its private
  status write; that order would need review. Not changed here.

## Checks

- `npm run test:py`: 44 files passed, 0 skipped, 0 failed (Python 3.14.10, 199 s). `tests/hermes_send_lanes_test.py`: 12
  tests, 1 new, table-driven over idle, a send staging, a send inside Hermes's admission call, and a send staging with
  another waiting on its lane behind it. A send waits on its lane only behind another send, so the waiting case runs
  beside the one ahead of it; the two entries prove the waiting one is listed. Each case checks that `acquire` refuses
  exactly when `status` lists work, and that both report idle once the sends are answered and their turn ends.
- `npm run lint:py` with ruff 0.17.3: the first run flagged two loop variables a lambda in the new test closed over
  (B023); bound explicitly, then passed, and the send-lane tests and the red proof below were rerun on that code.
- `npm run lint` and `npm run typecheck`: passed.
- `npx vitest run tests/hermes-adapter.test.ts tests/hermes-qualification.test.ts tests/sent-echo.test.ts`: 3 files,
  251 tests passed.

## Red proof

The new test went red on `t3/send-lanes` without the fix, for its reason: `status` answered `busy: []` with a send
staging (`[] != [('sid-slow', 'slow', 'admitting')]`) and in Hermes's call, and `acquire` refused in each.

Each line was then broken with a scripted text replacement, the test run, and the source restored and checked:

| Broken | Red |
| --- | --- |
| `busy_sessions` lists sessions only, as before | `test_maintenance_status_lists_sends_that_hold_or_wait_for_a_lane_as_acquire_counts_them`, all three busy cases |
| A send never registered | the same three cases |
| A running send left `queued` | the same three cases |
| An answered send never removed | the same three cases, at the idle check after the answers |

Not run: real Hermes, the qualification run, `npm test`, iOS and production. The release tool itself was not run.

## Review round

`t3/send-lanes` at `19bca48`, its fifth review round, is merged in with a normal merge commit. Both branches changed the
same lines of `route` and the same capability-matrix paragraph; the merge keeps both changes: the one-shot `Reservation`
and the refused-schedule path from send-lanes, and this branch's listing. GPT-6.1 Sol reviewed `bcc4e17`: no P1.

- P2, `status` idle while `acquire` refuses. The send's reservation was taken and then its entry added, and on the way out
  the entry was removed and then the reservation released, so `status` between the two answered `active: false, busy: []`
  and the `acquire` after it answered 409. Now `route` lists the send and takes its reservation in one hold of the
  maintenance `RLock`, which `status` and `acquire` read under, and a refused reservation unlists it in that same hold.
  `Reservation.release` releases and then unlists in one hold of it. The lock covers only the listing and the native
  fence call, never staging or Hermes's admission call. The order alone already keeps a reservation from ever existing
  unlisted; the lock also keeps maintenance from seeing a listing whose reservation is not yet taken or already gone.
- P3, the refused-submission cleanup untested. The cleanup now lives in `Reservation.release`, the one place a send's
  reservation ends, and a new test makes the executor refuse the submission and checks zero reservations, an empty `busy`
  and a successful `acquire`.
- Recorded, not changed: the release tool's window. Between `.agents/tools/deploy-guarded-app-release.py`'s `status`
  check (line 71) and its `acquire` (line 89) it runs gateway readiness and state checks (lines 72-74), a native status
  call (line 75, 10-second timeout), Google verification (line 76; `deploy_common.py:114` allows 90 seconds), app
  readiness requests, two state writes and the app stop (line 82; service commands allow 120 seconds,
  `deploy_common.py:72`). A send can arrive anywhere in that window of minutes. This branch makes `status` truthful at the
  moment it answers; it does not make the release sequence safe against a send arriving after it. Acquiring before
  stopping the app is a separate change and the tool is unchanged here.

## Review round checks

Source fingerprint sha256:2407c764fdf881a573497b774855cae30323ff6ce5d3ca488e8b4ac227e28c95 (1697 source files); `src/hermes` alone sha256:6ee032a194cd9433af9a2f3085720f874304814c11aa74b1ac826d1285c2ae6d (20 source files). Same host and versions (Python 3.14.10).

- `npm run test:py`: 44 files passed, 0 skipped, 0 failed (195 s). `tests/hermes_send_lanes_test.py`: 16 tests, 2 new,
  and the maintenance test now also checks that a send refused at the fence is not listed.
- `ruff check .` with ruff 0.17.3, `npm run lint` and `npm run typecheck`: passed.
- `npx vitest run tests/hermes-adapter.test.ts tests/hermes-qualification.test.ts tests/sent-echo.test.ts`: 3 files,
  251 tests passed.
- `tests/hermes_send_lanes_test.py` 30 times in a row, each in a fresh process: 30 passed, 0 failed.

## Review round red proof

`test_maintenance_sees_a_send_listed_whenever_its_reservation_is_held` pauses the send at the native fence, just after its
reservation is taken and just before it is released after its answer, then has maintenance look. Maintenance looks at
once when nothing holds the lock it reads under, or else after the send resumes. Its first version, which checked only
that `status` and `acquire` agree, went red on the merged code before the fix, at both boundaries, for the reviewer's
reason: `([], False)`, `busy` empty and `acquire` refused. The final version also reads `busy_sessions()` at the pause and
goes red there on the same code: `[] != [('slow', 'queued')]` and `[] != [('slow', 'admitting')]`.

`test_a_send_the_executor_refuses_leaves_maintenance_free` went red on that pre-fix merge with the reviewer's mutant,
the registry cleanup removed from the enqueue-exception handler.

Each line was then broken with a scripted text replacement, the test run, and the source restored and checked. The script
runs tests without writing bytecode and deletes the source's `__pycache__` after restoring:

| Broken | Red |
| --- | --- |
| The send listed after the lock and its reservation | the boundary test, acquire case |
| The send unlisted before the lock and its release | the boundary test, release case |
| The release outside the maintenance lock | the boundary test, release case: maintenance saw the send listed mid-release |
| A send refused at the fence left listed | `test_maintenance_treats_queued_and_running_sends_as_active_work` |
| The refused-submission path releasing without unlisting | `test_a_send_the_executor_refuses_leaves_maintenance_free` |

Survives, equivalent: listing and reserving without the maintenance lock. Because the send is listed before its
reservation is taken, no moment exists in which `acquire` counts it and `status` does not list it, and a maintenance
request in between refuses for the listing, as `status` would. The lock there costs nothing, since `guarded_acquire`
already takes it, and is kept so both transitions read the same way.

Not run: real Hermes, the qualification run, `npm test`, iOS, production, and the release tool.

## Second review round

GPT-6.1 Sol re-reviewed `73adc02`: ready after fixes, no P1. It cleared the production code, both paused boundary probes,
the lock order and every mutation. One P2, in a test; the production code is unchanged in this round.

- P2, the boundary test raced its observer. In the acquire case `test_maintenance_sees_a_send_listed_whenever_its_reservation_is_held`
  started its observer, resumed the sender and required the observer to have seen the send `queued`, but once the sender
  left the maintenance lock the lane worker could start the send's job and mark it `admitting` before the observer got
  the lock. That order is valid, and the production invariant held in it. The reviewer saw 3 failures in 30 fresh
  processes; here, before the fix, the test alone failed 4 of 100 fresh processes (runs 3, 53, 69 and 88), each
  `[('slow', 'admitting')] != [('slow', 'queued')]`. A new helper, `hold_send_jobs`, makes each send-lane job wait on an
  Event at the send pool before it starts, as when every send worker is busy; the job is already queued in its lane, so
  the send stays `queued`. The acquire case sets that Event only after the observer has finished, and checks that it has,
  so maintenance sees the state the send paused in. The reservation and listing assertions are unchanged.

## Second review round checks

Source fingerprint sha256:2dd08b075bca0d038358a65ddfed65d77c6dfa5eb1d92eae398a70cea1abc74b (1697 source files); `src/hermes` alone sha256:6ee032a194cd9433af9a2f3085720f874304814c11aa74b1ac826d1285c2ae6d (20 source files), unchanged from the first round. Same host and versions (Python 3.14.10).

- `tests/hermes_send_lanes_test.py` 100 times, each in a fresh process with bytecode writing off (`python3 -B`,
  `PYTHONDONTWRITEBYTECODE=1`), on an otherwise idle loop: 100 passed, 0 failed (17 minutes). A first loop of 100 ran
  while mutant runs loaded the host: 98 passed. Both failures, runs 14 and 15, were
  `test_a_send_waiting_for_a_compaction_holds_up_no_other_assistant` from `t3/send-lanes`, whose `wait` timing
  threshold read 101.6 and 345.9 ms against 100; the boundary test passed in all 100.
- `npm run test:py`: 43 files passed, 1 failed (452 s, load average near 100 from other work on the host). The failure
  was `tests/system_terminal_test.py`, a known flake under load, timing out waiting for terminal output; alone it passed.
  `tests/hermes_send_lanes_test.py` passed: 16 tests.
- `ruff check .` with ruff 0.17.3, `npm run lint` and `npm run typecheck`: passed. `npm ci` ran once for both branches,
  whose lockfiles are identical.
- `npx vitest run tests/hermes-adapter.test.ts tests/hermes-qualification.test.ts tests/sent-echo.test.ts`: 3 files,
  251 tests passed.

## Second review round red proof

The boundary mutants were applied again with a scripted text replacement, the boundary test run without writing bytecode,
and the source restored, checked by hash, and every `__pycache__` deleted. Each is still red:

| Broken | Red |
| --- | --- |
| The send listed after the lock and its reservation | the acquire case: `[] != [('slow', 'queued')]` |
| The send unlisted before the lock and its release | the release case: `[] != [('slow', 'admitting')]` |
| The release outside the maintenance lock | the release case: maintenance saw `[('slow', 'admitting')]` mid-release |

Not run: real Hermes, the qualification run, `npm test`, iOS, production, and the release tool.
