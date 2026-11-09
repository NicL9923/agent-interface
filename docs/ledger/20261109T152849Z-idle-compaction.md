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
  delivery, each sent while the summary call was held open: admitted in under 0.1 s, answered within
  0.31 s, routine delivered in 5.2 s, on the uncompacted transcript. The compaction never
  committed. A released compaction committed in place; the app's IDs, roles and text were unchanged,
  the anchored read found its request, the next model request carried the summary, and no further
  compaction ran in 17 s. No compaction status frame reached the client (325 frames).
- Found while building it, now fixed: in-place compaction gave the kept head and tail new row IDs, so
  those rows lost their request IDs in the app; the first budget excluded Hermes's protected head and left a
  compaction above it (37,025 against 32,028); a cancelled compaction reports `compressed`.
- Disproved assumption: the first version stopped compaction with the agent's hard interrupt and
  cleared it afterward, to keep the next turn from starting stopped. Removing that clear still
  answered the message: Hermes's turn runner clears a stop as each turn starts
  (`tui_gateway/prompt_turn.py:164`). The review below replaced the hard interrupt altogether.

## Independent review: GPT-6.1 Sol, high effort, at `a8091c5`

1. High, valid: the active check and hard interrupt were not atomic with Hermes releasing the
   session, so a stop could land on a turn Hermes drained from its queue. Fixed: the add-on cancels
   the compaction's own `CompressionCommitFence` with `try_cancel_before_commit`, under the session's
   `history_lock`, which Hermes holds to end a compaction and admit a turn. No agent-wide stop exists.
2. High, valid: the hard interrupt waits for an in-flight commit, so the 30-second bound did not
   hold while `submission_lock` was taken. Fixed by the same change: the fence cancel never blocks.
3. Medium, valid: maintenance preempted under `maintenance_lock`, which Hermes's release of the
   session takes through the guarded retirement gate. Fixed: it preempts before taking the lock.

## Re-review: GPT-6.1 Sol, high effort, `a8091c5..733d1d3`

The three findings above were confirmed fixed. New:

1. High, valid: taking `history_lock` still blocked, so preempt could not check its deadline while
   Hermes held the lock to persist queued input. Fixed: a 50 ms timed acquire, retried by preempt.
2. Medium, valid: a cancel before the summary call starts leaves the transcript unchanged, and
   Hermes arms a 300 s no-progress backoff on its automatic compaction
   (`agent/conversation_compression.py`, `_record_structural_no_op`). Fixed: the add-on cancels only
   after the compressor's `_compression_working_attempt_generation` changes.
3. Medium: another client's manual compaction could win the session in the instant after the
   add-on's idle check, and a preempt then would cancel it. First documented as a residual; fixed
   in the next round.

## Third review: GPT-6.1 Sol, high effort, `733d1d3..14f48db`

Finding 1 above confirmed fixed, including reentrant acquisition. New:

1. Medium, valid: a stall fallback publishes a fresh fence before its own summary starts, and the
   primary's changed marker let a cancel reach it early, arming the 300 s backoff. Fixed: each new
   fence takes its own baseline, and the fence's `progress_observed()` also counts as started.
2. Medium, valid: a preempt holding a finished attempt could cancel a later compaction, the wider
   form of the earlier residual. Fixed for both: the add-on wraps Hermes's `_manual_compress_turn`
   to record the thread it holds the session for; a cancel needs that thread to be its own attempt's,
   and an attempt that is done never cancels.

Real Hermes at the final code: the probe passed with admissions at 0.08 to 0.09 s, answers within
0.31 s, routine delivery at 5.2 s. All four cancels logged `commit_fence_cancelled`; none logged
"no progress". A cancel now needs the wrapped seam's owner, so these passes also show the wrapper
takes effect in Hermes's `session.compress`.

Real-probe mutants, each red, then restored: cancel removed (message waited: "Hermes did not
settle"), watcher removed (another client's message waited), routine delivery not preempting,
compaction shown as running, progress frames passed through (first run green: the check started
after the frames; it now covers the whole run and went red), copies keeping their own row IDs, and
the steer flag kept after preempt. That last one made real Hermes refuse the message:
`status: rejected`. The first two ran against the fence version; the rest against the hard-interrupt
version, and none of their lines changed since.

## Unit and integration

- `tests/hermes_compaction_test.py`: 33 tests. `tests/hermes_automation_test.py`: 40 tests, 1 skipped.
- `python3 scripts/run-python-tests.py`: 41 files passed. `ruff check .`: passed.
- `npx vitest run tests/hermes-qualification.test.ts tests/app-probe-scope.test.ts`: 7 tests passed.
- 39 hand mutants, each red, then restored: cancel removed, a held fence counted as cancelled,
  ownership ignored, a stale attempt still cancelling, the seam never installed, its owner kept
  after release, cancel before the summary starts, a fallback fence keeping the primary baseline,
  fence progress ignored, cancel outside the session lock, the session lock taken without a bound,
  watcher ignoring
  native input, old Hermes or a fence without the non-blocking cancel supported, maintenance, submit,
  delivery and automation not preempting, no preempt bound, result size recorded for a cancelled
  compaction, doubling guard, budget and idle boundaries, tail ceiling, busy, open request,
  interruption, compute host, already-compacted, own frames as activity, disabled setting recording
  activity, poll pruning, unreadable setting accepted, steer flag kept, running shown, progress
  frames, discovery held, copies' row IDs, and copies resolved across sessions (survived once; the
  fixture now puts the foreign copy first). By hand: maintenance preempting under its lock (red:
  acquire took 2.02 s against the 1 s limit).

Not run: the full `run.py` qualification, `npm test`, iOS, and production. Production's provider has
not run an idle compaction.
