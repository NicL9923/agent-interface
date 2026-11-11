# November 11 both release tools send the maintenance deadline, so an unanswered acquire can be a finished refusal

Branch `t3/tools-send-deadline` over `origin/main` at `57e8742`, merged with `origin/main` at `589f542`, on NicolasLaptop (Fedora 44,
Linux x64, 32 cores), Python 3.14.10, Node 24.22.2, ruff 0.17.3. Source fingerprint
`sha256:98a64ef6b929734e8ff8a2318058b82972a5128c9fbc91d452e47bdf3a0c3aad` (1769 source files) with the merged change set, before
this entry. No Hermes process ran, nothing was deployed and the production host was not touched. Line numbers are this branch's.

## Defect

#343 made the add-on's maintenance `acquire` accept a `deadline` and report `maintenance_deadline: true` in
`agent-interface.capabilities`, but no caller sent one. So a caller whose read timed out still could not tell whether a lease would
appear. The worker's `quiescence` watched `LATE_LEASE_SECONDS` (300) for a lease and then exited 76, held for review; the guarded
tool released once and exited 2 with the blocked status kept. Both needed an operator, and the runbook's "Unanswered maintenance
acquire" ends in writing a lease by hand.

## Change

- `scripts/hermes-upgrade-linux.py` `NATIVE` (`:94-150`): method `capabilities` asks `agent-interface.capabilities`, which takes no
  credentials. A `deadline` in the payload goes into the acquire's params. After any failure that follows the send, unless the
  add-on answered an error, and only when `wait` is longer than `deadline`, `NATIVE` sleeps out the rest of `wait` since the send
  and prints `{"deadlinePassed": true}` as the last stdout line before it fails as before.
- `Platform.rpc(method, deadline=None)` (`:365`) refuses a deadline that is not shorter than its wait with `ValueError`, sends it,
  and raises the new `DeadlinePassed` for exactly that last line. `acquire_deadline` (`:657`) returns `ACQUIRE_DEADLINE` when the
  capabilities read gives `maintenance_deadline` exactly `true`, and `None` for anything else, including a read that fails
  (`Answered`, `NotSent`, `Unanswered` or bad JSON). `quiescence` reads it before it saves phase `acquiring` (`:610`), sends it with
  the acquire, and sends `DeadlinePassed` through the existing release path to exit 75 (`:627`), with no late-lease watch.
- `.agents/tools/deploy_common.py`: the same constants (`:69-70`), `DeadlinePassed` (`:83`), `maintenance_rpc` (`:123`) with the same
  guard and marker, and `acquire_deadline(rpc)` (`:207`). `acquire_then_stop_app` reads it after it writes the blocked status and
  before it journals `maintenance-acquiring` (`:239`), sends it with each of the three attempts, and refuses through `refuse` on
  `DeadlinePassed` (`:255`) without asking again. `deploy-guarded-app-release.py:55` passes it into the request.
- Without the capability nothing changes: the acquire carries no deadline, no marker can come back, and the worker keeps the
  five-minute watch and exit 76, the tool its exit 2.
- `docs/HermesUpgradeLinux.md`, `docs/HermesCapabilityMatrix.md`, `.agents/tools/README.md`. The runbook's manual lease steps now say
  they apply only to an acquire sent without a deadline.
- A drive-by in code already touched: `unsent()` compared the last line with `==`, and `{"unsent": 1} == {"unsent": True}` in Python.
  `marker()` now checks `is True` for both markers, as `deploy_common.py` already did.

## The margin

The deadline is 90 s on a 120 s wait, a margin of 30 s (`DEADLINE_MARGIN`, in both files).

- The wait is the existing `MAINTENANCE_WAIT["acquire"]`, sized for three full 30 s preempts. 90 s is those three, so a normal
  chain of compactions still finishes inside the deadline, and a longer one now ends in a refusal instead of a held review.
- The deadline starts when the handler starts, so no answer for the whole wait proves no lease only if the handler started less than
  the margin after the send. The add-on bounds its own overrun past the deadline to one 50 ms lock attempt and a 20 ms poll
  (`compaction.py` `LOCK_SECONDS`, `preempt`), and the final look and write are under a lock other callers hold briefly. What it
  does not bound is the handler starting late: Hermes dispatches a non-long method with `asyncio.to_thread`, on a thread pool shared
  with other work (`tui_gateway/ws.py` `_dispatch_request`, read at `ed1afb0`), so a request can wait for a free thread. 30 s is the
  longest single bounded step the add-on has (`PREEMPT_WAIT`) and over 400 times its own overrun.
- Residual risk, stated: nothing proves the dispatch wait is under 30 s. The release that follows goes through the same dispatch and
  fails closed when unanswered, which catches a starved pool but not every case.
- A test pins both files to 120, 30 and 90 and requires the margin to be at least `PREEMPT_WAIT`, so a change to either number
  has to be deliberate.

`NATIVE` waits out the rest of `wait` after a failure that follows the send, so a socket that drops at 2 s still gets the proof: the
handler keeps running after the socket closes and can write a lease until its deadline, so the proof is the time since the send, not
the kind of failure. A failure before the send is still `NotSent`; the child's own timeout (`wait` plus overhead) is still
`Unanswered`.

## Tests

The fakes stand at the I/O edge only: the WebSocket client module in the fake Hermes source (with a clock that moves only when the
fake socket blocks or `NATIVE` sleeps, so a 120 s wait costs nothing), the ticket server, `systemctl`, and the managed Python the
guarded tool runs. The code under test runs for real, and a fake throws on any request a test did not script.

`tests/hermes_upgrade_linux_test.py` `MaintenanceRpcTests` (10 new), the real `rpc` and `NATIVE`:
- a capable add-on is asked first and sent 90 s with the acquire and none with the release; the capability read comes before the
  `acquiring` phase is saved;
- an acquire that never answers exits 75, phase `rejected`, in under 5 s with no watch, and a socket that drops after 2 s waits out
  the other 118 s first;
- a release that is unanswered after that fails closed; another error answer is still held without a release;
- no deadline for an older add-on, `false`, a string, the number one, an unrelated key or an empty object, each keeping the watch and
  exit 76; a capability read that fails by an error answer, silence or a refused ticket does the same;
- a deadline not shorter than its wait is refused before anything runs, for four method and deadline pairs;
- the marker is exact: five malformed last lines and a marker with later output are not it, and the exact marker from a request that
  sent no deadline is not either.

`tests/deploy_common_test.py` (61 tests from 42): `MaintenanceRpcTests` runs `NATIVE` for the same cases through `maintenance_rpc`,
including `NATIVE`'s own refusal to claim a deadline that leaves no room; `AcquireThenStopTests` covers a capable add-on asked first
and sent 90 s on each attempt, six capability answers that are not exactly `true`, five reads that fail, a bug in the tool that is
not swallowed, a deadline passing that refuses once released and is not retried, one whose release cannot prove it held for review,
a capable add-on's other failure still held, and an older add-on's lost answer still held. A wiring test compares both files' constants.
`tests/deploy_guarded_release_test.py` (15 tests from 11) runs the real tool: capable and sent 90 s, a deadline passing exits 75 with
nothing stopped, a plain failure still exits 2, a failed read sends none.

## Red proof

A scratch runner applied each replacement, deleted every `__pycache__`, ran the named test files with `python3 -B` and
`PYTHONDONTWRITEBYTECODE=1`, and restored the file. All 28 went red; the restored tree then passed. The exact-marker test also failed on
the real code before any break was made: JSON `1` equals `True` in Python, which `unsent()` had always accepted, so `marker()` now
checks `is True`, and a `{"unsent": 1}` case joined the existing unsent test.

| Broken | Red |
| --- | --- |
| `marker` accepts an equal value | the unsent and deadline-marker tests |
| `NATIVE` does not wait out the rest of the wait | the dropped-socket, silence and finished-refusal tests |
| `NATIVE` prints the marker after an answered error | the answered-error tests, in both files |
| `NATIVE` skips its own `wait > deadline` guard | the no-room test |
| `NATIVE` never sends the deadline | the capable and deadline-on-acquire tests |
| `NATIVE` sends `capabilities` as a maintenance action | the capability and capable tests |
| Worker `rpc` has no deadline guard | the not-shorter-than-the-wait test |
| Worker `rpc` never raises `DeadlinePassed` | the finished-refusal, release and other-error tests |
| Worker `rpc` raises it without a deadline | the exact-marker test |
| Worker takes any truthy capability | the not-exactly-true test |
| Worker lets a failed capability read raise | the failed-read tests |
| Worker never sends the deadline to the acquire | the capable tests |
| Worker reads capabilities after saving the phase | the read-before-phase test |
| Worker has no `DeadlinePassed` refusal | the finished-refusal and release tests |
| Deadline margin 10 s, in the worker file | the constants test |
| Tool: marker accepts any key set | the exact-marker test |
| Tool: marker accepts an equal value | the exact-marker test |
| Tool: raises `DeadlinePassed` without a deadline | the exact-marker test |
| Tool: no deadline guard | the not-shorter-than-the-wait test |
| Tool takes any truthy capability | the not-exactly-true test and a guarded-tool test |
| Tool lets any failed read raise | the failed-read tests |
| Tool swallows every failure of the read (`except Exception`) | the not-swallowed test |
| Tool reads capabilities after journaling the phase | the capable-order test |
| Tool never sends the deadline to the acquire | the capable tests, in both files |
| Tool has no `DeadlinePassed` refusal | the refusal and release tests |
| Tool asks again after the deadline passes | the refusal test and the app's-own-poll test |
| Deadline margin 10 s, in the tool file | the constants test |
| The guarded tool's `rpc` drops the deadline | the capable and refusal tests |

## Checks

`.agents/tools/check-all --py always --keep-going` on the merged branch (`73853a1`, before this entry): all 7 passed in 14m19s, 7m29s of it
queued for the machine's heavy slot behind another session.

| Check | Result |
| --- | --- |
| typecheck, lint, `ruff check .` (0.17.3) | passed |
| `npm test` | 205 files, 3,668 tests passed |
| `npm run build` | 892 modules |
| `npm run test:e2e` | 40 tests passed (ports 24566, 24567) |
| `npm run test:py` | 46 files passed in 5m12s |

Per file, on the branch before the merge: `deploy_common_test` 61 tests (42 before), `hermes_upgrade_linux_test` 75 (65),
`deploy_guarded_release_test` 15 (11), all passing.

## Not exercised

No real Hermes, no real add-on, no release tool run on a host, and no measured acquire. `NATIVE` ran against a fake WebSocket
client module and a local ticket server, with a fake clock for the waits. The add-on's side (that it writes no lease after its
deadline, and refuses at once when it would be refused) is #343's tests, not repeated here. That a real `websockets` client raises
`TimeoutError` from `recv(timeout=...)` was read in the installed package (`websockets/sync/connection.py`), not run against Hermes.
The dispatch-start margin is an argument from Hermes's source, not a measurement.

## Qualification and operator notes

`scripts/hermes-upgrade-linux.py` is on `src/shared/qualification-inputs.json` and is also the upgrade helper the release pins as
`fixedHelperSha256`. No other changed file is on the list (`deploy_common.py`, `deploy-guarded-app-release.py`, the docs and the
tests are not). At the next release the operator passes both:
`release-app.py prepare COMMIT ... --qualification RECEIPT` (receipt from `qualify-app-release.py NAME`) and `--accept-helper-change`.

The first release after this one still meets an add-on without the capability. `activate` runs the guarded tool from the release
being activated, and that tool asks the add-on that is running then, which is the previous release's. If that add-on predates #343
it answers no `maintenance_deadline`, so the acquire is sent no deadline and the held path and the runbook apply as before. The
release after it, and the in-app Hermes update worker once the release carrying #343 is live, ask a capable add-on and send one.
Independent review is owed: the implementer is Claude Sonnet 5.5, so a reviewer from another provider (GPT-6.1 Sol or Grok) has to
read the diff since `57e8742`.

## Review round 1: a late handler, a restart, and the overhead

Claude Opus 5.5 reviewed `a66f87c` and approved it after one P2 and two P3s. The commit after it is `ca41982`, on the same
machine and runtimes, with `origin/main` still at `589f542` (the merge of it was already in, so no new merge commit).

### Defects fixed

- **P2, a handler that starts late.** The add-on counts a deadline from when its handler starts, and Hermes dispatches each
  request with `asyncio.to_thread(server.dispatch)` (`tui_gateway/ws.py:387` in `/home/nic/scratch/wildbots-review/hermes-agent`,
  revision `ed1afb0`), the loop's default executor, shared by every connection with no limit on the queue. A handler that
  started more than 30 s late could write its lease after the tool said the deadline passed and a release found none. The tools now
  watch `ACQUIRE_DEADLINE` plus 10 s (`DEADLINE_WATCH_SECONDS`, 100 s) after a confirmed release, release again and confirm if
  this operation's lease shows, and only then exit 75. `deploy_common.py:84-85,245,334`; `hermes-upgrade-linux.py:185-186,670-673,711`.
  The comment at both constants states what the proof rests on. I read the dispatch before relying on the reviewer's reasoning:
  `_dispatch_request` hands the request to `to_thread`, `agent-interface.maintenance` is not in `_LONG_HANDLERS` (the separate
  `tui-rpc` pool), and the executor's queue is first in, first out. The acquire was sent on its own socket at least 120 s before the
  release, so it was queued first; its handler started no later than the release's, and wrote its lease no later than 90 s plus the
  add-on's own overrun after the release's handler began. The remaining slack is the add-on's `maintenance_lock`, which is not FIFO
  but is held only for a file read or write, never across a preempt; the 10 s grace covers it. Not measured against a running Hermes.
- **P3, a restart between the capability read and the acquire.** `acquire_deadline` now returns the add-on's `executor_epoch` with
  the deadline, and none for an add-on that reports no epoch. After `DeadlinePassed` the capabilities are read again; a different
  epoch or a failed read is held for review as before (the tool releases once without proof and fences; the worker watches five
  minutes and exits 76). `deploy_common.py:224,236,298`; `hermes-upgrade-linux.py:680,692,701,651`.
- **P3, `MAINTENANCE_OVERHEAD`.** 25 became 30 in `deploy_common.py:88`, the worker's figure, which counts the interpreter start.

The worker journals `acquire_unanswered` for the watch (`:667`), so a worker that dies in it leaves the phase the app's Cancel
recovers from; it returns to `rejected` after the second release. The guarded tool keeps the blocked status until the watch ends.
`docs/HermesUpgradeLinux.md` gains the dispatch-order reasoning and "A lease that appears after exit `75`", the recovery for exit 75
followed by "Hermes is being upgraded" in the app, which the runbook's "no manual lease step" had left without one.

### Break-by-hand runs

Each line was broken in the file, its tests run with `python3 -B` (`PYTHONDONTWRITEBYTECODE=1`, `__pycache__` cleared), watched go
red, and restored. `tests/hermes_upgrade_linux_test.py` `MaintenanceRpcTests` and `tests/deploy_common_test.py`.

| Broken line | Result | Red tests |
| --- | --- | --- |
| Worker: no watch after the release | red, 5 | late lease released again, phase held for review during the watch, another operation's lease left alone, second release fails closed (2) |
| Worker: no second release | red, 3 | late lease released again, second release fails closed (2) |
| Worker: epoch never compared | red, 3 | restarted add-on held for review, with and without a lease |
| Worker: epoch not required | red, 3 | no epoch, empty epoch, numeric epoch each get no deadline |
| Worker: phase not saved before the watch | red, 2 | phase holds while the watch runs, second release fails closed |
| Worker: second release unchecked | red, 1 | second release reporting the lease still held fails closed |
| Worker: `DEADLINE_WATCH_GRACE` 0 | red, 1 | both tools' deadline constants test |
| Tool: no watch | red, 7 | late lease released again, second release cannot clear (4 subtests) and more |
| Tool: no second release | red, 1 | late lease released again |
| Tool: epoch never compared | red, 4 | restart held for review (4 subtests, `Refused` instead of `Fence`) |
| Tool: epoch not required | red, 3 | no epoch, empty epoch, numeric epoch |
| Tool: `MAINTENANCE_OVERHEAD` 25 | red, 1 | both tools' deadline constants test |
| Tool: `DEADLINE_WATCH_GRACE` 0 | red, 1 | both tools' deadline constants test |
| Tool: status restored before the watch | red, 20 | status stays blocked until the watch ends, and the late-lease tests |

`tests/deploy_guarded_release_test.py` took the epoch in its fixture and gained one test of the real tool with a restarted add-on.
`check-all` found its two stale tests (capabilities without an epoch) on the first run; fixed, not skipped.

### Checks

`.agents/tools/check-all --py always --keep-going` on `ca41982`: all 7 passed in 10m27s, 3m37s of it queued behind another session.

| Check | Result |
| --- | --- |
| typecheck, lint, `ruff check .` (0.17.3) | passed |
| `npm test` | 205 files, 3,668 tests passed |
| `npm run build` | 892 modules |
| `npm run test:e2e` | 40 tests passed (ports 24302, 24303) |
| `npm run test:py` | 46 files passed in 5m17s |

Per file: `deploy_common_test` 65 tests (61 before this round), `hermes_upgrade_linux_test` 81 (75), `deploy_guarded_release_test` 16 (15).

### Not exercised

No real Hermes or add-on and no deployed release tool. The FIFO order is read from source, not measured; the 100 s watch costs
that long on every exit 75 that follows a deadline. Review of this commit is owed from a provider other than Claude: the implementer
is Claude Sonnet 5.5 and the previous head was reviewed by Claude Opus 5.5, so it is `independent-review-owed`.

## Review round 2: the ordering claim, a foreign lease in the watch, and the grace

Claude Opus 5.5 re-reviewed `9859f80` and found it ready with three P3s. This round merges `origin/main` at `5051253` as its own commit
(`03e2c99`, clean) and fixes them in `cfbf61e`. Same machine and runtimes as round 1 (Python 3.14.10, Node 24.22.2).
`.agents/tools/mutate-py.py` is not on `main`, so the breaks below ran from a scratch runner with `python3 -B`,
`PYTHONDONTWRITEBYTECODE=1` and every `__pycache__` cleared before each run.

### Defects fixed

- **P3, the ordering guarantee was stated too strongly.** The comments said a request goes to `to_thread(server.dispatch)` on arrival
  and concluded the acquire "started no later than the release's". In `/home/nic/scratch/wildbots-review/hermes-agent` at `ed1afb0`
  each connection makes earlier trips through the same default executor before its frame is read:
  `to_thread(start_deferred_mcp_discovery_now)` (`hermes_cli/web_routers/chat_ws.py:659`) and `to_thread(server.resolve_skin)`
  (`tui_gateway/ws.py:639`); behind the session authority a request goes through `AuthorityConnection.dispatch`, which under profile
  multiplexing first sends the owner scope's reads to the executor (`gateway/session_authorities.py` `async_owner_scope`, `:316`) and then
  `to_thread(dispatch_legacy)` (`tui_gateway/ws.py:396`). Each trip is first in, first out and a chain of them is not, so a release can
  overtake the acquire if the pool is blocked over 120 s and then again over 10 s at the wrong moment. The 10 s grace covers it in
  practice and is not a proof. The comments (`deploy_common.py:76-94`, `hermes-upgrade-linux.py:172-190`) and the runbook (the quiescence
  hook's dispatch paragraph and "A lease that appears after exit `75`") now say what the watch rests on, what remains, and that the
  runbook's recovery can be needed on today's Hermes, not only after a Hermes change.
- **P3, exit 75 for a lease that was not ours.** `late_lease` returned `False` for "nothing appeared" and "something not ours appeared",
  and the deadline branch then saved `rejected` and exited 75, which the app shows as Hermes open. The deadline branch now takes
  `elif os.path.lexists(maintenanceFile)` (`hermes-upgrade-linux.py:680`): it prints "Quiescence held for review, a maintenance lease that
  is not this operation's appeared", leaves the file and the `acquire_unanswered` phase as they are, and exits 76. A lease that appears
  between the watch's last look and this one is held too, which is the safe side. The runbook's exit table has the new row. The guarded
  tool already held this case: its second release answers 409 and the run is held for review (tested, `deploy_common_test.py`).
- **P3, nothing tested the guarded tool's grace.** Both tools' tests now assert the watch's sleeps total at least
  `deploy_common.DEADLINE_WATCH_SECONDS` (`deploy_common_test.py:556`, `deploy_guarded_release_test.py:380`), not `ACQUIRE_DEADLINE` or 90.
  A new test writes the lease during the watch's last sleep and requires the second release (`deploy_common_test.py:586`).

### Tests

- `hermes_upgrade_linux_test.py:1360`, replacing `test_another_operations_lease_in_the_watch_is_left_alone_and_is_not_released`:
  two subtests, another operation's lease and one that is not JSON. Each expects exit 76, the log line, one release only, phase
  `acquire_unanswered`, the file's bytes unchanged and no drain request. The fake late writer takes an optional raw body for it.
- `deploy_common_test.py:586` the last-second lease, and the strengthened sum at `:556`; `deploy_guarded_release_test.py:380` the same sum.

### Red proof

| Broken | Result | Red tests |
| --- | --- | --- |
| Tool: `range(DEADLINE_WATCH_SECONDS)` becomes `range(ACQUIRE_DEADLINE)` | red, 2 in `deploy_common_test`, 1 in `deploy_guarded_release_test` | the last-second lease, the watch after the release sees no lease, the guarded tool's refusal |
| Tool: the last look after the loop returns `False` | red, 1 | the last-second lease |
| Worker: `elif os.path.lexists(...)` becomes `elif False` | red, 2 subtests | a lease that is not this operation's, and one that cannot be read |

Each file was restored after its run; the tree then passed. Before the sums were strengthened, the first break stayed green, as the review said.

### Checks

`.agents/tools/check-all --py always --keep-going` on `cfbf61e`: all 7 passed in 7m56s, 53 s of it queued for heavy slots.

| Check | Result |
| --- | --- |
| typecheck, lint, `ruff check .` | passed |
| `npm test` | 208 files, 3,742 tests passed |
| `npm run build` | 894 modules |
| `npm run test:e2e` | 55 tests passed |
| `npm run test:py` | 46 files passed in 4m43s |

### Follow-up, not done here

The stronger fix the reviewer proposed: the add-on remembers each operation it released, under `maintenance_lock`, and refuses a later
acquire for it, advertised with a new capability. That makes the watch, the grace and the recovery section unnecessary, and it closes
the gap above instead of bounding it. It changes the add-on and the capability matrix, so it is its own change.

### Not exercised

No real Hermes or add-on. The chain of trips is read from source at `ed1afb0`, not measured. Review of `cfbf61e` is owed from a provider
other than Claude: the implementer is Claude Sonnet 5.5 and both reviews so far were Claude Opus 5.5, so it stays `independent-review-owed`.
