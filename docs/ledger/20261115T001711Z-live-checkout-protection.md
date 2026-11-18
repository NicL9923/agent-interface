# November 14 live Hermes checkout protection

Branch `t3/protect-hermes-promisor-clone` from `origin/main`, run on the Mac mini with git 2.54 and Python 3.14,
and in an Ubuntu 24.04 container with its git `2.43.0-1ubuntu7.4` and Python 3.12.3. Nothing was deployed, and the
production host was not contacted.

## Change

`scripts/hermes-upgrade-linux.py` sets `gc.auto = 0` and `maintenance.auto = false` in the live checkout's local Git
configuration after the install hook checks out the candidate, and after rollback restores the archived `.git` and its
object store. `qualify-app-release.py` runs `live_clone_refusals` from `src/hermes/qualification.py` against the live
checkout before any other git command reads it and before staging. It refuses when either setting is missing, printing
a shell fix that runs no git there, and when `rev-list --objects --missing=print --no-walk HEAD`, with lazy fetch and
optional locks off, reports a missing object or fails.

## Git 2.43 behavior

In the container, with a `tree:0` promisor clone of a local upstream:

- Blobs missing under a present tree printed as two `?` lines, exit 0. The object count was unchanged afterwards, with
  and without `GIT_NO_LAZY_FETCH`, while upstream was still reachable.
- A missing root tree printed one `?` line, exit 0.
- A missing HEAD commit exited 128 with `fatal: bad object HEAD`.
- With `maintenance.auto = false`, `GIT_TRACE=1 git fetch` started no `git maintenance run --auto`. With the defaults it
  did.

## Application tests

`tests/hermes_upgrade_linux_test.py` (88 tests with `release_app_test.QualificationBrowser`) passed locally and in the
container as a non-root user. Run as root in the container, two existing tests failed, because root can read the file
they make unreadable. `.agents/tools/check-all` ran on the Mac mini; its summary is in the PR.

The first placement of the rollback write came before `restore_baseline_objects`. The existing
`test_rollback_rebuilds_a_lost_object_store_and_clears_stale_git_metadata` failed on it: with `.git/objects` lost,
`git config` exited 128 because Git no longer saw a repository. The write now follows the restore.

## Red runs

`python3 .agents/tools/mutate-py.py --batch`, each mutant against the targeted tests in
`hermes_upgrade_linux_test` (`LiveCheckoutTests` and the install, partial clone and lost-object-store rollback tests),
or `release_app_test.QualificationBrowser` for the host program.

| Mutation                                       | Result                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| install skips the protection                   | failed: test_install_and_rollback_turn_off_automatic_repacks_in_the_live_checkout  |
| rollback skips the protection                  | failed: test_install_and_rollback_turn_off_automatic_repacks_in_the_live_checkout  |
| refuse only when both settings are off         | failed: test_automatic_gc_or_maintenance_is_refused_with_a_one_line_fix_that_works |
| read settings without git's type normalization | failed: test_a_complete_protected_clone_may_be_qualified                           |
| printed fix sets gc.auto to 1                  | failed: test_automatic_gc_or_maintenance_is_refused_with_a_one_line_fix_that_works |
| ignore a listing that failed                   | failed: test_a_head_git_cannot_list_is_refused                                     |
| count no missing objects                       | failed: test_missing_head_objects_are_counted_without_fetching_them                |
| list with --missing=allow-any                  | failed: test_missing_head_objects_are_counted_without_fetching_them                |
| lazy fetch left on                             | survived                                                                           |
| qualification ignores the refusals             | failed: test_operator_qualification_persists_selection_in_private_receipt          |

The survivor is expected. `rev-list --missing=print` turns lazy fetching off by itself, as the container run without
`GIT_NO_LAZY_FETCH` showed, and `git config` never fetches. The variable stays as a guard for later reads added to
these helpers.

## Not exercised

The production host's own git build and live checkout, and a real install or rollback there.

## Review fix

GPT-6.1 Sol's review found that the printed repair assumed `.git/config` ends with a newline: on a valid config
without one, `[gc]` joined the last value, the command succeeded and qualification still refused. The printed line now
starts with a newline, which also leaves an ordinary config valid.

| Mutation                                    | Result                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| The printed fix without its leading newline | failed: `test_the_printed_fix_works_on_a_config_whose_last_line_has_no_newline` |

`LiveCheckoutTests` passed 5 of 5 on macOS (git from Xcode) after the restore.
