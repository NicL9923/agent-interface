# November 12 every suite passes on the Mac mini at main

Branch `t3/mac-test-failures` from `origin/main` at `df2c1a9`, on the Mac mini (macOS 27.0, arm64, 12 cores), Node 24.22.2
from `/Volumes/DevSSD/caches/node-runtimes` (Homebrew's 24.21.0 and 26.10.0 are outside `engines`), Xcode 27.2 (27B52),
iPhone 17 simulator on iOS 27.0. Source fingerprint `sha256:44cfde734f45c62e55968e62eebedcd44edd3db320d445208f691e843fb3515f`
(1795 files), `ios` `sha256:9f2db73dc97262efc9b202c2115a33fff2233365c1445ecbac0d8bc0d416d456` (345 files). Only tests, a test
helper and README changed. No product code changed.

## Counts

| Suite | `origin/main` | This branch |
| --- | --- | --- |
| Vitest | 3878 passed, 5 failed | 3880 passed, 3 failed: the three that need `127.0.0.2`, each failing with the fix to run |
| iOS, full scheme | 912 passed, 10 failed, 29 skipped | 921 passed, 0 failed, 29 skipped, 1 expected failure |
| Build, Playwright e2e (55), typecheck, lint, ruff | e2e could not run: no Chromium | all pass |

The three Vitest failures go once lo0 has `127.0.0.2` (README, "Validate"). Linux has the whole of `127.0.0.0/8`, so CI runs them.
Python tests were skipped by `check-all`: no Python changed.

## Vitest

| Test | Cause | Fix |
| --- | --- | --- |
| `direct-routes` LAN before tailnet; closes a listener whose address went away. `native-contract` | listen on `127.0.0.2`, which macOS lacks; the server logs EADDRNOTAVAIL and skips the route, so the tests saw a missing route | machine setup, plus `tests/helpers/loopback.ts`: the three tests first prove the address is local, or fail naming the `ifconfig` command |
| `static-cache` "counts a hashed name there" | `realRoot()` never resolved its temp path. macOS's `/var` is a link to `/private/var`, and `isPreviousAsset` compares against the real path, which is what `previousAssetFile` hands `@fastify/static` in production | `realRoot()` returns `realpathSync` of the temp directory |
| `live-turn-timing` | `advanceTimersByTimeAsync(5)` fires a timer mid-step and runs on to the step's end before the loopback socket delivers. Whether a frame sent at 60 ms was stamped 61 or 65 was a race; and a change notice's read could reach Hermes a step late on a loaded machine | the clock moves one timer at a time, settling after each, and settling counts 20 event-loop turns besides its real millisecond. The figures are now exact: `?inflight=2` 100, 440, 740 ms (were 105, 445, 745), `?inflight=3` 60, 0, 0 (was 61) |

Red runs for `live-turn-timing`, 24 busy loops on 12 cores (load average 47 to 58):

- `origin/main`: 1 of 5 failed alone and idle (65 for 61). It failed in the full suite as `[61, 5, 5]`.
- One timer at a time without counting turns: 10 of 10 passed idle, but 1 of 10 and 2 of 12 failed loaded (105 for 100). A trace
  showed the client's read issuing its Hermes open 5 ms late.
- Whole-step advance restored with the new figures: fails at once (105, 445, 745).
- Final: 5 of 5 idle and 20 of 20 loaded.

The loopback guard's rejection was shown on this Mac before any alias: all three tests fail with
`This machine cannot listen on 127.0.0.2 (EADDRNOTAVAIL)`. The `static-cache` fix's red run is `origin/main` on macOS.

## iOS UI tests

Seven failed because the test still asserted the screen before an intended change. Three were test races.

| Test | Cause | Fix |
| --- | --- | --- |
| `ParityFlowTests.testComputerRowReportsWhoHasControlAndDisablesWhenUnavailable` | #270 keeps the row open while the terminal works | covers desktop up; desktop down and terminal up; both down |
| `ParityFlowTests.testNotificationPromptAsks...` | 51615f11 changed the caption to On, Off or Blocked | waits for Off |
| `ParityFlowTests.testTodayAndTabletLayout`, `DailyFlowTests.testHomePushes...` | 8d8f8225 hides "Needs your attention" when nothing needs it; the fixture assistant is done | wait for "Since you were away"; the Today test asserts the empty section stays hidden |
| `NativeFlowTests.testNativeFailedUpdateOffersGuardedRecovery` | ead64046 made the failed fixture's check "Restart and verify Hermes" | looks for it |
| `ParityFlowTests.testAssistantCatalogAndUnsavedChangesAreProtected` | #254 opens settings on its sections | goes to Profile for the name, Behavior for the model |
| `DiscoveryFlowTests.testSearchSavedItems...` | a2c01988 copy ("· Saved", "30-day usage"); and "Save conversation" scrolled under the floating history toolbar (frames: button y 84 to 158, Back to results y 124 to 158) still reports hittable, so the tap closed the page | new copy; scrolls until the button clears the toolbar |
| `NativeFlowTests.testNativeUpgradeQualification...` | since 8e5ff078 the error row with Refresh sits below the fold of a lazy form | swipes until it exists |
| `TranscriptFlowTests.testQuestionOptionsAdvance...` | the note field (y 719 to 761) was under the decisions bar over the message box (y 736) | `revealAboveComposer` before typing |
| `VaultFlowTests.testSecureRequestsAdvance...` | 1 of 4: after a cancelled request the next field jumps for a frame (traced 464, 388, 464) and one tap lands beside it | `typeWhenFocused` waits for a stable frame before its one tap |

Hand-break runs, each restored after: with the Computer row disabled whenever the desktop is down, the computer test fails at
"desktop down true, terminal down false"; with the Today attention section always shown, the Today test fails; with the caption
"Disabled" again, the notification test fails at its Off wait.

The Vault race: 1 of 4 failed before the fix (and once in each full run on main); 4 of 4 Transcript and 6 of 6 Vault iterations
passed with the trace in place, then 0 failures in the full run.

## Not exercised

Real Hermes, push delivery and a physical phone. The three `127.0.0.2` tests did not pass on this Mac: the alias needs sudo,
which was not given in this session.

## Today's wait tests on CI

GitHub's Node 26.13.0 job failed once at `d15b2ec4` on a file this branch does not touch:
`tests/experience-api.test.ts` > "an assistant whose read outlasts TODAY_WAIT_MS" > "is answered without, as unchecked,
and the next Today takes its read instead of reading again", timed out after 15 s. Its helper started a Today read and
moved the fake clock by `TODAY_WAIT_MS` at once. The route sets that wait only after sign-in, the roster and the event
page, which take real I/O, so a clock moved first passes before the wait exists and the read waits forever. The
installed-iOS case had the reverse fault: moving the clock early could let it pass without the wait ever being tested.

The helper now moves the clock only once the route has asked for `ranch`, which it does after setting its wait
(`src/server/experience.ts`, the `deadline` before `check`), or once the read has answered without asking. Linux,
NicolasLaptop: 20 of 20 tests passed in each of three runs, and in 12 of 12 runs with 12 busy loops and four runs at
once. The old helper also passed 12 of 12 under that load, so the CI failure was not reproduced; the fix removes the
ordering assumption rather than shortening its odds.

Red runs, by hand on `src/server/experience.ts`, restored after each:

| Mutation | Result |
| --- | --- |
| the wait is set without `pending=1` | failed: waits for every assistant when the client does not ask for pending answers, as an installed iOS build |
| the wait is never set | failed: the three `pending=1` cases, each timing out |
