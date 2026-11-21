# November 21 second review fixes for check-all, the probe and the e2e lint rule

Code state: branch `t3/fix-webkit-ci-checks`, the fixes in `b64042e2` and `e1c0a51d` on top of
`0093af25`, whose round is recorded in
[20261121T053039Z-webkit-ci-review-fixes.md](20261121T053039Z-webkit-ci-review-fixes.md). The
second review covered `81866862..0093af25`. It found one regression, four smaller issues and two
items the orchestrator declined.

## What changed

| Finding                                                                                                                                                           | Change                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. A command that exited early while another process held its output pipe waited for the pipe without limit, with its timeout cancelled, so its locks stayed held | After the command exits, its output is read for at most 5 seconds, the same bound as after a stop. Past that, the stop a timeout makes runs for what is left, which removes a container still holding the pipe, and the locks free                      |
| 2. A cut-off check lost its buffered log, and a missing summary looked like a clean result                                                                        | The log is closed with what the check printed however reading ends. A row whose output was cut short says `output cut short`, before its counts or `counts unknown`                                                                                     |
| 3. The failed-removal test allowed 16 seconds                                                                                                                     | It allows 240. It only has to tell a run from a 600 second hang                                                                                                                                                                                         |
| 4. The probe left a child of Node's group alive after Node exited, and a browser that hung at launch                                                              | Node's group is stopped every time Node ends. The launch carries Playwright's own 45 second timeout, which kills the browser's separate group, paused at launch or not, and Node exits once its answer is written instead of lingering about 30 seconds |
| 5. Oxlint accepted a direct import in a `.spec.js`                                                                                                                | The rule covers every file under `e2e/`, and `playwright.config.ts` sets `testMatch: "**/*.spec.ts"`                                                                                                                                                    |
| Declined: a `browser` fixture override, `createRequire`, a helper outside `e2e/`                                                                                  | The route guard's comment says what it covers and that deliberate ways around it are out of scope                                                                                                                                                       |
| Declined: a wrong digest copied into both the record and the workflow                                                                                             | The workflow test's comment says the browser jobs fail at launch on the first push to main                                                                                                                                                              |

The probe's handling of a paused browser was checked by hand before the change: Playwright's launch
timeout killed a fake browser that stops itself as it starts, and Node then stayed about 30
seconds before it exited. With the change, the real probe script answered in 2.4 seconds and the
browser was gone. A Python test now runs that case under the real Node and Playwright; it skips
where `@playwright/test` is not installed, as in the CI Python job.

## Red runs

New tests against `0093af25`:

| Test                                                                                                                                                                          | Result on `0093af25`                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `test_a_check_that_exits_while_another_process_holds_its_output_frees_its_locks_and_keeps_its_log` (the reviewer's case: an early exit while a detached child holds the pipe) | Error: check-all was still waiting at the 240 second deadline |
| `test_a_passing_check_whose_summary_never_arrived_says_its_output_was_cut_short`                                                                                              | Error: the same hang                                          |
| `test_a_container_left_holding_the_output_after_its_client_exits_is_removed_and_read_to_the_end`                                                                              | Error: the same hang                                          |
| `test_a_container_podman_cannot_remove_neither_holds_a_stopped_run_nor_goes_unreported`, with the new log check                                                               | Failed: the saved log was empty                               |
| `test_a_probe_whose_node_exits_leaves_nothing_in_its_group`                                                                                                                   | Failed: the child outlived the probe                          |
| `test_the_real_probe_ends_a_browser_paused_at_launch_and_answers_at_once`                                                                                                     | Error: the probe had no launch timeout                        |

Mutations of the new code through `python3 .agents/tools/mutate-py.py`, with a passing baseline:

| Mutation                                       | Result                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| the drain after an exit has no bound           | failed: `test_a_check_that_exits_while_another_process_holds_its_output_frees_its_locks_and_keeps_its_log` |
| no stop for what is left after an exit         | failed: `test_a_container_left_holding_the_output_after_its_client_exits_is_removed_and_read_to_the_end`   |
| the log not closed when reading ends           | failed: `test_a_check_that_exits_while_another_process_holds_its_output_frees_its_locks_and_keeps_its_log` |
| a cut-short output not shown in the table      | failed: the same test                                                                                      |
| the probe's group not stopped after Node exits | failed: `test_a_probe_whose_node_exits_leaves_nothing_in_its_group`                                        |
| the probe lingers after it answers             | failed: `test_the_real_probe_ends_a_browser_paused_at_launch_and_answers_at_once`                          |
| the probe gives the launch no timeout          | failed: the same test                                                                                      |

Lint and collection, with six bypass files in `e2e/` that import `test` from `@playwright/test`
(`.spec.js`, `.spec.mjs`, `.spec.cjs`, `.spec.tsx`, `.spec.mts`, `.test.ts`):

- The rule at `0093af25` flagged 2 of them, the `.spec.cjs` and `.test.ts` files. The new rule
  flagged all 6.
- With `testMatch` set, Playwright collected none of them: 292 tests in 12 files with or without
  the six files present.
- Without the bypass files, the suite lists 292 tests in 12 files both before and after the
  `testMatch` change. All 12 spec files are `.spec.ts`.

## Checks at `e1c0a51d`

| Check                                                                      | Result                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                        | Compiled                                                                                                                                                                                                                            |
| `npm run lint`                                                             | Passed                                                                                                                                                                                                                              |
| `npx vitest run tests/workflows.test.ts`                                   | Unit-passed: 21 tests                                                                                                                                                                                                               |
| `python3 tests/check_all_test.py`                                          | Unit-passed: 116 tests                                                                                                                                                                                                              |
| `e2e/route-guard.spec.ts`, Chromium on the host                            | Runtime-exercised: 4 passed                                                                                                                                                                                                         |
| `e2e/route-guard.spec.ts`, WebKit in the Playwright container              | Runtime-exercised: 4 passed                                                                                                                                                                                                         |
| `npx playwright test --list`                                               | 292 tests in 12 files, as before                                                                                                                                                                                                    |
| `~/.agents/tools/linux-heavy-lock.sh .agents/tools/check-all --keep-going` | All 8 rows passed in 18m47s after 74 minutes in the machine lock queue: 229 files and 4204 Vitest tests, 911 modules built, e2e:chromium 146 tests in 5m22s, e2e:webkit (podman) 146 tests with 3 skipped in 5m46s, 52 Python files |

## Not done

- If WebKit hangs past Playwright's own launch timeout, the probe can still leave one idle
  browser process. The probe's comment says so.
- A Playwright upgrade does not by itself make `--py auto` run the real-probe test, since the
  lockfile is not a Python input. Adding it would also run the Python suite on every web-only
  dependency change.
