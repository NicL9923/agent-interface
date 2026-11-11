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

## Tests

- `tests/hermes_native_turn_start_test.py` (5): the stamp and nothing else on the snapshot; a grown turn; a snapshot of
  another turn (three forms); no usable start (missing, none, string, boolean, zero, negative, nan, inf); no snapshot or no
  turn.
- `tests/live-turn-runtime.test.ts` (new `describe`, 14): bad `started_at` values fall back to the words; both sides of the
  boundary at a millisecond; nothing saved yet; the start over the words; whole milliseconds; the window's earlier context;
  an untimed message; `promptSaved`; `turnRows`.
- `tests/live-turn-stream.test.ts` (7 new cases, each in `?inflight=1`, `2`, `3` and the read): queued guidance and
  steered guidance with the start reported (the ordinary paths), then one case per gap: steered guidance worded like its
  prompt (with a read that holds unsaved live text, so the live reply is among the rows searched), an unsaved prompt that
  repeats the run's first prompt after queued guidance, a hidden prompt worded like a person's prompt (its live reply keeps
  the origin Hermes's snapshot gives it), and a prompt matching no saved row whose reply starts like the turn before. The
  cases without a start are unchanged and still pass, which is the older add-on.

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

## Checks

`.agents/tools/check-all --py always` on the committed tree over `origin/main` at `7d794ef` (the commit before this entry):

| Check | Result | Queued | Run | Counts |
| --- | --- | --- | --- | --- |
| typecheck | pass | - | 0.6s | - |
| lint | pass | - | 0.2s | - |
| ruff | pass | - | 0.0s | - |
| test | pass | 16m00s | 15.0s | 208 files, 3804 tests |
| build | pass | - | 2.7s | 894 modules |
| e2e | pass | 15.3s | 1m58s | 55 tests |
| py | pass | - | 5m05s | 47 files |

The queue time is other worktrees' suites holding the machine's one heavy slot. An earlier run on the same change before the
base moved from `884031a` to `7d794ef` (two commits that touch no file here) passed the same seven checks.

## Not done

- No real Hermes run. The field is read from upstream source at `ed1afb0`; the add-on's probe was not run.
- Every file under `src/hermes` and `src/server/hermes*.ts` changed here is on `src/shared/qualification-inputs.json`
  (`src/hermes/extension.py`, `src/server/hermes-mapping.ts`, `src/server/hermes.ts`), so the host needs a new
  qualification receipt before this deploys.
- A user row Hermes stamps with a time earlier than the turn's start would start the turn after its prompt. The TUI
  gateway never passes one (`persist_user_timestamp` is only set by the messaging gateway,
  `gateway/run_turn_prepare.py:608-623`), so the add-on's session turns are not affected; not exercised.
