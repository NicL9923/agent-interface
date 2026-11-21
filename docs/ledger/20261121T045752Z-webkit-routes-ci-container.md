# November 21 WebKit routes, the Browser smoke container and check-all's WebKit

Code state: branch `t3/fix-webkit-ci-checks`, cut from main at `af8d1c38`. Issue #462 web and CI
items. The Fedora laptop cannot start Playwright's WebKit (no `libicu74` or `libjpeg-turbo8`), so
WebKit ran in `mcr.microsoft.com/playwright:v1.65.0-noble` under Podman, image index digest
`sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe`.

## The failing smoke test

`e2e/smoke.spec.ts:811` failed in WebKit at `af8d1c38`: it waited for "Fence check 24:" and timed
out, because the "on a phone held upright" describe routes the conversation with `page.route`
while the service worker runs. WebKit sends a controlled page's requests through the worker, even
the `/api` requests that `scripts/service-worker.js` leaves to the network, so the route never saw
them. Chromium routed them and passed.

An audit of every `page.route` and `context.route` in `e2e/` found this describe to be the only
one that routes with the worker running. Every other routing describe or file already set
`serviceWorkers: "block"`. The full runs below confirm it, because the new guard fails any other.

## Red runs

| Guard                                                  | Break                                                   | Result                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/fixtures.ts` route guard, before the describe fix | none; the describe still routed with the worker running | Both phone tests failed in Chromium and WebKit in under 300 ms with "page.route(...) cannot see the requests of a page the service worker controls in WebKit. Add test.use({ serviceWorkers: "block" })" |
| `e2e/route-guard.spec.ts`                              | `target.route = refuse` removed                         | failed: did not throw                                                                                                                                                                                    |
| `e2e/route-guard.spec.ts`                              | the `context.on("page", ...)` listener removed          | failed: did not throw (the `page` fixture arrives through that event)                                                                                                                                    |
| `e2e/route-guard.spec.ts`                              | the guard refuses even with `serviceWorkers: "block"`   | failed: the blocked route threw                                                                                                                                                                          |
| `e2e/route-guard.spec.ts`                              | `routeFromHAR` left unguarded                           | failed: did not throw                                                                                                                                                                                    |
| `.oxlintrc.json` `no-restricted-imports`               | a spec importing `test` from `@playwright/test`         | lint exit 1 naming the file                                                                                                                                                                              |
| `tests/workflows.test.ts`                              | `checks.yml` image tag moved to v1.64.1                 | failed: "runs in Playwright's v1.64.1 image, but the installed @playwright/test is 1.65.0"                                                                                                               |
| `tests/workflows.test.ts`                              | `checks.yml` image digest removed                       | failed: "not Playwright's noble image pinned to a sha256 digest"                                                                                                                                         |
| `tests/workflows.test.ts`                              | the version comparison skipped                          | failed: the mismatch case                                                                                                                                                                                |
| `tests/workflows.test.ts`                              | `image` lines not read                                  | failed: three image cases                                                                                                                                                                                |
| `tests/workflows.test.ts`                              | a one-line `container:` accepted                        | failed: the one-line case                                                                                                                                                                                |

Python red runs went through `python3 .agents/tools/mutate-py.py --batch ... --baseline` on
`.agents/tools/check_all.py`, with `tests/check_all_test.py` filtered to the WebKit, container,
probe and docker tests. The baseline passed. Each mutant failed:

| Mutation                                      | Failing test                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| WebKit always runs on the host                | `test_docker_runs_the_container_as_this_user_when_podman_is_absent`                  |
| no refusal without a container runtime        | `test_webkit_that_cannot_start_and_no_container_runtime_refuse_before_anything_runs` |
| lock descriptors passed to the runtime        | `test_webkit_that_cannot_start_here_runs_in_playwrights_container_and_chromium_here` |
| a stop does not remove the container          | `test_a_check_timeout_removes_the_container_before_the_locks_free`                   |
| a finished step does not remove the container | `test_docker_runs_the_container_as_this_user_when_podman_is_absent`                  |
| the launch error keeps its prefix             | `test_webkit_that_cannot_start_and_no_container_runtime_refuse_before_anything_runs` |
| a hung launch check raises                    | `test_a_launch_that_hangs_counts_as_a_failure`                                       |
| a crashed launch check reads as a start       | `test_a_check_that_crashes_counts_as_a_failure_with_its_error`                       |
| podman and docker user flags swapped          | `test_docker_runs_the_container_as_this_user_when_podman_is_absent`                  |
| `E2E_PORT` not passed into the container      | `test_webkit_that_cannot_start_here_runs_in_playwrights_container_and_chromium_here` |
| podman `--timeout` left out                   | `test_webkit_that_cannot_start_here_runs_in_playwrights_container_and_chromium_here` |
| a step's result not logged when it ends       | `test_webkit_that_cannot_start_here_runs_in_playwrights_container_and_chromium_here` |

The timeout test first failed on the real code: a container that outlives its client holds the
output pipe, so check-all waited on it. The timeout path now removes the container itself.

## Checks

| Check                                                                      | Code state                                  | Result                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.agents/tools/linux-heavy-lock.sh .agents/tools/check-all --keep-going` | `90ae14ad`                                  | All 8 rows passed in 15m54s after 26 minutes in the machine lock queue: 229 files and 4197 Vitest tests, 911 modules built, e2e:chromium 144 tests in 4m55s, e2e:webkit (podman) 144 tests with 3 skipped in 4m28s, 52 Python files |
| `tests/check_all_test.py`                                                  | `6201c19e`                                  | 109 tests passed                                                                                                                                                                                                                    |
| `.agents/tools/check-all --only typecheck,lint,ruff,build`                 | `6201c19e`                                  | All 4 passed, which runs the per-step reporting on real checks; the split e2e path at this commit ran only against the fakes                                                                                                        |
| `tests/workflows.test.ts`                                                  | `b2019b12`                                  | 14 tests passed                                                                                                                                                                                                                     |
| The Browser smoke job's steps in the pinned image, Chromium                | `92bc2465` with `b2019b12`'s workflow files | Runtime-exercised: 144 passed in 5.1 minutes                                                                                                                                                                                        |
| The same, WebKit                                                           | same                                        | Runtime-exercised: 141 passed and 3 skipped in 4.6 minutes                                                                                                                                                                          |

The job simulation ran a fresh clone in the digest-pinned image as user 1001, Podman's
`--userns=keep-id:uid=1001,gid=1001` standing in for the runner's user, with `HOME` and `CI=true`
set. It installed Node v24.22.2 from the `.tar.gz` build onto the front of PATH, as setup-node
does (the image has no `xz` and ships Node v26.13.1). `npm ci` took 3 to 4 seconds with a warm
cache and built no native module: esbuild comes from its prebuilt package, and the lockfile has no
other install script for Linux. The Chromium project's `channel: "chromium"` full build is in the
image at `/ms-playwright/chromium-1254`.

The 3 WebKit skips are the worker badge and back-forward cache tests WebKit already skipped.

## Not done

- A real GitHub run of the new job. It cannot run from an unpushed branch. Only that run shows
  the image pull time on a hosted runner, setup-node's cache inside a container job, checkout as
  user 1001 under `/__w`, and the two jobs' wall time.
- Docker as check-all's container runtime ran only against a fake in the tests. This host's runs
  used Podman.
