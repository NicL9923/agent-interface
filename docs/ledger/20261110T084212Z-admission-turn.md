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

## Review fixes

An independent reviewer (GPT-6.1 Sol) verified two findings with reproductions against the add-on.
`t3/send-lanes` is merged in with a normal merge commit after its own review fixes, so this branch also carries the
turn-claim binding rule ([20261110T094510Z-receipt-turn-binding.md](20261110T094510Z-receipt-turn-binding.md)) and
the send-lanes fixes ([20261110T083417Z-send-lanes.md](20261110T083417Z-send-lanes.md)). Source fingerprint
`sha256:dd42b1575e7beda274dd527f152e9bfdb70eba1012153f903df899dfcecefd23` (1688 files); `src/hermes` alone `sha256:2d5b3797b154db20f88c9d1cc4a339f29bb8f441e9581b7e8712002a9ea3c5eb`. Same host and versions as above.

- P2, a missing `turn` did not always mean a turn started. Read from `ed1afb0`, native `prompt.submit` answers
  success in five shapes: `streaming` when it started the turn (`tui_gateway/methods_prompt.py:973`, and
  `compute_host_bridge.py:327` with `turn_isolation`); `steered` or `redirected` into a running turn
  (`session_auto_continue.py:246-259`); `queued` from the busy queue (`:454`); `queued` with `forwarded: true` in
  another gateway owner's queue (`methods_prompt.py:762-763`); and `{"voice_stopped": true}` for a stop phrase typed
  while the session's voice mode is on, which ends the voice chat and admits nothing (`:239-268`, `:760-761`, checked
  first at `:835-836`). `admission_turn` now names each: nothing for `streaming` only, `queued`, `joined`, `none`
  for a typed stop, and `unknown` for any answer it does not know. Only a missing `turn` on an accepted new task means
  the turn started.
- Decision, typed stop. The receipt exists: it was written before Hermes was called, and a replay of the request ID
  must answer the same, never send again. It is `accepted`, since Hermes acted on the text and the client should
  clear the draft, with `turn: "none"` and a message saying nothing was sent to the assistant. It is settled at once:
  no turn will end it, and an unsettled receipt with Hermes idle would refuse every later send as "Hermes is finishing
  the preceding task", and the next turn's followups would settle it with that turn's outcome. Its run ID stays its
  own request ID, as for every receipt: the journal and the receipt lookup derive it that way, Node's `runId` is a
  string or absent, and no events ever name it. It clears no interruption review, because nothing ran. An unknown
  answer keeps today's handling, accepted and unsettled, so a turn it may have started still settles it.
- P3, `queued` overstated. Hermes's busy queue merges text into the only queued prompt when it has no image or author,
  and drops text identical to the running prompt, answering `queued` either way (`session_auto_continue.py:147-176`,
  `:441-454`). `docs/HermesCapabilityMatrix.md` and `docs/native-api.md` now call `queued` the busy queue's
  disposition, not a promise of a separate later turn, and so does the code comment.
- With the binding rule, a queued or joined new task is bound to no prompt row: no turn claims it, because a drain runs
  under the finished turn's request ID and a correction runs in another turn. Its words show as Hermes saved them,
  unattributed, and the app's sent echo matches them by text. A queued image send is no exception since the binding
  rule's second round removed image recovery (see the last section). Two queued prompts Hermes merged into one row
  hold neither send's exact words, so neither sent echo clears on that row until the activity settles.

## Review checks

- `npm run test:py`: 44 files passed, 0 skipped, 0 failed (Python 3.14.10). `AdmissionTurnTests`: 4 tests, one new,
  and its table grew from 4 to 9 native answers. `tests/hermes_turn_binding_test.py`: 18 tests, one new.
- `npm run lint:py` with ruff 0.17.3: passed.
- `npm run typecheck`: passed. `npx vitest run tests/hermes-adapter.test.ts tests/hermes-qualification.test.ts`:
  2 files, 233 tests passed.
- After those runs, only a code comment's citation changed; `AdmissionTurnTests` ran again and passed. The
  fingerprint above is of the committed code.

## Review red proof

| Broken | Red |
| --- | --- |
| A typed stop read as an unknown answer | `test_a_typed_stop_admits_nothing_and_holds_up_no_later_send` |
| A typed stop's receipt left unsettled | the same test: the next send is refused as finishing |
| A typed stop clears the interruption review | the same test |
| An unknown answer reported with no `turn` | the answer table, 3 cases |
| `streaming` not the only answer read as started | the answer table and the typed-stop test |
| A queued or joined send bound by `main`'s completion hook | `test_a_new_task_hermes_queued_or_joined_says_so_and_is_bound_to_no_row`, both cases |

Not run: real Hermes, the qualification run, `npm test`, iOS and production.

## Merge of the binding rule's second round

`t3/send-lanes` at `aba9af0` is merged in with normal merge commits, carrying `t3/receipt-turn-binding` at
`579fc08`: read-time image recovery and the read-time check for old bindings are gone, and a steer binds only inside
its root's finished turn. See
[20261110T094510Z-receipt-turn-binding.md](20261110T094510Z-receipt-turn-binding.md).

- The merge conflicted only in `tests/hermes_turn_binding_test.py`. It takes the rewritten module and carries
  `test_a_new_task_hermes_queued_or_joined_says_so_and_is_bound_to_no_row` into it, with a third case: a queued
  image send, which Hermes queues in either busy mode, reports `turn: "queued"` and is bound to no row. The
  sentence above that called a queued image send the exception is corrected, and so is the matching sentence in
  `docs/HermesCapabilityMatrix.md`.
- Source fingerprint sha256:f93cd55a382aa278a2c2b2e4dd099ea66cd7e2bbb0e313f6c3d9192b3b47f43e (1688 source files); `src/hermes` alone sha256:3ef7c7b74540f930da6c2b0f924ec1d4b7f1223061ca7ad98fc9fdd07b76c4dd (20 source files). Same host and versions.
- `npm run test:py`: 44 files passed, 0 skipped, 0 failed (Python 3.14.10). `tests/hermes_turn_binding_test.py`:
  22 tests.
- `npm run lint:py` with ruff 0.17.3, `npm run lint` and `npm run typecheck`: passed.
- `npx vitest run tests/hermes-adapter.test.ts tests/hermes-qualification.test.ts tests/sent-echo.test.ts`: 3 files,
  251 tests passed.

| Broken | Red |
| --- | --- |
| `ea84953`'s add-on, with image recovery, under the new test | the queued-or-joined test, image case: `alice-1` shown on her queued row |
| `main`'s completion hook restored | the queued-or-joined test, among others |
| The 15 mutants of the binding entry's second round | each its own test, on this merged source |

Not run: real Hermes, the qualification run, `npm test`, iOS and production.

## Merge of the binding rule's third round

`t3/send-lanes` at `26c4eb3` is merged in with a normal merge commit, without conflicts, carrying
`t3/receipt-turn-binding` at `064593c`: a turn's `row_ids` are stored only as a list of positive row IDs and checked
again when read, a receipt keeps the row Hermes's admission named, and the test fake joins waiting steers into one
row and can hand later steers to the next turn. The steering rule is unchanged; its known limit is in that entry.
`test_a_new_task_hermes_queued_or_joined_says_so_and_is_bound_to_no_row` passes under the new fake in all three
cases: a redirected send is a correction delivered as a row of its own, and it is not a steering receipt.

Source fingerprint sha256:6c913b191f3a90caec07321762bf9d16d9b9b555859c15d732b2c62019b35ebc (1688 source files); `src/hermes` alone sha256:9cdcb4ebd74c727bfdce6ad82862274df9f683effb89f1bc4ecfb8f302b95bf6 (20 source files). Same host and versions.

- `npm run test:py`: 44 files passed, 0 skipped, 0 failed (Python 3.14.10, 212 s). `tests/hermes_turn_binding_test.py`:
  27 tests.
- `npm run lint:py` with ruff 0.17.3, `npm run lint` and `npm run typecheck`: passed.
- `npx vitest run tests/hermes-adapter.test.ts tests/hermes-qualification.test.ts tests/sent-echo.test.ts`: 3 files,
  251 tests passed.
- Red proof on the merged source: the 11 mutants of the binding entry's third round each turn the same tests red as
  on `t3/receipt-turn-binding`.

Flaky, not caused by this merge: `test_a_queued_image_send_stays_unbound_beside_an_older_row_with_its_words_and_file`
failed 2 of 60 isolated runs at `origin/t3/send-lanes` (`aba9af0`) and at `origin/t3/admission-turn` (`a10b127`), and
0 of 60 at `t3/receipt-turn-binding`. When it fails, Alice's queued turn runs with no image: the racing native turn's
thread took the session's attached images after the add-on had attached her photo. Upstream also takes them on the
turn's own thread (`tui_gateway/prompt_turn.py:150` at `ed1afb0`). Making the race wait for that turn to start
deadlocks, because the turn cannot start while the add-on is inside `image.attach`. Not fixed here; whether a real
native turn can take an app send's staged image is a question for the send-lanes staging order.

Not run: real Hermes, the qualification run, `npm test`, iOS and production.

## Merge of the send-lanes fourth review round

`t3/send-lanes` at `a561fba` is merged in with a normal merge commit, without conflicts. It carries the binding rule's
fourth round (`4a88ab3`) and the send-lanes fourth review round: the turn fake now runs Hermes's `_invoke_agent` after
the image snapshot, the queued-image test waits on the native turn's snapshot instead of racing it, a native turn that
takes a member's photo between staging and her `prompt.submit` is recorded as a known defect with a test of what the
add-on still guarantees, and a test proves the lane fake's guard. See that entry. This branch's admission code is
unchanged by the merge. The flaky queued-image test noted above is fixed by that round.

Source fingerprint sha256:233d80cc08b8498eccfbc586ffd5627e9a8c07ddc15cab98f5edd450332548a0 (1688 source files); `src/hermes` alone sha256:10a423d30f77a5d1784a04132fdc11f8d301610599ff7934912b1c064f7e4391 (20 source files). Same host and versions.

- `npm run test:py`: 44 files passed, 0 skipped, 0 failed (Python 3.14.10, 201 s). `tests/hermes_turn_binding_test.py`:
  29 tests; `tests/hermes_send_lanes_test.py`: 11 tests.
- `npm run lint:py` with ruff 0.17.3, `npm run lint` and `npm run typecheck`: passed.
- `npx vitest run tests/hermes-adapter.test.ts tests/hermes-qualification.test.ts tests/sent-echo.test.ts`: 3 files,
  251 tests passed.
- The queued-image test alone, 50 runs in fresh processes: 50 passed.
- Red proof on the merged source: the four mutants of the send-lanes fourth round (the lane fake's guard removed, its
  record dropped, its exit check removed, and `main`'s completion hook restored) each turn their test red here too.

Not run: real Hermes, the qualification run, `npm test`, iOS and production.

## Second review round

`t3/send-lanes` at `19bca48`, its fifth review round, is merged in with a normal merge commit, without conflicts: `main`
at `f0ae0a5`, a lane worker that cannot start answered once and never run later, and the one-shot `Reservation`. See
that entry. GPT-6.1 Sol reviewed `f9d6698`: no P1.

- P2, a typed stop's photo taken by the next send. Alice sends "stop" with a photo while voice mode is on; the add-on
  stages the photo and Hermes answers `{"voice_stopped": true}`. Hermes answers a typed stop before it reads the session
  (`tui_gateway/methods_prompt.py:835-836` at `ed1afb0`, `:580` at `b9cb268` and `d23cc6b`), so it never touches
  `attached_images`, and the next turn's admission takes every image staged on the session (`prompt_turn.py:150-152` at
  `ed1afb0`, `:141-143` at the others). Her "What time is it?" ran with the stop's photo. The add-on now removes the images
  this request staged when the answer is `turn: "none"`, with the same `unstage_images` its refusal paths use, which
  keeps images staged before the request. The forwarded form of the answer (`methods_prompt.py:760-761` at `ed1afb0`) has
  nothing to remove: a session with staged images is never forwarded (`tui_gateway/owner_forward.py:100`), and the two
  later revisions have no forwarding.
- Decision, `unknown`. Its images stay staged. A turn Hermes starts takes the session's images on the turn's own thread,
  started just before Hermes answers (`methods_prompt.py:965-973` at `ed1afb0`, `:695-702` at the others), so an answer
  the add-on does not know may belong to a turn that has not yet taken them, and removing them would take the photo out of
  the very turn it was sent with. The cost: if such an answer admitted nothing, its images wait for the next turn, as on
  `main`. No known answer does that.
- P3, an unknown answer's settlement untested. A new test checks that its receipt is not terminal and that a different
  send after it, with Hermes idle, is refused as Hermes finishing the preceding task, without calling Hermes.
- The turn fake now models a typed stop (`voice`), and can answer a started turn in another shape (`reply_as`) and hold
  that turn's admission on an event (`hold_admission`), so the image snapshot happens after the add-on has the answer, as
  Hermes's thread does.

## Second review round checks

Source fingerprint sha256:2e1ed1cb59188f38f820a4da48c41402d9ee0e784f13bf7f55d105521e22820c (1697 source files); `src/hermes` alone sha256:e7b2af77b57294a2d9992f09294dcb12e84c2f06cbf44411f51eea8b0d1a4db9 (20 source files). Same host and versions (Python 3.14.10).

- `npm run test:py`: 44 files passed, 0 skipped, 0 failed (210 s). `tests/hermes_turn_binding_test.py`: 31 tests, 2 new;
  `AdmissionTurnTests`: 5 tests, 1 new.
- `ruff check .` with ruff 0.17.3, `npm run lint` and `npm run typecheck`: passed.
- `npx vitest run tests/hermes-adapter.test.ts tests/hermes-qualification.test.ts tests/sent-echo.test.ts`: 3 files,
  251 tests passed.

## Second review round red proof

`test_a_typed_stop_takes_back_its_photo_and_leaves_one_staged_before_it` went red on the merged code before the fix, for
the reviewer's reason, in both cases: the stop left `['/uploads/shared/photo.png']` staged, and beside an image staged
before it, `['/uploads/desktop/chart.png', '/uploads/shared/photo.png']`.

Each line was then broken with a scripted text replacement, the test run, and the source restored and checked. The script
runs tests without writing bytecode and deletes the source's `__pycache__` after restoring:

| Broken | Red |
| --- | --- |
| A typed stop's images left staged | the typed-stop test, both cases |
| A typed stop clearing every staged image | the typed-stop test, with an image staged before it |
| An unknown answer's images removed too | `test_an_answer_the_add_on_does_not_know_leaves_its_photo_for_the_turn_it_may_have_started` |
| An unknown answer settled, as the reviewer's probe did | `test_an_unknown_answer_stays_open_for_the_turn_it_may_have_started` |

Not run: real Hermes, the qualification run, `npm test`, iOS and production.
