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
