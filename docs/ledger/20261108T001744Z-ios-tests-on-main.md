# November 8 iOS tests that failed on main

Branch `fix/ios-tests-on-main`, code state `5d680e9b` on main `a3dfff61`, on the Mac mini with
Xcode 27.2 (27B52) and an iPhone 17 simulator on iOS 27.0
(`0915E0B2-A1A0-43FC-9A9A-35DF02CAF0F0`), through `.agents/tools/validate-ios.sh` with its
own derived data. The subsequent ledger-only commit does not change these inputs. No live
Hermes, app server or physical phone was used. Summaries are in the worktree's `.private/`.

## Reproduced on main `a3dfff61`

`ios-test-20261107T233615Z-61353`: 4 tests, 4 failed.

- `DirectRouteTests.testAServerWithoutRoutesForgetsTheOnesItAdvertisedBefore` and
  `testUsesTheNextRouteWhenTheBestDoesNotAnswer`: no route became active. Both discarded the
  primary `FakeServer` that `installation()` returns, and `FakeExchange` holds hosts weakly,
  so the route list request found no host. The class now holds its servers until tearDown.
  `testAProbeThatAnswersWithoutTheSignedInApiDoesNotCount` and
  `testANetworkChangeLeavesTheRouteAndForgetsRestingRoutes` discarded it too and passed only
  because the route list never arrived; they now read it and still pass.
- `NativeContractTests.testTheObservedListNamesEveryTrackedProperty`: the store tracks
  `sendingRequests`, and `sending` has been computed from it since #259. The list now names
  `sendingRequests`.
- `ExperienceFlowTests.testRoutineResultsAndGroupCreationMessaging`: the group creation switch
  was labelled `Ranch hand: Ready, Ranch hand`. Since c3a57ea the toggle's label holds an
  avatar marked `accessibilityHidden`, whose own label still joined the toggle's on iOS 27,
  so VoiceOver read each assistant's name twice with its status. `GroupCreateView` now labels
  each toggle with the assistant's name. This failure is recorded since November 1.

## Lines broken by hand

Each mutant was applied to `ios/AgentInterface/DirectRoutes.swift` with the fixed tests, run,
and restored with no diff left.

- Choosing the best route without the `answered` filter:
  `testUsesTheNextRouteWhenTheBestDoesNotAnswer` failed, choosing the LAN route that did not
  answer; the other passed (`ios-test-20261107T235744Z-72605`).
- Keeping the old routes when the route list answers 404:
  `testAServerWithoutRoutesForgetsTheOnesItAdvertisedBefore` failed with the LAN route kept;
  the other passed (`ios-test-20261107T235826Z-72995`).
- The observed list naming `sending` and the toggle without its own label are the main state
  above, red there.

## Race found in the class run

The first class run on `5bb795b3` (`ios-test-20261108T000430Z-76466`) passed 163 of 164:
`testAReadThatFailsOnTheRouteIsSentOnThePrimaryOriginAndTheRouteRests` saw the primary's last
request was `/api/native/routes`. The failed read starts a route check whose route list
request races the read sent again on the primary origin. Repeated 100 times it failed 69
(`ios-test-20261108T000907Z-78464`). The test now waits for that check and counts the reads
the primary received: 100 of 100 passed (`ios-test-20261108T001045Z-79177`).

## Results on `5d680e9b`

- The four tests: 4 passed (`ios-test-20261108T001115Z-79572`).
- `DirectRouteTests` (20), `NativeContractTests` (136) and `ExperienceFlowTests` (8):
  164 passed, none failed or skipped (`ios-test-20261108T001235Z-80389`).
- `DirectRouteTests` repeated 20 times: 400 runs passed (`ios-test-20261108T001631Z-81931`).

Not run: the rest of the unit and UI test targets, and other simulators or iOS versions. The
toggle label was checked through the UI test's accessibility query, not with VoiceOver.
