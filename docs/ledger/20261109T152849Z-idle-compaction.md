# November 9 idle compaction of canonical Bot Chats

Branch `t3/idle-compaction` over `7a1f782`, on NicolasLaptop (Linux, Python 3.14.10). Production
`hermes-prod` was only read: source, config, `agent.log` and `state.db`. No RPC, restart or write.

## Production evidence (read-only)

- Hermes `ed1afb082eb3`; its tracked repair touches only `agent/credential_pool.py` and
  `hermes_cli/auth_xai.py`. `dashboard.turn_isolation` is unset (default off), so canonical sessions
  run in process. No `auxiliary.compression` route: compaction summarizes with `gpt-6.1-sol`.
- Five automatic compactions of `20260929_225146_7e599c` took 220 to 290 s each, all `post_tool` or
  `overflow` inside a turn, in place, leaving 25,600 to 41,857 tokens. Window 500K, threshold 375K.
- That session has 106 active rows, 16 of them compaction copies whose row ID differs from the
  message the app showed before. About 697K characters of messages, so prompt and tools are about 32K.
- The copy lookup (`original_rows`) took 16 to 17 ms on that session; a uid join took 1.8 s.

## Real Hermes (`ed1afb0`, disposable home, fixture provider)

`scripts/spike/compaction_probe.py` under a scratch launcher that reproduces `run.py`'s isolated
home, provider, guarded native gateway and add-on gateway, with a four-second delay. The full
`run.py` sequence was not run. Dependencies came from `ed1afb0`'s own `uv.lock`; the repository's
`requirements.lock.txt` (for `b9cb268`) does not resolve at `ed1afb0` (Pillow 13 against
browser-harness's Pillow 12.3). Receipt: `docs/evidence/hermes-compaction-probe-ed1afb0.json`.

- Passed: app message, steer-flagged message, another client's native `prompt.submit` and a routine
  delivery, each sent while the summary call was held open: admitted in about 0.08 s, answered in
  0.22 to 0.29 s, routine delivered in 2.3 s, on the uncompacted transcript. The compaction never
  committed. A released compaction committed in place; the app's IDs, roles and text were unchanged,
  the anchored read found its request, the next model request carried the summary, and no further
  compaction ran in 17 s. No compaction status frame reached the client (304 frames).
- Found while building it, now fixed: in-place compaction gave the kept head and tail new row IDs, so
  those rows lost their request IDs in the app; the first budget excluded Hermes's protected head and left a
  compaction above it (37,025 against 32,028); a cancelled compaction reports `compressed`.
- Disproved assumption: removing the add-on's clear of the stop request still answered the message.
  Hermes's turn runner clears a stop as each turn starts (`tui_gateway/prompt_turn.py:164`). The add-on
  now clears only when no turn runs, with the plain clear, so a turn Hermes drained cannot lose a steer.

Real-probe mutants, each red, then restored: stop request removed (message waited: "Hermes did not
settle"), watcher removed (native client waited), routine delivery not preempting, compaction shown
as running, progress frames passed through (first run green: the check started after the frames;
the check now covers the whole run and went red), copies keeping their own row IDs, and the steer
flag kept after preempt. That last one made real Hermes refuse the message: `status: rejected`.

## Unit and integration

- `tests/hermes_compaction_test.py`: 27 tests. `tests/hermes_automation_test.py`: 40 tests, 1 skipped.
- `python3 scripts/run-python-tests.py`: 41 files passed. `ruff check .`: passed.
- `npx vitest run tests/hermes-qualification.test.ts tests/app-probe-scope.test.ts`: 7 tests passed.
- 32 hand mutants, each red, then restored: stop removed, stop never cleared, stop cleared under a
  drained turn, stop before Hermes marks the compaction active, watcher ignoring native input, stop
  after finish, no preempt bound, result size recorded for a cancelled compaction, doubling guard,
  budget and idle boundaries, tail ceiling, busy, open request, interruption, compute host,
  already-compacted, own frames as activity, disabled setting recording activity, poll pruning,
  unreadable setting accepted, old Hermes supported, submit, delivery, maintenance and automation
  not preempting, steer flag kept, running shown, progress frames, discovery held, copies' row IDs,
  and copies resolved across sessions (survived once; the fixture now puts the foreign copy first).

Not run: the full `run.py` qualification, `npm test`, iOS, and production. Production's provider has
not run an idle compaction.
