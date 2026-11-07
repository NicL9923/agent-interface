# November 7 iOS tests failing on main

Base `a3dfff6` plus this branch's three-file diff. Mac mini, Xcode 27.2 (27B52), iPhone 17
simulator `0915E0B2-A1A0-43FC-9A9A-35DF02CAF0F0` on iOS 27.0, through
`.agents/tools/validate-ios.sh` with derived data on DevSSD. No live Hermes, physical phone or
VoiceOver session was used.

Causes:

- `DirectRouteTests`: `FakeExchange` holds its hosts weakly. Tests that drop the primary
  `FakeServer` (`let (_, api, _) = installation(...)`) or stop naming a route host let it be freed
  before its request, which then fails with `.badURL`. #263's ledger entry shows these tests
  compiled but never ran. The class now keeps every host until `tearDown`. With live hosts,
  `testAReadThatFailsOnTheRouteIsSentOnThePrimaryOriginAndTheRouteRests` raced the route check
  that a failed route forces, so it now awaits that check and asserts the read reached the
  primary origin, not that it was the primary's last request.
- `NativeContractTests.testTheObservedListNamesEveryTrackedProperty`: `sending` became a computed
  property over the stored `sendingRequests` in #259. `observedForTests` now lists `sendingRequests`.
- `ExperienceFlowTests.testRoutineResultsAndGroupCreationMessaging`: the group sheet's switch was
  labelled "Ranch hand: Ready, Ranch hand". The avatar's own accessibility label reached the
  Toggle despite `.accessibilityHidden(true)`. The Toggle now carries `.accessibilityLabel(bot.name)`,
  which is an app change. The test is unchanged.

Runs:

- Before, on clean `a3dfff6`: the same four tests failed as reported (3 of 156 unit tests in
  `DirectRouteTests` and `NativeContractTests`, and the UI test at line 157).
- After: `-only-testing:AgentInterfaceTests -only-testing:AgentInterfaceUITests/ExperienceFlowTests`
  passed 617 tests, skipped 2 and failed none (611 unit, 8 `ExperienceFlowTests`).
- Mutants, applied by hand to `DirectRoutes.swift` and confirmed red, then restored: keeping stale
  routes when the server answers 404 fails `testAServerWithoutRoutesForgetsTheOnesItAdvertisedBefore`.
  Considering only the first advertised route fails `testUsesTheNextRouteWhenTheBestDoesNotAnswer`
  and `testPrefersTheLanRouteThatAnswersAndSendsTheSignedInApiThere`.
- The app-side label fix is covered by the UI test, which failed without it in the run above.

Not exercised: the rest of the UI test target, VoiceOver itself, a physical phone.
