# November 10 a receipt bound only to the turn that ran its prompt

Branch `t3/receipt-turn-binding` over `origin/main` at `5d74731`, on NicolasLaptop (Linux x86_64, Python 3.14.10,
Node 24.22.2). Source fingerprint `sha256:75389a5131af325a63fe0a17530b4a3a54c7775a0c08c8925972387d35429062` (1687 files); `src/hermes` alone `sha256:8ea901f9410bf3a940eb92d6a367a02c97cb5cd53cd6e28270ca8d4d765777f9`. No Hermes process ran and
the production host was not touched.

## Fault

`Bridge.write` bound every `message.complete`'s `persisted_turn.user_row_id` to the session's oldest unbound,
unsettled, non-steering receipt, with no evidence that the completed turn ran that receipt's prompt. An independent
reviewer (GPT-6.1 Sol) reproduced two cases on `main`: an app send Hermes answered `queued` or `redirected`, with no
`user_row_id`, followed by another client's turn completing in the same chat. The app receipt then held the other
client's prompt row, and history showed that prompt under the app sender's name with the app sender's text and files.

## Native evidence, read from upstream `ed1afb082eb3`

Read in a scratch clone of `NousResearch/hermes-agent` at `ed1afb0`, the revision recent add-on ledgers cite. It is
not necessarily the production revision. Revisions `b9cb268` and `d23cc6b` start turns through the same
`spawn_context_thread` call (`tui_gateway/session_lifecycle.py:39` in each).

- `prompt.submit` stages the prompt's row, answers `user_row_id` for it, and starts `_run_after_agent_ready` with its
  own JSON-RPC request ID (`tui_gateway/methods_prompt.py:957-973`), which passes that ID to `_run_prompt_submit`
  (`:674-713`). Over a running turn it redirects or queues instead and starts nothing (`session_auto_continue.py:400-454`).
- After a turn its own thread runs the followups with the same request ID (`prompt_turn.py:1243-1249`). A queue drain
  (`prompt_turn.py:451`, `session_auto_continue.py:457-525`), leftover steering requeued as a prompt (`prompt_turn.py:447-450`)
  and a goal continuation (`:453-460`, `:424-439`) all run `_run_prompt_submit` under the finished turn's request ID.
  A resumed turn runs under `__auto_continue__<ms>` (`session_auto_continue.py:90-131`).
- `_run_prompt_submit` starts the turn with `_start_session_work` (`prompt_turn.py:1262`), which runs it under
  `spawn_context_thread`, a copy of the caller's contextvars (`session_lifecycle.py:24-46`, `agent/memory_provider.py:21-33`).
  The turn emits `message.complete` with `persisted_turn.user_row_id` from that thread (`prompt_turn.py:1183-1193`,
  `:902-942`), through `write_json`, which the add-on wraps.
- The lead from earlier work holds: the staged row is popped at turn start and adopted only if it holds the turn's
  text (`session_workdir.py:807-814`, called at `prompt_turn.py:819`). It is not needed for the rule below, which
  needs no row at turn start, so it also covers an image sent alone, which has no staged row.

## Change

- Each `prompt.submit` the add-on sends carries a request ID of its own, `agent-interface-submit:<random>`,
  registered with the receipt and text before Hermes is called.
- A wrapper around Hermes's `_run_prompt_submit` lets the first call with that ID, for the same session, with exactly
  the receipt's text and no display kind or author, claim the receipt. The claim lives in a context variable for the
  call, so the turn thread Hermes starts inherits it. Every other call sets it to None, so a drain or continuation on
  the finished turn's thread never inherits that turn's claim.
- `message.complete` binds the reported row only to the claimed receipt, once, and only if Hermes's admission answer
  named no row. Any other completion binds nothing.
- An answer other than `streaming` drops the ID; a started turn drops the session's older unclaimed IDs.
- Image recovery in an open binds only a row no receipt holds, whose words are exactly the receipt's text with its own
  uploads in Hermes's image-reference form.
- The decorated-history cache stays off only while a steering or image receipt is unbound, the only kinds a later read
  of the same rows can still bind. A send left unbound by design no longer turns the cache off for good.
- `docs/HermesCapabilityMatrix.md` records the rule and its native evidence. No stored format changed.

## What stays unbound

A send Hermes queued or redirected, unless it carries images that recovery matches; a text send whose staged row
failed to write and whose turn Hermes started under a sanitized text that differs; and a steering receipt whose root is
unbound. Each shows Hermes's own row, unattributed. The app's sent echo matches an unattributed row by its words, so it
clears as before (`src/app/sent-echo.ts`). Steering keeps its rebind in `attribute`: equal words, after the root's
bound row, within the root's run, so its evidence chains from a root bound by the rule above.

## Decision: journals that already hold a wrong binding

Flag at read, keep the row. An open does not attribute a binding whose row's own words contradict a text-only,
non-steering receipt (no attachments, no `@` reference, text not empty) that Hermes's saved admission answer did not
name. Since September 29 every text send Hermes started was bound by its answer's `user_row_id`
(`git log -S user_row_id`), so the old completion hook bound a text receipt only for a queued or redirected send or a
failed staged write, and of those only the last is correct, and its row holds the same words. The journal row is
kept: clearing it cannot be undone, and a later fix could restore an attribution the rule hid by mistake. Not
caught: a wrong binding whose row has the same words, and one for a send with file references, whose saved row Hermes
rewrites. The receipt RPC still reports the stored row ID.

## Turn row for `inflight`, not added

At `_run_prompt_submit` the session's `_submit_user_row` already names the starting turn's prompt row when Hermes
staged one with the turn's text. The wrapper could keep that ID on the session until the turn's `message.complete`, and
`describe_task` could add it to `inflight`. It would be absent for an image sent alone, a resumed turn, a goal
continuation and a failed staged write, and an in-place compaction copy shows under the original row ID, which the
server would compare against. Cost: about ten add-on lines, their tests and the Node change that reads it.

## Checks

- `npm run test:py`: 43 files passed, 0 skipped, 0 failed (Python 3.14.10). `tests/hermes_turn_binding_test.py` is
  new, 17 tests: both reproductions, a task that starts at once, an image sent alone, a queued image send, image
  recovery beside another receipt's row, a steer consumed in place, guidance run as its own turn, two members' sends
  behind one native turn, two queued texts Hermes merged, a resumed turn, a goal continuation, a send drained under an
  app turn's request ID, the cache, and three tests on journals the old hook wrote.
- `npm run lint:py` with ruff 0.17.3 from `.github/requirements-ci.txt`: passed.
- `npm ci`, then `npm run typecheck`: passed. `npx vitest run tests/hermes-adapter.test.ts
  tests/hermes-qualification.test.ts`: 2 files, 233 tests passed.

## Red proof

Each line was broken with a scripted text replacement, the test module run, and the source restored and checked.

| Broken | Red |
| --- | --- |
| Completion binds the oldest unbound receipt, as `main` did | 8 tests: both reproductions, the queued image send, two members, merged texts, resumed turn, goal continuation, drained send |
| A request ID claimable more than once | `test_a_send_drained_under_an_app_turns_request_id_never_takes_its_receipt` |
| `prompt.submit` sent without its own request ID | `test_an_image_send_is_bound_to_the_row_its_own_turn_reports` |
| Claim reused and inherited by a drain or continuation (both guards removed) | the goal-continuation and drained-send tests |
| Contradicted binding trusted | both contradiction tests |
| Contradiction ignoring the row Hermes's answer named | `test_a_binding_the_rows_own_words_contradict_is_not_shown_and_is_kept` |
| Contradiction judged for file and image sends | the file-and-steering test, the queued image test, the recovery test |
| Image recovery taking a held row | `test_image_recovery_never_takes_a_row_another_receipt_holds` |
| Any unbound receipt turns the cache off | the cache test |
| Image receipts no longer keep it off | the cache test |

Either claim guard alone, the reset to None or the one-use flag, keeps every test green; removing both goes red.

Not run: real Hermes, the extension probe (`scripts/spike/extension_probe.py`, which checks an image sent alone
against real Hermes), `npm test`, iOS and production. The inline guidance check `app_prompt` still matches by text;
it changes no stored data and is unchanged.
