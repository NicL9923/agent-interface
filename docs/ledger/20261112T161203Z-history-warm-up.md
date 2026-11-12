# November 12 a background warm-up projects each recent assistant's history after a restart

Branch `t3/warm-projection-memo` over `origin/main` at `7a2c54e1`, on NicolasLaptop (Fedora 44, Linux x64), Python
3.14.10. Source fingerprint of `src/hermes`, `tests/hermes_history_warmup_test.py` and
`tests/hermes_projection_memo_test.py`: `sha256:744cd5801a5f64d6ae118e2333bfe71653e50733cf2c42041ddd0cbb8382133a` (22 source files). Hermes `ed1afb0`, read from a local clone of upstream at that
revision; on the production host only `sed` and `grep` read its launcher and bootstrap. Nothing was deployed and no
service was restarted.

## Defect

`.agents/tools/measure-chat-open.mjs` after the `e95e0df` deployment: steady-state opens took 30 to 400 ms, but right
after a gateway restart `patch` (323 messages in the window, about 8,800 display rows) took 10.9 s on its first open
(`addon-activate` 7.7 s, `addon-decorate` 2.6 s), 4.4 s on its second (activate 3.8 s) and 0.3 s on its third.

Why the second open was still slow: after a restart no session is canonical, so the first open goes through
`session.resume` instead of `session.activate`. The add-on set the projection memo only around activation, so the
resume projected the whole history with no memo. It also asked for `inline_images: False`, which Hermes passes on as
`image_urls=False` (`tui_gateway/methods_session.py:611-624`, `:670-673`), while activation always projects with image
URLs (`methods_session.py:1152-1164`, `tui_gateway/session_registry.py:790-815`). So even a memoized resume would have
had another projection context, which empties the memo. The second open then filled an empty memo from scratch, and
only the third, idle, hit the decorated-history cache. Nothing expired; the first open filled nothing the second
could use.

## Change

- The first open's resume projects through the canonical session's RowCache, which later opens keep: the one the
  warm-up filled for that profile and stored session, or a new one. It no longer asks for `inline_images: False`, so
  it projects as every later open does, and the first open after a restart shows images as every later one does.
- `Bridge.start_warmup`, called last in `install()`, starts one daemon thread two seconds later. It takes the six
  profiles with the most recent app receipts, finds each one's "Bot Chat" compression tip read-only, as
  `profiles.list` does, and reads its display history as activation does (ancestors, row IDs, compacted rows). It
  projects that history into a RowCache keyed by profile and stored session, with the projection arguments Hermes's
  resume and activation use, then parses the session's journal tool records into the same cache.
- It works under the profile's lock, the one every open takes, so the memo has one user at a time. Before each piece,
  and each 256 tool records, it sleeps 5 ms and checks for live work: an open running or waiting for its lock (now
  counted in `open_bot`, which every open path goes through), an add-on read or send in its lane or admitting, or any
  native session marked running or holding queued input. On live work it lets go of the lock, keeping what it did,
  waits until the gateway is quiet and starts over, reading the store again only when its file or WAL stamp changed.
  An open in the meantime adopts the partial cache and projects only the rest. A chat an open already made live is
  left alone.
- `ProjectionMemo.project` takes `pause` and `limit`. The warm-up's limit is the room other memos leave, so it never
  empties one, and it stops at the first chat that does not fit.
- `HERMES_AGENT_INTERFACE_WARM_HISTORY=0` turns it off. A Hermes without `SessionDB` and its title, tip and compacted
  display reads, `hermes_cli.profiles.get_profile_dir`, the compaction display projection or readable redaction
  state logs one warning naming what is missing and warms nothing. Failures log the exception type only.

## Real Hermes

On the production host, with Hermes's own interpreter (`python-3.14.9+20261021`) and its installed dependency
environment, on `sqlite3 .backup` copies of `patch`'s `state.db` and the add-on journal in a `mktemp -d` directory,
deleted afterward. The script built a Bridge with only the attributes these paths use and Hermes's own
`_history_to_messages` and compaction display projection from `tui_gateway.server`, and ran this branch's code. Each
mode ran in a fresh process, so the shell summary memo started empty, as after a restart. Numbers only; no content
was printed. Two runs each:

| Step | Today | Warmed |
| --- | --- | --- |
| Warm-up in the background (read, projection with pauses, records) | - | 8.7 s, 9.8 s |
| First open: resume's display read | 1.24 s, 1.24 s | 1.18 s, 1.37 s |
| First open: projection | 5.45 s, 5.75 s (whole, no memo) | 0.15 s, 0.18 s (86 of 86 pieces reused) |
| First open: original rows and attribution | 0.76 s, 0.73 s | 0.29 s, 0.32 s |
| First open, add-on work | 7.5 s, 7.7 s | 1.6 s, 1.9 s |
| Second open: activation read and projection | 3.1 s, 2.9 s (empty memo) | 1.4 s, 1.5 s (86 of 86 reused) |

The resume's and activation's display reads returned equal rows (8,021). The warmed projection equalled the add-on's
whole projection of the same rows. The memo kept 113.7 million characters, within the 192 million budget. Parsing the
chat's 4,131 journal tool records took 0.33 to 0.44 s and attribution dropped from 0.53 to 0.81 s cold to 0.05 to
0.08 s with them parsed. What remains is Hermes's display read, about 1.2 s, which a live session's decorated-history
cache avoids only from the second open on.

## Tests and red runs

`tests/hermes_history_warmup_test.py`: a fake Hermes after a restart, with a read-only `SessionDB` over each
profile's rows that raises on any other read or a writable open, profile directories and `state.db` files on disk,
and a native projection that records the rows and thread of each call. It covers the second open after a restart,
adoption by the first open, warmed tool records, an open arriving mid-warm-up (no piece projected twice), an open
already under way, an open finishing during the warm-up's read, waiting for a turn, reading again only after a
write, every kind of live work, record parsing stepping aside, the budget room and the stop, a retry within a tight
budget, target choice, the off switch, each missing seam, and a failure that logs no history. Sixteen parallel runs
of the file passed.

`python3 .agents/tools/mutate-py.py --batch` against `python3 tests/hermes_history_warmup_test.py`:

| Mutation | Result |
| --- | --- |
| first open resumes without image URLs | failed: test_a_first_open_adopts_the_warmed_history_and_projects_nothing (exit 1) |
| first open resumes without the memo | failed: test_a_first_open_adopts_the_warmed_history_and_projects_nothing (exit 1) |
| resumed memo not kept for the session | failed: test_a_first_open_adopts_the_warmed_history_and_projects_nothing (exit 1) |
| warmed cache not adopted | failed: test_a_first_open_adopts_the_warmed_history_and_projects_nothing (exit 1) |
| memo keeps nothing when a pause stops it | failed: test_warming_keeps_within_the_room_other_memos_leave_and_stops_when_it_runs_out (exit 1) |
| a pause never yields | failed: test_an_open_arriving_mid_warm_up_takes_over_and_no_piece_is_projected_twice (exit 1) |
| a full budget never stops a pause | failed: test_warming_keeps_within_the_room_other_memos_leave_and_stops_when_it_runs_out (exit 1) |
| a full budget counts as warmed | failed: test_the_most_recent_assistants_are_warmed_first_until_the_budget_is_full (exit 1) |
| warming goes on past a full budget | failed: test_the_most_recent_assistants_are_warmed_first_until_the_budget_is_full (exit 1) |
| warm-up keeps up to the whole budget | failed: test_the_most_recent_assistants_are_warmed_first_until_the_budget_is_full (exit 1) |
| memo ignores the limit | failed: test_the_most_recent_assistants_are_warmed_first_until_the_budget_is_full (exit 1) |
| a piece that did not fit leaves full unset | failed: test_the_most_recent_assistants_are_warmed_first_until_the_budget_is_full (exit 1) |
| room counts the memo itself | failed: test_a_warm_up_that_stepped_aside_still_fits_what_it_kept_before (exit 1) |
| no wait for live work before reading | failed: test_an_open_already_under_way_keeps_its_chat_and_the_warm_up_reads_nothing (exit 1) |
| no check for a live chat before reading | failed: test_an_open_already_under_way_keeps_its_chat_and_the_warm_up_reads_nothing (exit 1) |
| no check for a live chat under the lock | failed: test_an_open_finishing_while_the_warm_up_reads_leaves_it_nothing_to_project (exit 1) |
| history never read again | failed: test_the_warm_up_waits_for_a_turn_and_reads_again_only_what_the_turn_changed (exit 1) |
| history read on every try | failed: test_the_warm_up_waits_for_a_turn_and_reads_again_only_what_the_turn_changed (exit 1) |
| tool records not warmed | failed: test_the_first_open_parses_no_tool_record_the_warm_up_parsed (exit 1) |
| record steps never step aside | failed: test_record_parsing_steps_aside_too (exit 1) |
| every stored session's records | failed: test_the_first_open_parses_no_tool_record_the_warm_up_parsed (exit 1) |
| open not counted | failed: test_an_open_already_under_way_keeps_its_chat_and_the_warm_up_reads_nothing (exit 1) |
| live work ignores opens | failed: test_an_open_already_under_way_keeps_its_chat_and_the_warm_up_reads_nothing (exit 1) |
| live work ignores lanes | failed: test_live_work_is_any_open_app_request_send_or_working_session (exit 1) |
| live work ignores sends admitting | failed: test_live_work_is_any_open_app_request_send_or_working_session (exit 1) |
| live work ignores native sessions | failed: test_live_work_is_any_open_app_request_send_or_working_session (exit 1) |
| off switch ignored | failed: test_the_off_switch_starts_nothing_and_checks_nothing (exit 1) |
| missing SessionDB not named | failed: test_a_hermes_without_what_the_warm_up_reads_warms_nothing_and_says_what_is_missing_once (exit 1) |
| missing SessionDB reads not named | failed: test_a_hermes_without_what_the_warm_up_reads_warms_nothing_and_says_what_is_missing_once (exit 1) |
| display read signature not checked | failed: test_a_hermes_without_what_the_warm_up_reads_warms_nothing_and_says_what_is_missing_once (exit 1) |
| missing profile directories not named | failed: test_a_hermes_without_what_the_warm_up_reads_warms_nothing_and_says_what_is_missing_once (exit 1) |
| missing compaction projection not named | failed: test_a_hermes_without_what_the_warm_up_reads_warms_nothing_and_says_what_is_missing_once (exit 1) |
| missing redaction state not named | failed: test_a_hermes_without_what_the_warm_up_reads_warms_nothing_and_says_what_is_missing_once (exit 1) |
| failure logs the exception's text | failed: test_a_failed_warm_up_logs_no_history (exit 1) |
| oldest send first | failed: test_the_most_recent_assistants_are_warmed_first_until_the_budget_is_full (exit 1) |
| no limit on targets | failed: test_targets_are_the_assistants_sent_to_most_recently_with_a_canonical_chat_on_disk (exit 1) |
| an invalid profile name stops the targets | failed: test_targets_are_the_assistants_sent_to_most_recently_with_a_canonical_chat_on_disk (exit 1) |
| an empty store is read | failed: test_targets_are_the_assistants_sent_to_most_recently_with_a_canonical_chat_on_disk (exit 1) |
| an archived chat is warmed | failed: test_targets_are_the_assistants_sent_to_most_recently_with_a_canonical_chat_on_disk (exit 1) |
| the chat's root, not its tip | failed: AssertionError: not the display read an open makes (exit 1) |
| the launch home named as a profile home | failed: test_a_first_open_adopts_the_warmed_history_and_projects_nothing (exit 1) |
| display read without compacted rows | failed: AssertionError: not the display read an open makes (exit 1) |

A lint fix then restructured the turn and retry tests; their three mutants were run again and failed the same way.
The 5 ms sleep between steps has no test: removing it changes only how often other threads run. Not mutated: a
decrement of the open counter left out, which hangs the warm-up rather than failing a test.

## Checks

`.agents/tools/check-all` passed all seven checks: typecheck, lint, ruff, 211 test files with 3,883 tests, build,
55 e2e tests and 52 Python test files.

Not exercised: the running gateway, release qualification, and the warm-up's effect on a live turn's latency. The
measurement ran the warm-up alone; on the gateway it waits while any turn runs, and Hermes's display read, about
1.2 s for `patch`, runs between checks and cannot step aside midway.

## Review fixes

An independent review of PR #375 (Claude Opus 5.5, fresh context; GPT-6.1 Sol and Grok were out of usage and
Nicolas approved Claude reviewers) found no correctness bug and five issues, all fixed on the same branch:

1. **A warm-up's charge ranked as recently used.** An open of A, then the warm-up filling B, then an open of an
   unwarmed C emptied A. `ProjectionBudget.charge` now takes `background`: the warm-up's charges, its stops
   included, rank below every memo an open used, until an open adopts the cache and charges it as an open.
2. **Unadopted warm caches stayed in memory.** Their tool results and journal records sat outside the budget.
   When the budget empties a warmed memo nobody adopted, its `on_empty` drops the whole cache. A profile's other
   warm caches, such as one of a tip a compaction replaced, are dropped when its first open resumes. The callback
   holds the cache weakly: a strong one made a reference cycle that kept a dropped cache's size in the budget.
3. **Deliveries did not make the warm-up step aside.** `open_canonical` took the profile's lock before
   `open_bot` counted the open. Both now count from before they wait for the lock (`Bridge.opening`).
4. **Unpaused steps.** The warm-up no longer decorates through `detailed_history`, which parsed every tool row
   at once. It projects through the memo itself and parses tool rows 256 a step (`WARM_STEP`, shared with
   journal records). The memo now pauses before every piece, reused ones included. Still unpaused: the cut
   computation once per pass and Hermes's display read.
5. **Older Hermes and failures.** The seam check now requires `SessionDB(db_path, read_only)`. A profile whose
   store cannot be read, or whose warm-up raises, is logged by name and exception type and skipped; the others
   are warmed. An unreachable redaction guard inside `warm` was removed: the seam check already requires
   readable redaction state.

The first open's image URLs were accepted by the orchestrating agent as a consistency fix, and Nicolas was told.

`python3 .agents/tools/mutate-py.py --batch` against `python3 tests/hermes_history_warmup_test.py`:

| Mutation | Result |
| --- | --- |
| a warm-up's charge ranks as an open's | failed: test_a_warmed_cache_the_budget_empties_is_forgotten (exit 1) |
| a projection's charge never in the background | failed: test_a_warmed_cache_the_budget_empties_is_forgotten (exit 1) |
| a stopped projection's charge never in the background | failed: test_a_warm_up_waiting_out_a_turn_still_empties_first (exit 1) |
| the warm-up projects as an open | failed: test_a_warmed_cache_the_budget_empties_is_forgotten (exit 1) |
| an emptied memo tells nobody | failed: test_a_warmed_cache_the_budget_empties_is_forgotten (exit 1) |
| an emptied warm cache is kept | failed: test_a_warmed_cache_the_budget_empties_is_forgotten (exit 1) |
| a warm cache keeps itself alive | failed: test_a_warm_up_that_stepped_aside_still_fits_what_it_kept_before (exit 1) |
| an earlier tip's warm-up is kept | failed: test_a_warm_up_of_an_earlier_tip_is_dropped_when_the_chat_goes_live (exit 1) |
| a delivery waits for its lock uncounted | failed: test_an_open_arriving_mid_warm_up_takes_over_and_no_piece_is_projected_twice (exit 1) |
| a pause only before pieces projected anew | failed: test_a_pause_comes_before_every_piece_reused_or_not (exit 1) |
| tool rows parsed without stepping aside | failed: test_tool_row_parsing_steps_aside_too (exit 1) |
| tool rows not warmed | failed: test_tool_row_parsing_steps_aside_too (exit 1) |
| a store that opens only writable is not named | failed: test_a_hermes_without_what_the_warm_up_reads_warms_nothing_and_says_what_is_missing_once (exit 1) |
| one assistant's failure stops the warm-up | failed: test_an_assistant_that_fails_is_skipped_and_logs_no_history (exit 1) |
| one store that cannot be read stops the targets | failed: test_an_assistant_that_fails_is_skipped_and_logs_no_history (exit 1) |

The stopped-charge mutant first survived; the new test holds the warm-up in a turn while another open charges. Its
first version hung the mutant run, because a failed assertion left the turn running; it now ends the turn in
`finally`. Five earlier mutants whose lines the refactor moved were run again and failed as before: memo keeps
nothing when a pause stops it, a pause never yields, a full budget never stops a pause, warm-up keeps up to the
whole budget, and memo ignores the limit.

The production measurement above predates these fixes. They change only when the warm-up pauses and what it keeps,
not what it projects or parses.

With the fixes, the same fingerprint scope is `sha256:171b1c373dc139e2bedfa91506d2976cc344240a846bfe2206a7a74bf6e2e7bd`. `.agents/tools/check-all` passed all seven checks again:
211 test files with 3,883 tests, 55 e2e tests and 52 Python test files.

## Re-review fixes

A re-review of `62637083` (Claude Opus 5.5, fresh context, scoped to the fix commit) confirmed fixes 1, 2, 3 and 5
and found a regression from fix 4: with a pause before every piece, a stop during a pass over reused pieces kept
only the pieces that pass had reached. A warm-up that stepped aside after finishing its projection walked every
piece again, and an open arriving partway dropped every warmed piece after that point. The reviewer reproduced it:
six pieces warmed, a stop at the second pause of the next pass, one piece left.

- On a stop the memo keeps the pieces it walked, then the kept pieces it had not reached, in order, within the
  limit. Its size is recounted.
- A warm-up that steps aside after its projection finished does not walk the pieces again on its retry, while
  the cache and the history it read are the same. This changes only how long the retry takes and has no test.
- `MemoryError` stops the warm-up instead of skipping one assistant, in the loop and in `warm_targets`.
- If another open's charge empties the warm memo and drops its cache during a step, `warm` returns False: the
  assistant is not counted, and warming stops as it does on a full budget.

`python3 .agents/tools/mutate-py.py --batch` against `python3 tests/hermes_history_warmup_test.py`:

| Mutation | Result |
| --- | --- |
| a stop keeps only the pieces it walked | failed: test_a_stop_partway_through_reused_pieces_keeps_every_piece (exit 1) |
| a stop keeps unreached pieces past the limit | failed: test_a_stop_partway_through_reused_pieces_keeps_every_piece (exit 1) |
| a dropped cache counts as warmed | failed: test_a_warm_up_whose_cache_another_open_drops_is_not_counted (exit 1) |
| out of memory skips one assistant | failed: test_running_out_of_memory_stops_the_warm_up (exit 1) |
| out of memory skips one store | failed: test_running_out_of_memory_stops_the_warm_up (exit 1) |

The limit mutant first survived; the test now also stops a pass whose limit shrank to two pieces.
`test_a_warm_up_stepping_aside_on_a_grown_history_projects_only_what_is_new` covers the same stop through a whole
warm-up: a turn starts as it reads a history grown by one turn, and its retry projects only that turn.

Fingerprint `sha256:e7c03b46cded8a8f96e4495d040d97bc0d85b4f2ef4e937144f1c7d5fa7496be` over the same scope. `.agents/tools/check-all` passed all seven checks: 211 test files with
3,883 tests, 55 e2e tests and 52 Python test files.
