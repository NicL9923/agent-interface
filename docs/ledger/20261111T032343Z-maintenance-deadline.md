# November 10 a maintenance acquire writes no lease after its caller gave up, and a refused one stops no compaction

Branch `t3/maintenance-deadline` over `origin/main` at `f6e0090`, on NicolasLaptop (Fedora 44, Linux x64),
Python 3.14.10, Node 24.22.2, ruff 0.17.3. Source fingerprint
`sha256:f3cbeb89d56b8f51463429665872b4a1a5e370bf3dfeab1d7652db8fc1c04957` (1759 source files) with the change applied,
before this entry. No Hermes process ran, nothing was deployed and the production host was not touched. Hermes
behavior was read from the local upstream clone (`tui_gateway/rpc_dispatch.py`, `session_compression.py`,
`hermes_cli/backend_retirement.py`).

## Defect

`maintenance` ran `compaction.preempt` for every canonical session, up to 30 s each, before it took
`maintenance_lock` and before it checked anything (`src/hermes/extension.py:757` at `f6e0090`). Two consequences:

- A caller whose read timed out could not know whether a lease would still appear, which is why both release tools
  carry a five-minute late-lease watch and a manual runbook step.
- A request refused with 400 or 409 still cancelled every running compaction first.

## Change

- `maintenance` validates the action and operation first, then reads an optional `deadline` on `acquire`: a finite
  number of seconds greater than zero, else 400 "Invalid maintenance deadline". It is converted to an absolute
  time on the add-on's own clock (`Bridge.monotonic`) at arrival.
- `acquire_lease` looks under `maintenance_lock` first and refuses at once when the acquire would be refused anyway
  (another operation's lease, or active work). That look ignores what a background compaction contributes: its
  session's `running` flag when it is the only mark (`busy_sessions(ignoring_compaction=True)`), and one admission
  reservation per running compaction (`IdleCompaction.running()`). Hermes's `handle_request` takes one reservation for
  each native call, so a `session.compress` holds exactly one. A reading that is low only lets the acquire go on to the
  exact look below.
- Only an acquire that would otherwise succeed preempts, outside the lock, each wait bounded by the time left, and
  none starts once the deadline has passed. It answers the same busy refusal the release tools already read as a
  harmless refusal.
- Immediately before the write, under the lock: the exact look again (compactions count, another acquire may have won,
  an input may have come in), then `monotonic() >= deadline` refuses without writing.
- `agent-interface.capabilities` reports `maintenance_deadline: true`. An older add-on ignores the parameter, so a
  caller asks for the capability before it relies on the deadline. The release tools are unchanged.
- `docs/HermesCapabilityMatrix.md` and `docs/HermesUpgradeLinux.md` describe the order and the parameter.

## Tests

`tests/hermes_compaction_test.py` `MaintenanceDeadlineTests` (11) and
`tests/hermes_extension_journal_test.py` (capability). They run the real add-on with a fake Hermes at its edges and a
real compaction thread held by a fake commit fence.

- A refused acquire stops no compaction, for another operation's lease, work beside the compaction, a turn on another
  session, a queued reservation, a send waiting for its lane, a malformed operation and seven malformed deadlines,
  each with its own reason, the compaction still running and no lease written.
- A compaction's own hold is no work: the acquire cancels it and writes the lease.
- Without a deadline the acquire waits the preempt bound and writes nothing while the session stays busy.
- A deadline that passes during the preempts ends the wait at the deadline, not the 5 s bound, and writes no lease,
  also after the compaction later ends.
- A deadline that passed before the first preempt, and one spent waiting for `maintenance_lock`, stop no compaction.
- The lease is written at 109.9 (deadline 110) and not at 110.0 or 111.0, on a pinned clock.
- Work that arrives during the preempts refuses the acquire; status and release are answered during the preempts, not
  after them; two acquires at once leave one lease for one operation and the other gets "owns this lease".
- Repeating an acquire for its own lease is idempotent.

## Red proof

A scratch runner applied each replacement, deleted every `__pycache__`, ran the test file with `python3 -B` and
`PYTHONDONTWRITEBYTECODE=1`, and restored it. A first pass left three breaks green, which showed a shared-state bug in
my table test and two missing cases; the tests were fixed and those breaks rerun. Every break below went red.

| Broken | Red |
| --- | --- |
| First look skips the other-operation check | refused-acquire test |
| Final look skips the other-operation check | two-acquires test |
| First look counts a compaction's running flag as work | own-hold, preempt-bound, status/release, boundary, two-acquires tests and the existing compaction test |
| First look ignores any session a compaction owns | refused-acquire test |
| First look ignores every `running` mark | refused-acquire test |
| First look counts a compaction's reservation | own-hold and three more |
| First look allows queued reservations | refused-acquire test |
| First look skips the busy check | refused-acquire and work-arrives tests |
| Final look skipped | preempt-bound, two-acquires, work-arrives tests |
| Preempts run without regard to the deadline | passed-before-first-preempt test |
| Preempt waits the full bound | deadline-passes-during-preempts test |
| No deadline check before the write | boundary test |
| Deadline boundary excluded (`>`) | boundary test |
| Deadline counted from after the first look | lock-wait test |
| Preempts run under `maintenance_lock` | status/release test and the existing compaction test |
| Zero or negative, infinite, boolean, string deadline accepted (4 breaks) | refused-acquire test |
| Capability not advertised | capability test |

One break, measuring the deadline from after validation instead of arrival, is equivalent and was dropped.

## Checks

On the final code state: `npm run test:py` 44 files passed; `ruff check .` clean (0.17.3); `npm run typecheck`,
`npm run lint` clean; `npm test` 202 files, 3533 tests passed; `npm run build` passed.

Not exercised: a real Hermes, a real compaction, the release tools against this add-on, and production. The deadline
is not sent by any caller yet.
