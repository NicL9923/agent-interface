# November 10 a receipt bound only on evidence that ties the row to the request

Branch `t3/receipt-turn-binding` over `origin/main` at `5d74731`, on NicolasLaptop (Linux x86_64, Python 3.14.10,
Node 24.22.2). First round at `c8f9a85`; second round after GPT-6.1 Sol's review of it. Source fingerprints are under
Checks. No Hermes process ran and the production host was not touched.

## Fault

`Bridge.write` bound every `message.complete`'s `persisted_turn.user_row_id` to the session's oldest unbound,
unsettled, non-steering receipt, with no evidence that the completed turn ran that receipt's prompt. An independent
reviewer (GPT-6.1 Sol) reproduced two cases on `main`: an app send Hermes answered `queued` or `redirected`, with no
`user_row_id`, followed by another client's turn completing in the same chat. The app receipt then held the other
client's prompt row, and history showed that prompt under the app sender's name with the app sender's text and files.

The second review found two more paths on `main` that bind by words. A steer was paired with the first row after its
root's row holding its words, with no upper bound, so another client's correction with the same words could take it.
Image recovery bound a queued image receipt to any row, up to a second newer than the receipt, holding its words and
file in Hermes's image-reference form; file identifiers belong to the assistant, so another member's or a native
client's row with the same words and file could take it.

Principle for this branch: a receipt is bound to a row only on evidence that ties that row to that request. Equal
words are not evidence. Without evidence the receipt stays unbound and the row shows unattributed. A wrong sender is
worse than no sender.

## Native evidence, read from upstream

Read in a scratch clone of `NousResearch/hermes-agent` at `ed1afb0`, the revision recent add-on ledgers cite, and
checked at the qualified `b9cb268` and `d23cc6b`. None is necessarily the production revision.

- `prompt.submit` sanitizes its text (`tui_gateway/methods_prompt.py:822-825`; `:567-570` at the others), stages the
  prompt's row, answers `user_row_id` for it, and starts `_run_after_agent_ready` with its own JSON-RPC request ID
  (`:957-973`), which passes that ID and text to `_run_prompt_submit` (`:674-713`). Over a running turn it redirects
  or queues instead and starts nothing (`session_auto_continue.py:400-454`).
- After a turn its own thread runs the followups with the same request ID (`prompt_turn.py:1243-1249`). A queue drain
  (`prompt_turn.py:451`, `session_auto_continue.py:457-525`), leftover steering requeued as a prompt (`prompt_turn.py:447-450`)
  and a goal continuation (`:453-460`, `:424-439`) all run `_run_prompt_submit` under the finished turn's request ID.
  A resumed turn runs under `__auto_continue__<ms>` (`session_auto_continue.py:90-131`).
- `_run_prompt_submit` starts the turn with `_start_session_work` (`prompt_turn.py:1262`), which runs it under
  `spawn_context_thread`, a copy of the caller's contextvars (`session_lifecycle.py:24-46`, `agent/memory_provider.py:21-33`).
  The turn emits `message.complete` from that thread (`prompt_turn.py:1183-1193`, `:902-942`) through `write_json`,
  which the add-on wraps. Its `persisted_turn` carries the prompt's `user_row_id` and `row_ids`, every row the turn
  committed (`agent/persisted_turn_receipt.py:20-65`; `tui_gateway/prompt_turn.py:812-856` at the others).
- Steering has no native identity at any of the three. `session.steer` calls `agent.steer(text)` and answers
  `{"status": "queued", "text": text}` (`tui_gateway/methods_session_interrupt.py:114-130` at `ed1afb0`,
  `tui_gateway/methods_session.py:2283-2299` at the others). `ed1afb0`'s `steer` takes a `ticket` (`agent/interrupt_control.py:310`),
  but only Hermes's own gateway transfer passes one, and the row carries none. The turn drains every pending steer as
  one newline-joined text after a tool batch and appends it as one user row of display kind `steer`
  (`agent/agent_runtime_helpers.py:3668-3703`, `agent/prompt_builder.py:586-592`; `:3516-3554` at the others), which
  history shows with the steer's own words (`tui_gateway/session_history.py:329-332`). Leftover steering becomes the
  next prompt.

## Change

- Each `prompt.submit` the add-on sends carries a request ID of its own, `agent-interface-submit:<random>`,
  registered with the receipt and text before Hermes is called.
- A wrapper around Hermes's `_run_prompt_submit` lets the first call with that ID, for the same session, with exactly
  the receipt's text and no display kind or author, claim the receipt. The claim lives in a context variable for the
  call, so the turn thread Hermes starts inherits it. Every other call sets it to None, so a drain or continuation on
  the finished turn's thread never inherits that turn's claim.
- `message.complete` for the claimed turn's session binds the reported prompt row to the claimed receipt, once, if
  Hermes's admission answer named no row, and stores the turn's `row_ids` in a new nullable `receipts.turn_rows`
  column. Any other completion binds nothing.
- This claim covers every image send that starts at once, with words or alone: the add-on submits the receipt's text
  unchanged after staging, and Hermes runs that text with the staged images. Read-time image recovery is removed.
- A steer is bound at read only when its root's turn has finished and stored its rows, exactly one user row among
  them holds the steer's words, no receipt holds that row, and no other receipt of the run, bound or not, sent the
  same words (`Bridge.bind_steers`).
- Stored bindings are shown as stored, as on `main`. The first round's read-time check is removed.
- The decorated-history cache no longer turns off for unbound receipts: a read binds only from the rows and the
  journal, so a later read of the same rows and journal binds nothing new.
- `docs/HermesCapabilityMatrix.md` records the rule, its native evidence and the unbound cases.

## Decisions in the second round

- Steering. Hermes gives a steer no identity, so the add-on binds only when the result cannot be ambiguous. The end
  of the root's run is the end of the root's turn as Hermes reports it (`row_ids`), which needs no guess about where
  the next turn starts in history. Residual: if Hermes compacted away one of two same-word rows of a finished turn
  and kept the other, the survivor counts as the only one. A steer Hermes ran as its own turn after the root finished
  is outside the root's turn and stays unbound; the first round bound it by words.
- Images. The preferred fix held: the claim already compares the turn's text with the text the add-on submitted after
  staging, and an image sent alone submits an empty text that Hermes runs as an empty text. No case of an image send
  that starts at once needs recovery, so recovery is gone rather than narrowed.
- Sanitized text. The claim compares with the receipt's text as sent, not with Hermes's sanitized copy. A text send is
  bound by its answer's `user_row_id` whatever the sanitizer did. A send whose answer named no row and whose words the
  sanitizer changed stays unbound; that is a leaked bracketed-paste marker together with a failed staged write. Calling
  Hermes's sanitizer would bind more and was not needed.
- Old journals. The first round flagged at read a binding whose row's words contradicted a text-only receipt. Two
  findings condemned it: the receipt RPC still returned the stored row, and Node's `submissionForMessage()`
  (`src/server/conversation-view.ts:15`) mapped the row back to the wrong member, so it protected nothing end to end;
  and it hid correct bindings whenever Hermes changed the row's words, for example by sanitizing leaked
  bracketed-paste markers, editing, redacting or projecting the row. Removed. Journals written before this change may
  still hold a wrong binding from the old completion hook or the old steering and image matchers. This change does not
  repair them, and no repair tool is built.

## What stays unbound

Each shows Hermes's own row, unattributed:

- a send Hermes queued or redirected, with or without images;
- a send whose turn's completion reported no prompt row, or whose words Hermes's sanitizer changed while its answer
  named no row;
- a steer beside another client's correction or another steer with the same words in the root's turn;
- steers Hermes delivered together as one row;
- a steer Hermes ran as its own turn after the root's turn ended, and a steer into a later turn of the same task, such
  as a goal continuation;
- a steer whose root is unbound, or whose root's turn reported no rows, including every steer in a journal from
  before this change that is still unbound.

Image sends by case: an image with words that starts at once is bound at admission by the staged row Hermes names.
An image sent alone that starts at once is bound when its turn completes, and is unattributed only while the turn
runs or if the turn reports no prompt row. An image sent while the assistant is busy is refused by the add-on with
the draft kept, unless another client's turn starts between the add-on's idle check and Hermes's admission; that race
is the only queued image send, and it stays unbound.

The app's sent echo (`src/app/sent-echo.ts:28-40`) clears on the row with its request ID or on a later user row with
its exact words and no other sender. The first round said an unattributed row clears the echo as before. That holds
for one send, not for two queued prompts Hermes merged into one row: the merged row holds neither send's exact words,
so neither echo clears on it, and the app shows the merged row and both local echoes until the conversation's
activity settles (`:74-75`). No client code changed.

## Turn row for `inflight`, not added

At `_run_prompt_submit` the session's `_submit_user_row` already names the starting turn's prompt row when Hermes
staged one with the turn's text. The wrapper could keep that ID on the session until the turn's `message.complete`, and
`describe_task` could add it to `inflight`. It would be absent for an image sent alone, a resumed turn, a goal
continuation and a failed staged write, and an in-place compaction copy shows under the original row ID, which the
server would compare against. Cost: about ten add-on lines, their tests and the Node change that reads it.

## Checks

First round at `c8f9a85`: `npm run test:py` 43 files passed; `npm run lint:py` passed; `npm run typecheck` passed;
`npx vitest run tests/hermes-adapter.test.ts tests/hermes-qualification.test.ts` 2 files, 233 tests passed.

Second round, on the committed tree:

Source fingerprint sha256:84d0f6dc4ac5bdc6fe6a04e6ff849dcb04398d08331bcf135937daee18b47e51 (1687 source files); `src/hermes` alone sha256:e45dd874f3ff15f1842f214218e1c52b42765ffc725f84de4ebc980ee6e9164b (20 source files).

- `npm ci`, then `npm run test:py`: 43 files passed, 0 skipped, 0 failed (Python 3.14.10, 206 s).
- `npm run lint:py` with ruff 0.17.3 from `.github/requirements-ci.txt`: passed. `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npx vitest run tests/hermes-adapter.test.ts tests/hermes-qualification.test.ts tests/sent-echo.test.ts`: 3 files,
  251 tests passed.

`tests/hermes_turn_binding_test.py` now has 21 tests and 11 more subtests. Every test in it uses a fake Hermes that
raises on any method or command it did not configure: `TurnHermes`, or `StoredRows` in place of the permissive
`FakeGateway.handle()`. `TurnHermes.start` no longer patches `extension.source_state`; it answers that function's two
`git` commands at `subprocess.check_output` and raises on any other. The first round's three tests on old journals
and the image-recovery test are removed with the code they tested.

## Red proof

First round, each line broken with a scripted text replacement and the module run:

| Broken | Red |
| --- | --- |
| Completion binds the oldest unbound receipt, as `main` did | 8 tests: both reproductions, the queued image send, two members, merged texts, resumed turn, goal continuation, drained send |
| A request ID claimable more than once | `test_a_send_drained_under_an_app_turns_request_id_never_takes_its_receipt` |
| `prompt.submit` sent without its own request ID | `test_an_image_send_is_bound_to_the_row_its_own_turn_reports` |

The first round's rows for the read-time check and image recovery tested code this round removed. Its note that
either claim guard alone kept every test green is answered below.

Second round, reproductions written first and run against `c8f9a85`'s `src/hermes/extension.py` with the new test
module (`git show c8f9a85:src/hermes/extension.py` over the file, then restored and compared byte for byte):

| Reproduction | Red on `c8f9a85`, for the reviewer's reason |
| --- | --- |
| Item 1: a stored binding to a row whose words Hermes sanitized | `test_a_stored_binding_is_shown_however_hermes_changed_the_rows_words`: shown `(None, None)`, not `alice-1` |
| Item 2: Kim's steer beside a native correction with the same words | `test_a_steer_beside_another_clients_correction_with_the_same_words_stays_unbound`: `kim-1` shown on the native row |
| Item 3: a queued image send beside an older native row with its words and file | `test_a_queued_image_send_stays_unbound_beside_an_older_row_with_its_words_and_file`: `alice-1` shown on the native row |
| Item 3: an image sent alone, opened while its turn runs, beside an older row with its file | `test_an_image_send_is_bound_to_the_row_its_own_turn_reports_never_an_older_one`: `alice-1` shown on the desktop's row |

On `c8f9a85` the goal-continuation, drained-send and guidance tests also fail, on the recovery and word matching
this round removed, and the steering-table and cache tests error because `turn_rows` does not exist there.

Second round mutants, each applied to the fixed source by a script, the module run, and the source restored and
compared:

| Broken | Red |
| --- | --- |
| Claim: no same-session guard | `test_only_the_turn_hermes_started_for_the_send_claims_it` [another session] |
| Claim: no exact-text guard | the same test [other words] |
| Claim: no display-kind guard | the same test [a display kind] |
| Claim: no author guard | the same test [a relayed author] |
| Claim: ID read, not taken, so claimable again | `test_a_send_drained_under_an_app_turns_request_id_never_takes_its_receipt` |
| Wrapper keeps an inherited claim instead of clearing it | `test_a_continuation_after_a_claimed_turn_failed_never_inherits_its_claim` |
| Bind: no one-use marking | `test_a_claim_binds_at_most_once_even_when_its_first_completion_named_no_row` |
| Bind: no completion-session guard | `test_a_completion_for_another_session_neither_binds_nor_spends_the_claim` |
| Bind: no `row_ids` shape guard | `test_a_steer_stays_unbound_when_its_roots_turn_reports_no_rows` |
| Steer: any number of matching rows | the same-words test and the steering table [two rows in the turn] |
| Steer: no finished-turn requirement | the steering table [the turn has not finished], the no-rows test, the two-members test |
| Steer: rows outside the root's turn count | the steering table [one row in the turn], the guidance test |
| Steer: other receipts' words ignored | the steering table [another unbound steer], [another bound steer] |
| Steer: a row another receipt holds can be taken | the steering table [the row held by another receipt] |
| Cache off while any receipt is unbound | `test_unbound_sends_and_steers_still_let_opens_reuse_decorated_history` |

Not caught: replacing `COALESCE(row_id,?)` with the completion's row, which would overwrite a row Hermes's answer
named. In the fake, as in upstream, the claimed turn adopts the staged row, so both are the same row.

Not run: real Hermes, the extension probe (`scripts/spike/extension_probe.py`, which checks an image sent alone
against real Hermes), `npm test`, iOS and production. The inline guidance check `app_prompt` still matches by text;
it changes no stored data and is unchanged.
