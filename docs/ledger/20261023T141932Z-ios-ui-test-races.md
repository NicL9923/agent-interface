# October 23 native UI test races and crash-report wait

This entry covers the #186 fixes on branch `t3/761beee4`, commit `f100e68` on main
`305364e`. Claude Opus 5.5 implemented the change. The native source fingerprint,
`python3 .agents/tools/source-state.py ios/`, is
`sha256:bc843fec1050b062bb93a7dbb156c7590d4d8be8e7315847f7f8c4b9a9070f00` over 217
files. With the runner added, `source-state.py ios/ .agents/tools/validate-ios.sh
.agents/tools/patch-xctestrun.py` gives
`sha256:43e72ddedc8ac84260d60385cbacb1cb8b3e1ac01052bfff995db99dc96b1dce` over 219
files.

All runs used the Mac mini with Xcode 27.1 (27A9275) on an iPhone 17 simulator
running iOS 27.0. `validate-ios.sh` held `.private/ios-validation.lock`, ran
`build-for-testing`, then ran `test-without-building` from an xctestrun copy with a
15-second crash-report wait and without failure-time diagnostics.

## Causes

- `NativeFlowTests.testOnboardingValidatesAddressWithoutDroppingEnteredText` tapped
  Continue from a stale frame. While `typeText` types, it hides the software
  keyboard, and the keyboard comes back as typing ends. The layout then moves up
  about 110 points, and the tap landed where the button had been. The failure
  hierarchy had no error banner, and the recording shows the keyboard leaving and
  returning. The app behaved correctly.
- `AutomationFlowTests.testAdvancedRoutineSavesScriptAndKeepsInheritedModel`
  revealed the switch row. A 4-point sliver of the row showed below the sheet's
  navigation bar, so the row counted as hittable while its UISwitch stayed
  covered. The app behaved correctly.

## Application tests

- On unchanged main code, onboarding failed its run, and the routine test failed
  on the second iteration of a run-until-failure loop. A first attempt that waited
  for the keyboard before typing still failed onboarding 6 of 6.
- After the fix, at the runner fingerprint above, each test passed 6 of 6 runs.
- The full scheme at `f100e68` passed: 391 unit tests with 2 evidence-only skips,
  and 63 UI tests with 2 skips (`ScreenshotTourTests` and the iPad-only
  `TabletPresentationTests`), in 28 minutes for the UI suite.
- `npm run test:py -- tests/patch_xctestrun_test.py` and ruff passed.

Not exercised: `LiveConnectionTests` against a real Hermes, physical phones and
APNs delivery.
