# November 12 an app open reprojects only the pieces of a history that changed

Branch `t3/d9d06f0e` over `265f36db`, on NicolasLaptop (Fedora 44, Linux x64), Python 3.14.10. Source fingerprint of
`src/hermes`, `tests/hermes_projection_memo_test.py` and `tests/hermes_extension_journal_test.py` with both of this
branch's changes applied: `sha256:5873054a80f79e95575a45fb15efb6c59033da1d8ac3753138b5a4de779d7f73` (22 source files).
Hermes `ed1afb0`, read on the production host with `sed` and `grep` only. Nothing was deployed.

## Defect

During a turn `history_identity` returns None, so the decorated-history cache is off for the whole turn, and every
open, the server's turn read after each tool event included, projects the whole history again on the gateway's one
Python process. `patch`'s whole projection, Hermes's `_history_to_messages` plus the add-on's per-tool-row second
projection, took 0.92 to 1.15 s with the shell-summary memo warm.

## Change

`ProjectionMemo`, kept in each canonical session's `RowCache`, so a new stored session starts empty:

- `projection_cuts` cuts the history at user rows where no later tool row reads a call (`tool_calls`, last
  definition by ID) named before the cut, the only state Hermes carries from row to row
  (`tui_gateway/session_history.py:297-373`). Calls are read after Hermes's compaction projection, hidden assistant
  rows included, and a call without a name names nothing, as `_remember_tool_call_args` does. A user row is never
  taken to start a turn. Each piece holds at least 64 rows (`PIECE_ROWS`), taken from the start so appended rows
  never move an earlier cut.
- Each piece is projected alone, with its tool rows' second projection. A later open reuses a piece whose rows equal
  the kept copy of its input rows: a cheap key (row IDs, roles, content lengths) finds it, `==` decides. Inputs are
  copied before Hermes projects the copy; projections are copied when kept and on every hit.
- The context key holds the projection's keyword arguments, the `config.yaml` stamps of the profile home and the
  current Hermes home, and `redaction_state()`. Another context empties the memo; no readable redaction state
  memoizes nothing. Only an app open's own activation memoizes, never `experience.py`'s reads.
- After each projection the memo holds exactly that history's pieces, in order, until 128 million characters.
- Shadow mode, `HERMES_AGENT_INTERFACE_PROJECTION_SHADOW=1`, also projects the whole history, answers with it, logs
  the first differing message and tool row, and reports `app_projection_shadow` on the open. Documented in
  `docs/Hosting.md`; `scripts/spike/run.py` turns it on for release qualification.

## Real Hermes

On the production host, with Hermes's own interpreter, on a `.backup` copy of `patch`'s `state.db`, deleted
afterward along with every uploaded file. The display read (`get_messages_as_conversation` with ancestors, row IDs
and compacted rows) returned 8,016 rows, 4,779 of them tool rows, projected to 7,446 messages. Numbers only; no
content was printed.

| Projection | Time |
| --- | --- |
| whole, shell memo cold | 4,023 ms |
| whole, shell memo warm | 1,146 ms, 924 ms |
| memo cold (86 pieces) | 1,411 ms |
| memo warm, each history read fresh from the store | 165 ms, 133 ms, 150 ms |
| memo warm, last 20 rows new, as a turn read sees them | 162 ms (85 of 86 pieces reused) |
| shadow mode, warm | 1,555 ms |

Every memoized output, cold, warm and grown, equaled the whole projection in messages and tool rows, and shadow
mode found no difference. Cutting at every safe turn gave 394 pieces and a cold projection of 1,385 ms against
1,124 ms whole: Hermes loads the profile's configuration once per projection that holds commentary, and 522 rows do.
At 32, 64, 128 and 256 rows the pieces took 1,155, 1,108, 1,058 and 1,032 ms; 64 is the smallest no slower than whole.
The memo for this history counts 61.7 million characters and held 110.3 MB (`tracemalloc`, from before the read),
on a host with 7.7 GB and 4.5 GB available. The display read itself still takes 0.96 to 1.56 s and is unchanged.

## Tests and red runs

`tests/hermes_projection_memo_test.py`: the fake native projection labels tool rows from the last call named with
their ID, hidden rows included, and reads the profile's language from `config.yaml`. The answer with no readable
redaction state, which never memoizes, is the whole projection every memoized answer must equal, through a steer
row inside a tool batch, a hidden assistant row's call read after a steer, a reused call ID read a turn later, an
appended turn, an appended row, a same-length middle-row edit, a flush stamping a row ID in place, a same-length
in-place edit, and a compaction rewrite.

`python3 .agents/tools/mutate-py.py --batch` against `python3 tests/hermes_projection_memo_test.py`:

| Mutation | Result |
| --- | --- |
| cut wherever a user row is | failed: test_what_a_projection_reads_besides_its_rows_projects_again (exit 1) |
| hidden rows name no calls | failed: test_what_a_projection_reads_besides_its_rows_projects_again (exit 1) |
| a tool row uses up its call | failed: test_what_a_projection_reads_besides_its_rows_projects_again (exit 1) |
| calls read before compaction projection | failed: test_a_history_is_cut_only_at_user_rows_no_later_tool_row_reads_across (exit 1) |
| non-mapping row read | failed: test_a_history_is_cut_only_at_user_rows_no_later_tool_row_reads_across (exit 1) |
| no input snapshot | failed: test_a_memoized_open_answers_as_a_whole_projection_through_every_change (exit 1) |
| kept projection handed out | failed: test_decoration_never_reaches_a_kept_projection (exit 1) |
| projection kept uncopied | failed: test_decoration_never_reaches_a_kept_projection (exit 1) |
| cheap key decides | failed: test_a_memoized_open_answers_as_a_whole_projection_through_every_change (exit 1) |
| arguments not in context | failed: test_what_a_projection_reads_besides_its_rows_projects_again (exit 1) |
| config not in context | failed: test_what_a_projection_reads_besides_its_rows_projects_again (exit 1) |
| redaction not in context | failed: test_what_a_projection_reads_besides_its_rows_projects_again (exit 1) |
| memoized without redaction state | failed: test_a_memoized_open_answers_as_a_whole_projection_through_every_change (exit 1) |
| no budget | failed: test_a_history_beyond_the_budget_keeps_its_first_pieces_and_projects_the_rest (exit 1) |
| a new stored session keeps its row cache | failed: test_a_new_stored_session_starts_an_empty_memo (exit 1) |
| shadow answers with the memo | failed: test_shadow_mode_answers_with_the_whole_projection_and_says_where_the_memo_differs (exit 1) |
| shadow on whatever the value | failed: test_shadow_mode_is_off_unless_set (exit 1) |
| unnamed call counts as named | failed: test_a_history_is_cut_only_at_user_rows_no_later_tool_row_reads_across (exit 1) |
| pieces of any size | failed: test_each_piece_but_the_last_holds_the_least_rows_and_rows_added_later_move_no_cut (exit 1) |
| least counted from the start | failed: test_each_piece_but_the_last_holds_the_least_rows_and_rows_added_later_move_no_cut (exit 1) |

The snapshot mutant first survived: a flush's `_row_id` stamp changes the cheap key, so it misses without the copy.
The test now also edits a live row in place under the same ID and length, which only the copy catches.

## Release qualification

`scripts/spike/extension_probe.py` asserts, after two appended tool turns and again after steering, approvals,
clarification, files and images, that two opens past the decorated cache report no difference and that the second
reuses pieces. `scripts/spike/compaction_probe.py` asserts the same after Hermes's in-place compaction commits.
A middle-row edit is not expressed there: no RPC edits a middle row, and writing the disposable `state.db` directly
would bypass Hermes's own writer, its read pool and `display_identity`, a state Hermes never produces. The unit
tests cover it. Not run: release qualification and the running gateway.

## One budget for the gateway

Review of the consolidated branch found the 128 million character budget applied per canonical session, and counted
only input rows: at about 1.8 bytes per character, three to five long chats could keep 0.5 to 1 GB in the Hermes
process for as long as their sessions stayed canonical. `ProjectionBudget` now holds one budget of 192 million
characters for every memo in the gateway, counting each kept piece's input rows, projection and tool rows
(`text_size` now counts tuples). After each projection the memos used least recently empty until the total fits.

`python3 .agents/tools/mutate-py.py --batch` against `python3 tests/hermes_projection_memo_test.py`:

| Mutation | Result |
| --- | --- |
| no shared charge | failed: test_a_projection_empties_the_memo_used_least_recently_once_the_gateway_passes_its_budget (exit 1) |
| most recently used empties first | failed: test_a_projection_empties_the_memo_used_least_recently_once_the_gateway_passes_its_budget (exit 1) |
| rows only counted | failed: test_kept_projections_and_tool_rows_count_toward_the_budget (exit 1) |
| tuples not counted | failed: test_kept_projections_and_tool_rows_count_toward_the_budget (exit 1) |

A first version of the tests let three of these survive: two memos cannot tell least from most recently used, and
fixture rows without row IDs collided on the memo's cheap key and re-projected whatever the budget. The tests use
three memos and rows with IDs. A guard that kept the projecting memo from emptying itself was unreachable and is gone.
