# November 21 review fixes for the WebKit routes, CI container and check-all work

Code state: branch `t3/fix-webkit-ci-checks`, the fixes in `7faf141a`, `6780c710` and `a0bc4f8f`
on top of `81866862`, whose own record is
[20261121T045752Z-webkit-routes-ci-container.md](20261121T045752Z-webkit-routes-ci-container.md).
An independent review of `af8d1c38..81866862` raised one blocker and seven fixes. The dispatched
Checks run 44868697577 on `38d296b5`, the branch merged into `t3/followups-459-462`, passed every
job: Browser smoke (chromium) in 9 minutes 4 seconds and Browser smoke (webkit) in 8 minutes 32
seconds.

## What changed

| Finding                                                                                                                                          | Change                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. The workflow checker's line patterns let a next-line `container` value and double-quoted, escaped `services`, `image` and `uses` keys through | `tests/workflows.test.ts` parses each workflow with `yaml` 2.9.1 and checks every `runs-on`, `uses`, `container` and `services` key at any depth. `yaml` was already in the lockfile through lint-staged and Vite and is now a direct development dependency, listed in `docs/Dependencies.md` |
| 2. A container podman could not remove kept a timed-out run waiting on the output pipe                                                           | `run_process` reads output on its own thread, and for at most 5 seconds after a stop. A failed removal is logged and printed under the table with the container's name and the `podman rm --force` command                                                                                     |
| 3. The route guard missed a `context` fixture override and `browser.newContext()` contexts                                                       | A worker-scoped auto fixture replaces `route` and `routeFromHAR` on Playwright's `BrowserContext` and `Page` classes before any test fixture runs, and each call reads its own context's `serviceWorkers` option                                                                               |
| 4. The lint rule missed a re-exporting helper, a default import, `playwright/test`, and `e2e/*.test.ts`                                          | The rule covers every file in `e2e/` and refuses every value import from `@playwright/test` and `playwright/test`; type-only imports stay allowed and `fixtures.ts` is the one exception                                                                                                       |
| 5. A stale digest passed after a version bump                                                                                                    | `.github/playwright-image-digests.json` records each version's digest. The job's image must carry the digest recorded for the installed version, and a version with no digest fails with the `skopeo inspect` command                                                                          |
| 6 and 7. Docker left a rootful container running after a kill, and rootless docker could not write the checkout                                  | check-all uses podman only and refuses without it, naming podman as the fix                                                                                                                                                                                                                    |
| 8. A timed-out WebKit probe killed Node and left the browser it launched                                                                         | The probe runs in its own process group; a timeout sends SIGINT, which makes Playwright close its browser, then kills the group after 5 seconds                                                                                                                                                |
| The test named for both halves failing failed only Chromium                                                                                      | It fails both halves now and checks both rows and the verdict                                                                                                                                                                                                                                  |

## Red runs

Against the code as committed at `81866862`:

- The new route guard spec in Chromium: the browser-made context and the `context` fixture
  override cases failed; the other 2 passed.
- The new lint rule's four bypass files (a re-exporting helper, a default import, a named
  import from `playwright/test`, a direct import in `e2e/*.test.ts`) all linted clean under
  the old rule and all failed under the new one. A type-only file passed both.
- A run of the new check-all tests for a failed removal, a hung probe, both halves failing and
  podman's absence against the old code was still running at a 300 second limit and was killed:
  the failed-removal case hangs the old code, as the review reported.

Hand breaks of the new code, each restored afterwards:

| Guard                           | Break                                   | Result                                          |
| ------------------------------- | --------------------------------------- | ----------------------------------------------- |
| Workflow checker                | `services` allowed                      | 2 failed: both service cases                    |
| Workflow checker                | a container given as a string skipped   | 2 failed: the one-line and next-line cases      |
| Workflow checker                | `uses` not checked                      | 4 failed, the escaped-key case among them       |
| Workflow checker                | the recorded digest not compared        | 1 failed: the installed tag with another digest |
| Workflow checker                | a missing digest not refused            | 1 failed: the version mismatch test             |
| Workflow checker                | keys read one level deep only           | every nested case failed                        |
| `checks.yml`                    | a digest that is not the recorded one   | the real-workflow test failed                   |
| `playwright-image-digests.json` | no digest for the installed version     | 4 failed, the digest record test among them     |
| Route guard                     | the context's `serviceWorkers` not read | 3 failed                                        |
| Route guard                     | pages not guarded                       | 1 failed                                        |
| Route guard                     | routes refused even when blocked        | 2 failed                                        |
| Route guard                     | `routeFromHAR` not guarded              | 1 failed                                        |

Python breaks of `.agents/tools/check_all.py` through `python3 .agents/tools/mutate-py.py`, with
a passing baseline. The three removal rows ran again against the final form of their test:

| Mutation                                      | Result                                                                                                                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a stopped check's output read without a bound | failed: `test_a_container_podman_cannot_remove_neither_holds_a_stopped_run_nor_goes_unreported`. Against an earlier form of that test, which called check-all in process, the mutant hung past 150 seconds; the test now runs check-all as a child with a deadline |
| a failed removal left off the summary         | failed: the same test                                                                                                                                                                                                                                              |
| a failed removal not logged                   | failed: the same test                                                                                                                                                                                                                                              |
| podman rm's exit code ignored                 | failed: the same test                                                                                                                                                                                                                                              |
| a hung probe's Node killed alone              | failed: `test_a_hung_probe_stops_the_browser_it_launched_in_its_own_group`                                                                                                                                                                                         |
| docker accepted when podman is absent         | failed: `test_webkit_that_cannot_start_and_no_podman_refuse_before_anything_runs_even_with_docker`                                                                                                                                                                 |
| `podman rm` without `--ignore`                | failed: `test_a_check_timeout_removes_the_container_before_the_locks_free`                                                                                                                                                                                         |

## Checks at `a0bc4f8f`

| Check                                                                      | Result                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                        | Compiled                                                                                                                                                                                                                            |
| `npm run lint`                                                             | Passed                                                                                                                                                                                                                              |
| `npx vitest run tests/workflows.test.ts`                                   | Unit-passed: 21 tests                                                                                                                                                                                                               |
| `python3 tests/check_all_test.py`                                          | Unit-passed: 111 tests                                                                                                                                                                                                              |
| `e2e/route-guard.spec.ts`, Chromium on the host                            | Runtime-exercised: 4 passed                                                                                                                                                                                                         |
| `e2e/route-guard.spec.ts`, WebKit in the Playwright container              | Runtime-exercised: 4 passed                                                                                                                                                                                                         |
| `~/.agents/tools/linux-heavy-lock.sh .agents/tools/check-all --keep-going` | All 8 rows passed in 19m00s after 20 minutes in the machine lock queue: 229 files and 4204 Vitest tests, 911 modules built, e2e:chromium 146 tests in 7m13s, e2e:webkit (podman) 146 tests with 3 skipped in 4m53s, 52 Python files |

## Not done

- The route guard reads `_options`, which Playwright does not document. If an upgrade moves it,
  every route fails with a message naming the guard to update, rather than passing unguarded.
- No real podman removal failure was produced; the failed-removal path ran against the fake.
