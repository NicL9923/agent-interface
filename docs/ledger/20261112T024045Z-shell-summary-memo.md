# November 12 the add-on keeps Hermes's shell summary answers

Branch `t3/36e26aad` over `origin/main` at `1e3cb31`, on NicolasLaptop (Fedora 44, Linux x64), Python 3.14.10.
Source fingerprint of `src/hermes` and `tests/hermes_shell_summary_test.py` with the change applied:
`sha256:5e0a109760edd4ac4de44ba2ff9f048ea31f0d3782010d62eb0c999f1938d85c` (21 source files). Hermes `ed1afb0`, read
on the production host with `sed` and `grep` only. Nothing was deployed.

## Defect

`.agents/tools/measure-chat-open.mjs` on the production host (release `f30d06d`) timed `patch`'s first page at 6.3 s
and 6.8 s on consecutive reads, `addon-activate` 5.6 s and 6.1 s of it. Its canonical session holds 8,805 rows,
5,266 of them tool rows. Other assistants took 0.1 to 0.8 s.

Profiled with Hermes's own interpreter on a `.backup` copy of `patch`'s `state.db`, deleted afterward: the display
read took 1.26 s and `_history_to_messages` 4.45 s. Of the projection, `summarize_shell_command` took most: Hermes
labels each of the 2,420 shell commands on every projection, and `_split_shell_words` and `_scan_quoted` walk each
command character by character several times (9.0 million `_scan_quoted` steps).

## Change

`memoize_shell_summary` wraps the four helpers `summarize_shell_command` calls, `_split_shell_compound`,
`_clean_shell_segment`, `_shell_head_word` and `_is_shell_boundary_echo`, in `TextMemo`: answers to repeated strings
within a 4 million character budget per helper, least recently used first out, a list answer returned as a new list.
`summarize_shell_command` stays native because it translates with the profile's language. A missing helper is named
in a warning and opens run as before.

## Real Hermes

On the same copy, with `TextMemo` and `memoize_shell_summary` taken from this source: projection output identical
with and without the memo (7,446 messages), projection 4.78 s plain, then 2.22 s, 0.89 s and 0.76 s with the memo.
The helpers kept 2.04, 1.99, 0.71 and 0.68 million characters.

## Red runs

`python3 .agents/tools/mutate-py.py --batch` against `python3 tests/hermes_shell_summary_test.py`:

| Mutation | Result |
| --- | --- |
| no memo installed | failed: test_a_repeated_command_is_parsed_once_with_the_same_summary (exit 1) |
| cache never answers | failed: test_a_repeated_command_is_parsed_once_with_the_same_summary (exit 1) |
| list answer shared | failed: test_a_list_answer_is_a_new_list_each_time (exit 1) |
| no eviction | failed: test_the_least_recently_used_answer_leaves_first_within_the_budget (exit 1) |
| FIFO not LRU | failed: test_the_least_recently_used_answer_leaves_first_within_the_budget (exit 1) |
| no long-text bypass | failed: test_a_string_too_long_to_keep_and_anything_not_a_string_go_to_the_function_each_time (exit 1) |
| double wrap | failed: test_installing_again_keeps_one_memo (exit 1) |
| missing not warned | failed: test_a_missing_helper_is_named_and_the_rest_are_kept (exit 1) |

## Checks

`.agents/tools/check-all` passed, with 50 Python test files. Not exercised: release qualification and the running
gateway. The decorated-history cache still missed twice in a row for an idle `patch` before it hit; that is not
changed here.
