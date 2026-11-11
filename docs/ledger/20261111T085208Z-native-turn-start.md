# November 11 the add-on marks where a native turn starts

Branch `t3/native-turn-start` over `origin/main` at `7d794ef`, on NicolasLaptop (Fedora 44, Linux x64), Python 3.14.10,
Node 24.22.2, ruff 0.17.3. Source fingerprint `sha256:2d0942816970cf603f6ce68808c91eeb6811dc95c4713f00e23ec75838d2cdf9`
(1777 source files) with the change applied, before this entry. Hermes behavior was read from the local upstream clone at
`ed1afb0` (`tui_gateway/session_history.py:397-410`, `session_auto_continue.py:528-557`, `session_registry.py:803-829`,
`server.py:1413-1416`); no Hermes process ran, nothing was deployed and the production host was not touched.

## Defect

The web client's turn stream places a native turn by matching words (`turnStart` in `src/server/hermes-mapping.ts`),
which left the two gaps `20261110T060000Z-turn-stream.md` names under "Known gaps" (lines 560 to 572), and the unmatched
forms it lists as "Not handled" (lines 355 to 364):

- Guidance steered into the running turn and worded exactly like its prompt was taken as the turn's start, so a segment
  saved before it showed again in the live reply.
- A native turn whose prompt is not shown yet, and repeats a trailing prompt other than the last, lost the first saved
  words of that earlier turn from its live reply. For a hidden prompt worded like a person's prompt it lasted the turn.
- A prompt Hermes reports in other words than the add-on saved (bracketed-paste markers, another client's image lines)
  found no row and fell back to the last prompt, with the same loss when it was not saved yet.

Upstream keeps `started_at` on the session's turn (`_start_inflight_turn`, `session_history.py:401-410`) but its `inflight`
snapshot leaves it out (`_inflight_snapshot`, `session_auto_continue.py:528-557`). It reports the same time as
`turn_started_at` at the top of a session read and in `info` (`session_registry.py:804`, `server.py:1506-1516`), which the
server does not read. The add-on has the session's turn itself, so it puts the time beside the prompt it belongs to, on the
in-flight read, after checking both describe the same turn.

## Change

- `src/hermes/extension.py` `Bridge.mark_turn_start`, called by `describe_task`: stamps `inflight.started_at` (epoch
  seconds) from the session's `inflight_turn`. Only for a finite positive number, and only while the session's turn is still
  the one the snapshot describes (same prompt, the snapshot's reply a prefix of the turn's), since another turn may have
  started between the snapshot and the stamp.
- `src/server/hermes-mapping.ts`: `nativeStartedAt` reads the field as whole milliseconds, truncated as a row's
  `createdAt` is. `turnStart` takes it and returns the first trailing message at or after it, `messages.length` when the
  turn saved nothing yet, and falls back to the words when it is absent (an older add-on), unusable, or a message between
  the end and the start has no time. `promptSaved` decides the same way whether the turn's prompt is a shown row, so a
  hidden prompt's live reply carries its own origin. `turnRows` and `inflightMessage` pass the start.
- `src/server/hermes.ts`: the snapshot keeps `started_at` for the live reply and looks for the start among the saved
  rows, never the live reply, which has no time.
- `docs/native-api.md`: the rule and the fallback, and the gaps now only for an older add-on.

Walked: web `?inflight=1`, `=2`, `=3` and the conversation read (all tested); the iOS app takes the same server reads
and no client code changed; `src/server/hermes.ts` is the only reader of the add-on's `inflight`; the field is absent for
an older add-on and the server needs no capability flag for it. Reverse state: a turn that ends clears `inflight`, so
there is no start to carry past it.

## Follow-up: a queued prompt's row is saved before its turn starts

An Opus review (verified against upstream `ed1afb0`) found the start wrong for a prompt Hermes queued. `_drain_queued_prompt`
writes the prompt's row at the end of the transcript first (`session_auto_continue.py:493`, `_replace_queued_user_row_for_turn`
-> `_persist_submit_user_row` -> `stamp_message_timestamp`), and only then calls `_run_prompt_submit`, whose
`_admit_prompt_turn` starts the turn (`prompt_turn.py:157`, `_start_inflight_turn`, `started_at = time.time()`). The queued
prompt's own row is always earlier than `started_at`. An ordinary `prompt.submit` starts the turn first
(`methods_prompt.py:811`) and writes the row after (`:956`), so it was right. With rows `uA, aA, uB, aB1` and the start
between `uB` and `aB1`, `turnStart` was 3 and `promptSaved` false where the words gave 2 and true, `turnRows` dropped the
prompt, and a retained failed turn (`running: false`, no app run) showed its saved segment twice in the live text.

My test fake had the order wrong (it reported the start just after the last stamp, before the queued row), and the "Not done"
note that the TUI gateway never stamps a user row before the start was wrong for the drain path.

Fix chosen: the add-on. `Bridge.note_submit_row_time`, in the `_run_prompt_submit` wrapper that already runs before
`_admit_prompt_turn`, reads the session's staged `_submit_user_row` (a dict with `content`, `timestamp`, `_row_id`;
`_write_submit_user_row`, `session_workdir.py:753-790`) when its `content` is the turn's text and its `timestamp` is a finite
positive number, and keeps `{user, at}` as `session["app_turn_row"]`. It is set on every call, to nothing when there is no
such row, so a turn never carries the last one's. `mark_turn_start` reports the earlier of that time and `started_at`, only
when the row's prompt is the turn's own (`inflight_turn.user`). Hermes pops the staged row in `_adopt_submit_user_row`
after admission, so it has to be read in the wrapper.

Why not a server-side rule alone ("when the row before the first row at or after the start is a user row matching the
inflight prompt, start there"): it puts the turn's start back on words, which is the defect class this branch removes. It
misreads a turn whose earlier row happens to be an unanswered user row with the same words, and for an image prompt or a
bracketed-paste prompt, where Hermes reports other words than it saved, it finds no row and drops the prompt again. The
add-on has the exact time of the row Hermes staged for this turn, so nothing is guessed. The server keeps its time-only rule
and needs no change; an older add-on still falls back to the words.

Walked: the drain, which is the only path that saves the row before the start; ordinary `prompt.submit`, whose row is later
than the start, so `min` keeps Hermes's start (tested); a turn with no staged row, another prompt's staged row, a staged row
with no usable time, the turn before's row (all tested); a goal continuation after a queued prompt, whose prompt differs from
the row's (tested); the compute-host dispatch (`_submit_prompt_to_compute_host`), which does not pass through
`_run_prompt_submit`, so it records nothing and keeps Hermes's start, as before.

## Tests

- `tests/hermes_native_turn_start_test.py` (12, the 7 new ones in `QueuedPromptStartTests`: a queued prompt's row before the start;
  an ordinary prompt's row after it; no staged row; a staged row of another prompt, not a row, with no time, a string, a boolean,
  zero and not a number; the row of the turn before; a continuation after a queued prompt; the row read as the turn runs it, whatever
  its spacing) and the original 5: the stamp and nothing else on the snapshot; a grown turn; a snapshot of
  another turn (three forms); no usable start (missing, none, string, boolean, zero, negative, nan, inf); no snapshot or no
  turn.
- `tests/live-turn-runtime.test.ts` (new `describe`, 14): bad `started_at` values fall back to the words; both sides of the
  boundary at a millisecond; nothing saved yet; the start over the words; whole milliseconds; the window's earlier context;
  an untimed message; `promptSaved`; `turnRows`.
- `tests/live-turn-stream.test.ts` (10 cases, 3 of them new for the queued order, each in `?inflight=1`, `2`, `3` and the read): queued guidance and
  steered guidance with the start reported (the ordinary paths), then one case per gap: steered guidance worded like its
  prompt (with a read that holds unsaved live text, so the live reply is among the rows searched), an unsaved prompt that
  repeats the run's first prompt after queued guidance, a hidden prompt worded like a person's prompt (its live reply keeps
  the origin Hermes's snapshot gives it), and a prompt matching no saved row whose reply starts like the turn before. The
  cases without a start are unchanged and still pass, which is the older add-on. The fixture's order is corrected: a queued
  prompt's row is saved before its turn starts (`turn.drain`), and the add-on reports the row's stamp, the earlier time; `begin`
  stays for a turn started before its row. The two existing cases for queued guidance now use `drain`. New: another person's
  queued prompt then a segment, another client's queued prompt (no app run) whose turn failed after a segment, so the read's
  live text is the part beyond the saved segment, and a queued prompt that has saved only its row. A stopped turn's snapshot
  keeps the start the add-on reported, as it does for a retained turn.

## Red runs

Each line broken by hand, the stream and runtime files run (141 tests), the file restored.

| Broken line | Result |
| --- | --- |
| `startedRow` ignored (the words only) | 12 failed: the four gap cases in three modes |
| `nativeStartedAt` without `Math.trunc` | 1 failed |
| `nativeStartedAt` without `Number.isFinite` | 2 failed |
| `nativeStartedAt` without `> 0` | 2 failed |
| `at < startedAt` as `at <= startedAt` | 5 failed |
| an untimed message continues instead of falling back | 2 failed |
| the scan reaches below `from` | 1 failed |
| nothing saved as `-1` instead of `messages.length` | 12 failed |
| `promptSaved` by the words only | 4 failed |
| `promptSaved` true without a start | 1 failed |
| `promptSaved` true with a start | 4 failed |
| `inflightMessage` without the start in `savedPrompt` | 3 failed |
| `inflightMessage` without the start in its last turn | 12 failed |
| `turnRows` without the start | 5 failed (`hermes-mapping.ts`) / 4 failed (`hermes.ts` call) |
| the snapshot without `started_at` | 3 failed |
| the snapshot's rows without the start | 3 failed |
| the snapshot's rows with the live reply left in | 3 failed (the steered-like-prompt case, after a read with unsaved text) |

A first version of that last case survived this break: the live reply among the rows made the start fall back to the
words, which a later pass over the rows hid. The case now reads with unsaved text and keeps growing after it.

The Python file, each break killed (`python -B`, `PYTHONDONTWRITEBYTECODE=1`, `__pycache__` cleared): the snapshot and turn
type guard (1 error), the number type check (4 failed), the finite check (2), the positive check (2), the prompt check (1),
the reply prefix check (2), the assignment (2) and the call in `describe_task` (2).

## Red runs for the follow-up

The stream file with the fixture reporting Hermes's own later start for a drained turn, as the add-on did before this change
(`started_at: now + 0.5` in `drain` and the stopped snapshot), then restored: 6 failed, 3 cases. The two queued-guidance and
queued-prompt cases fail in `?inflight=3` (the turn event drops the prompt row, `steer-two` or `req-3` missing), the
saved-only-its-row case fails there too, and the retained failed turn fails in all three modes with the live text "Loft checked.
And more." where "And more." is expected.

The Python file, each break killed (`python3 .agents/tools/mutate-py.py --batch`, `--baseline`, `scripts/run-python-tests.py`):

| Mutation | Result |
| --- | --- |
| the wrapper never keeps the row's time | failed: `test_a_queued_prompt_starts_where_its_row_was_saved_before_hermes_started_the_turn` |
| the staged row's `content` is not checked against the turn's text | failed: `test_a_staged_row_that_is_not_this_turns_prompt_or_has_no_usable_time_is_ignored` |
| the earlier time is not taken | failed: `test_a_queued_prompt_starts_where_its_row_was_saved_before_hermes_started_the_turn` |
| the row's time is taken even when later (`min` dropped) | failed: `test_an_ordinary_prompt_whose_row_is_saved_after_the_turn_started_keeps_the_start` |
| the row's prompt is not compared with the turn's | failed: `test_a_row_kept_for_another_prompt_does_not_start_a_turn_of_different_words` |
| the row's time is not checked as usable | failed: `test_a_staged_row_that_is_not_this_turns_prompt_or_has_no_usable_time_is_ignored` |
| the kept row is not cleared for the next turn | failed: `test_a_turn_never_carries_the_row_of_the_turn_before` |
| the row's prompt is kept unstripped | failed: `test_the_row_is_read_for_the_text_the_turn_runs_whatever_its_spacing` |

A first version checked the time as usable twice (when keeping it and when reading it); either check alone hid a break of the
other, so the second was removed.

## Checks

The first version, before the follow-up: `.agents/tools/check-all --py always` on the committed tree over `origin/main` at `7d794ef`:

| Check | Result | Queued | Run | Counts |
| --- | --- | --- | --- | --- |
| typecheck | pass | - | 0.6s | - |
| lint | pass | - | 0.2s | - |
| ruff | pass | - | 0.0s | - |
| test | pass | 16m00s | 15.0s | 208 files, 3804 tests |
| build | pass | - | 2.7s | 894 modules |
| e2e | pass | 15.3s | 1m58s | 55 tests |
| py | pass | - | 5m05s | 47 files |

The queue time is other worktrees' suites holding the machine's one heavy slot. An earlier run on that version before the
base moved from `884031a` to `7d794ef` (two commits that touch no file here) passed the same seven checks.

The follow-up, `.agents/tools/check-all --py always` on `fab63e9c` (the code, tests and `docs/native-api.md`), after merging
`origin/main` at `fe4026f0`:

| Check | Result | Queued | Run | Counts |
| --- | --- | --- | --- | --- |
| typecheck | pass | - | 0.9s | - |
| lint | pass | - | 0.2s | - |
| ruff | pass | - | 0.0s | - |
| test | pass | 3m45s | 16.8s | 209 files, 3821 tests |
| build | pass | - | 1.7s | 894 modules |
| e2e | pass | 2m01s | 1m58s | 55 tests |
| py | pass | - | 5m18s | 48 files |

## Not done

- No real Hermes run. The field is read from upstream source at `ed1afb0`; the add-on's probe was not run.
- Every file under `src/hermes` and `src/server/hermes*.ts` changed here is on `src/shared/qualification-inputs.json`
  (`src/hermes/extension.py`, `src/server/hermes-mapping.ts`, `src/server/hermes.ts`), so the host needs a new
  qualification receipt before this deploys.
- A compaction summary row gets the current time (`hermes_state_messages.py:889`, `:1024`). One that lands mid-turn sits
  before the turn's prompt in the transcript but is stamped at or after its start, so the scan from the end, which stops at
  the first row earlier than the start, would take it as the turn's first row. Not tested: nothing in the server maps a
  compaction row (no `compaction` or `summary` handling in `hermes-mapping.ts`), so a test would need a shape of that row the
  add-on does not yet expose, and the answer belongs to a change that decides how a read shows it.
