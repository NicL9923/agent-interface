# November 10 an admission answer that says when a new task's turn did not start

Branch `t3/admission-turn`, stacked on `t3/send-lanes` at `2e4437b` (over `origin/main` at `3bfd79d`) because
both edit the end of `Bridge.admit`. On NicolasLaptop (Linux x86_64, Python 3.14.10, Node 24.22.2). Source
fingerprint `sha256:53a994fef5d3cd88ae347d4060bcf5396348e301ebc54f9ca4caec8534e875ac` (1687 files); `src/hermes` alone `sha256:53df8a3c42c1651fdf967f5903d71933b98a70a904c13992cfee3c694f105409`. No Hermes process ran and the production
host was not touched.

## Why

The server times a send by its run ID (`src/server/send-timing.ts`). In one sequence it credits another turn's
text to the send: the send stops a background compaction, another client's turn takes the session first, and
the add-on admits the send as a new task. Nothing in the answer said so.

## Native behavior relied on, read from upstream `ed1afb082eb3`

Read in a scratch clone of `NousResearch/hermes-agent` at `ed1afb0`, the revision the recent add-on ledgers
cite. It is not necessarily the production revision.

- `prompt.submit` answers `{"status": "streaming"}` after it starts the turn
  (`tui_gateway/methods_prompt.py:973`).
- Over a running session it calls `_handle_busy_submit` (`methods_prompt.py:894-913`), which applies
  `display.busy_input_mode` (`tui_gateway/session_auto_continue.py:400-454`). The default is `interrupt`
  (`hermes_cli/config_defaults.py:815`), and AIAgent supports redirect (`agent/agent_init.py:451`). A
  text-only message is redirected into the running turn (`redirected`, or `steered` in steer mode), which
  "redirects the active turn without converting it into a new task" (`agent/interrupt_control.py:323-327`).
  Otherwise, or when that fails, it is queued as its own turn (`queued`); in `interrupt` mode Hermes then
  also interrupts the running turn.
- Native `session.steer` answers `queued` when it accepts the text into the running turn
  (`tui_gateway/methods_session_interrupt.py:171`), so a steer's answer cannot be read the same way.

## Decision: `turn`, two values

The add-on reads native's answer to a new task's `prompt.submit` and saves, with the admission answer,
`turn: "queued"` or `turn: "joined"`. Absent: Hermes started the turn, or answered anything else, or the
add-on steered. The brief asked for a queued flag; the source shows the same sequence usually ends `joined`
under the default busy mode, and the server is equally wrong about it, so both are named and kept apart.
`agent-interface.capabilities` reports `admission_turn: true`, so the server can trust a missing `turn` only
from an add-on that sets it. The field is additive; an older server ignores it. Node is unchanged on this
branch: the server change follows separately.

## Checks

- `npm run test:py`: 43 files passed, 0 skipped, 0 failed (Python 3.14.10). `AdmissionTurnTests` in `tests/hermes_extension_journal_test.py`, 3 tests,
  and one test in `tests/hermes_compaction_test.py`'s `BridgeTests`, all new.
- `npm run lint:py` with ruff 0.17.3 from `.github/requirements-ci.txt`: passed. A first run flagged the new
  compaction test's loop closures (B023); the loop body moved into a helper and the suite ran again.
- `npm run typecheck`: passed (node_modules from `npm ci` on `t3/open-attribution-lock`, same lockfile).
  `npx vitest run tests/hermes-adapter.test.ts tests/hermes-qualification.test.ts`: 2 files, 233 tests passed.

## Red proof

Each line was broken with a scripted text replacement, the test files run, and the source restored and checked.
Every one went red:

| Broken | Red |
| --- | --- |
| No `turn` reported | the new-task table (3 cases) and the preempt sequence (2 cases) |
| A steer's native answer read as a `turn` | `test_a_steer_carries_no_turn_though_hermes_answers_it_queued` |
| `turn` left out of the saved answer | the new-task table's replay checks |
| `steered`, `redirected` or `queued` missing from the map | the table, and the preempt sequence for the last two |
| The capability not reported | `test_the_add_on_says_it_reports_the_turn` |

Not run: real Hermes, the qualification run, `npm test`, iOS and production.
